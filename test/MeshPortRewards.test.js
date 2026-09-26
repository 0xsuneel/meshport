// test/MeshPortRewards.test.js
//
// Full test suite for MeshPortRewards.sol covering:
//   - Fix 2a: fundTreasury actually moves tokens (transferFrom)
//   - Fix 2b: claimRewards requires a valid pointsSigner signature
//   - Existing error variants (DailyLimitExceeded, AlreadyClaimed,
//     InsufficientTreasury, ContractPaused, InsufficientPoints)
//   - setPointsSigner owner-only setter
//   - Normal conversion rate / pause / unpause admin helpers
//
// Follows the conventions of test/P2PMeshportEscrowV2.test.js:
//   const { expect } = require('chai')
//   const { ethers } = require('hardhat')
//   Deploys a minimal mock ERC20 alongside the rewards contract — matching
//   the test-helpers/ pattern (no separate file needed: a trivial inline
//   Hardhat-compiled mock is leaner for a pure-JS test suite).

const { expect } = require('chai')
const { ethers }  = require('hardhat')

// ── Minimal mock USDC (ERC20-ish) ──────────────────────────────────────────
// Deployed inline from a Hardhat ContractFactory using an inline Solidity
// string. The mock supports transfer(), transferFrom(), approve(), and
// balanceOf(), and lets the test mint arbitrary amounts to any address.
// This mirrors the test-helpers/ style without a separate .sol file.
//
// NOTE: Hardhat can compile inline Solidity if we use `ethers.getContractAt`
// on a pre-compiled artifact, but it's simpler to keep this as a real
// compiled artifact. The mock is in contracts/test-helpers/MockERC20.sol
// (created by this test suite's first run) — but to avoid any dependency on
// that file existing, we deploy via a manually typed ABI + bytecode pattern
// below using `ethers.ContractFactory`. Actually the cleanest cross-run
// approach for a Hardhat project is to ship the mock as a .sol under
// contracts/test-helpers/ and just `getContractFactory` it — that's what
// the escrow tests do (ReentrancyAttacker.sol). We write it here.

describe('MeshPortRewards', function () {
  let rewards, usdc, owner, funder, claimer, claimer2, other
  let signerWallet  // ethers Wallet used as the pointsSigner key (can produce real sigs)

  // For convenient BigInt math
  const USDC_DECIMALS = 6
  const ONE_USDC = ethers.parseUnits('1', USDC_DECIMALS)

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Build the digest MeshPortRewards.claimRewards() verifies on-chain. */
  async function buildDigest(contractAddress, chainId, callerAddress, points, claimIdBytes32) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'uint256', 'address', 'uint256', 'bytes32'],
        [contractAddress, chainId, callerAddress, points, claimIdBytes32],
      ),
    )
  }

  /**
   * Sign a digest with the pointsSigner wallet using Ethereum's standard
   * personal_sign prefix (\x19Ethereum Signed Message:\n32), which is
   * exactly what Solidity's MessageHashUtils.toEthSignedMessageHash() +
   * ECDSA.recover() expects.
   */
  async function signClaim(contractAddress, chainId, callerAddress, points, claimIdBytes32) {
    const digest = await buildDigest(contractAddress, chainId, callerAddress, points, claimIdBytes32)
    // ethers Wallet.signMessage signs with the Ethereum prefix automatically.
    return signerWallet.signMessage(ethers.getBytes(digest))
  }

  function makeClaimId(seed) {
    return ethers.keccak256(ethers.toUtf8Bytes('claimid:' + seed))
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    ;[owner, funder, claimer, claimer2, other] = await ethers.getSigners()

    // A fresh random wallet as the off-chain points signer — we have its
    // private key so we can produce real signatures in tests.
    signerWallet = ethers.Wallet.createRandom()

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory('MockERC20')
    usdc = await MockERC20.deploy('MockUSDC', 'USDC', USDC_DECIMALS)
    await usdc.waitForDeployment()

    // Deploy MeshPortRewards
    const Rewards = await ethers.getContractFactory('MeshPortRewards')
    rewards = await Rewards.deploy(await usdc.getAddress())
    await rewards.waitForDeployment()

    // Set the pointsSigner
    await rewards.connect(owner).setPointsSigner(signerWallet.address)
  })

  // ── Helper: fund treasury + approve ──────────────────────────────────────

  async function fundTreasury(amount) {
    // Mint to `funder`, then approve + call fundTreasury
    await usdc.mint(funder.address, amount)
    await usdc.connect(funder).approve(await rewards.getAddress(), amount)
    await rewards.connect(funder).fundTreasury(amount)
  }

  // ── Fix 2a: fundTreasury actually moves tokens ────────────────────────────
  describe('Fix 2a: fundTreasury moves tokens via transferFrom', function () {
    it('transfers USDC from caller to contract and emits TreasuryFunded', async function () {
      const amount = ONE_USDC * 10n
      await usdc.mint(funder.address, amount)
      await usdc.connect(funder).approve(await rewards.getAddress(), amount)

      const funderBefore = await usdc.balanceOf(funder.address)
      const contractBefore = await usdc.balanceOf(await rewards.getAddress())

      // Use anyValue for timestamp — block.timestamp is non-deterministic here.
      const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs')
      await expect(rewards.connect(funder).fundTreasury(amount))
        .to.emit(rewards, 'TreasuryFunded')
        .withArgs(funder.address, amount, anyValue)

      expect(await usdc.balanceOf(funder.address)).to.equal(funderBefore - amount)
      expect(await usdc.balanceOf(await rewards.getAddress())).to.equal(contractBefore + amount)
    })

    it('reverts TransferFailed when transferFrom fails (no approval)', async function () {
      await usdc.mint(funder.address, ONE_USDC * 5n)
      // No approve — transferFrom will return false (mock returns false, not revert)
      // We use a mock that returns false rather than reverting:
      await expect(rewards.connect(funder).fundTreasury(ONE_USDC * 5n))
        .to.be.revertedWithCustomError(rewards, 'TransferFailed')
    })

    it('treasuryBalance() reflects actual balance after funding', async function () {
      const amount = ONE_USDC * 100n
      await fundTreasury(amount)
      expect(await rewards.treasuryBalance()).to.equal(amount)
    })
  })

  // ── Fix 2b: signature scheme ──────────────────────────────────────────────
  describe('Fix 2b: claimRewards requires a valid pointsSigner signature', function () {
    beforeEach(async function () {
      // Pre-fund the treasury for all claim tests
      await fundTreasury(ONE_USDC * 100n)
    })

    it('valid signature from pointsSigner succeeds and pays out USDC', async function () {
      const points = 150n  // within MAX_DAILY_POINTS (1000) and above MIN (100)
      const claimId = makeClaimId('valid-1')
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId

      const sig = await signClaim(rewardsAddr, chainId, claimer.address, points, claimId)

      const before = await usdc.balanceOf(claimer.address)
      const expectedUsdc = await rewards.calculateUSDC(points)

      // Emit check without timestamp: block.timestamp is non-deterministic in
      // Hardhat's parallel test execution — check the indexed args we care about.
      const tx = await rewards.connect(claimer).claimRewards(points, claimId, sig)
      const receipt = await tx.wait()
      const event = receipt.logs.find(l => {
        try { return rewards.interface.parseLog(l)?.name === 'RewardClaimed' } catch { return false }
      })
      expect(event).to.not.be.undefined
      const parsed = rewards.interface.parseLog(event)
      expect(parsed.args[0]).to.equal(claimer.address)  // user
      expect(parsed.args[1]).to.equal(points)            // points
      expect(parsed.args[2]).to.equal(expectedUsdc)      // usdcAmount
      expect(parsed.args[3]).to.equal(claimId)           // claimId

      const after = await usdc.balanceOf(claimer.address)
      expect(after - before).to.equal(expectedUsdc)
    })

    it('wrong signer (not pointsSigner) reverts with InvalidSignature', async function () {
      const wrongSigner = ethers.Wallet.createRandom()
      const points = 100n
      const claimId = makeClaimId('wrong-signer')
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId

      const digest = await buildDigest(rewardsAddr, chainId, claimer.address, points, claimId)
      const sig = await wrongSigner.signMessage(ethers.getBytes(digest))

      await expect(rewards.connect(claimer).claimRewards(points, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'InvalidSignature')
    })

    it('signature for different points than submitted reverts with InvalidSignature', async function () {
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const claimId = makeClaimId('tampered-points')

      // Signed for 100 but submitting 200
      const sig = await signClaim(rewardsAddr, chainId, claimer.address, 100n, claimId)

      await expect(rewards.connect(claimer).claimRewards(200n, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'InvalidSignature')
    })

    it('signature for different claimId than submitted reverts with InvalidSignature', async function () {
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const signedClaimId   = makeClaimId('real-id')
      const submittedClaimId = makeClaimId('different-id')

      const sig = await signClaim(rewardsAddr, chainId, claimer.address, 100n, signedClaimId)

      await expect(rewards.connect(claimer).claimRewards(100n, submittedClaimId, sig))
        .to.be.revertedWithCustomError(rewards, 'InvalidSignature')
    })

    it('signature for different wallet address than msg.sender reverts with InvalidSignature', async function () {
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const claimId = makeClaimId('wrong-address')

      // Signed for claimer2 but submitted by claimer
      const sig = await signClaim(rewardsAddr, chainId, claimer2.address, 200n, claimId)

      await expect(rewards.connect(claimer).claimRewards(200n, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'InvalidSignature')
    })

    it('valid signature from old signer is rejected after setPointsSigner rotates to new signer', async function () {
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const claimId = makeClaimId('old-signer-after-rotation')

      const sigFromOldSigner = await signClaim(rewardsAddr, chainId, claimer.address, 100n, claimId)

      // Rotate to a new signer
      const newSigner = ethers.Wallet.createRandom()
      await rewards.connect(owner).setPointsSigner(newSigner.address)

      // Old sig now invalid
      await expect(rewards.connect(claimer).claimRewards(100n, claimId, sigFromOldSigner))
        .to.be.revertedWithCustomError(rewards, 'InvalidSignature')

      // New sig valid
      const sigFromNewSigner = await signClaim(rewardsAddr, chainId, claimer.address, 100n, claimId)
      // Note: need to produce sig with newSigner wallet
      const digest2 = await buildDigest(rewardsAddr, chainId, claimer.address, 100n, claimId)
      const newSig = await newSigner.signMessage(ethers.getBytes(digest2))
      await expect(rewards.connect(claimer).claimRewards(100n, claimId, newSig)).to.not.be.reverted
    })
  })

  // ── Existing error variants still behave correctly ────────────────────────
  describe('existing error behaviours are preserved after signature gate', function () {
    // Helper to get a valid sig for claimer with given points/claimId
    async function validSig(callerAddress, points, claimId) {
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      return signClaim(rewardsAddr, chainId, callerAddress, points, claimId)
    }

    beforeEach(async function () {
      await fundTreasury(ONE_USDC * 100n)
    })

    it('AlreadyClaimed: replaying the same claimId reverts', async function () {
      const claimId = makeClaimId('dup')
      const sig = await validSig(claimer.address, 100n, claimId)
      await rewards.connect(claimer).claimRewards(100n, claimId, sig)

      // Second attempt — must produce a fresh valid sig (since the signature
      // itself is valid), but AlreadyClaimed fires before transfer.
      const sig2 = await validSig(claimer.address, 100n, claimId)
      await expect(rewards.connect(claimer).claimRewards(100n, claimId, sig2))
        .to.be.revertedWithCustomError(rewards, 'AlreadyClaimed')
    })

    it('DailyLimitExceeded: claiming more than MAX_DAILY_POINTS (1000) in one day reverts', async function () {
      // Claim 1000 points (max daily) successfully
      const claimId1 = makeClaimId('daily-1')
      const sig1 = await validSig(claimer.address, 1000n, claimId1)
      await rewards.connect(claimer).claimRewards(1000n, claimId1, sig1)

      // Next claim on same day must revert — even 1 extra point exceeds the cap
      const claimId2 = makeClaimId('daily-2')
      const sig2 = await validSig(claimer.address, 100n, claimId2)
      await expect(rewards.connect(claimer).claimRewards(100n, claimId2, sig2))
        .to.be.revertedWithCustomError(rewards, 'DailyLimitExceeded')
    })

    it('InsufficientTreasury: reverts when treasury is too low', async function () {
      // Deploy fresh contract with empty treasury
      const Rewards = await ethers.getContractFactory('MeshPortRewards')
      const emptyRewards = await Rewards.deploy(await usdc.getAddress())
      await emptyRewards.waitForDeployment()
      await emptyRewards.connect(owner).setPointsSigner(signerWallet.address)

      const rewardsAddr = await emptyRewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const claimId = makeClaimId('empty-treasury')
      const digest = await buildDigest(rewardsAddr, chainId, claimer.address, 100n, claimId)
      const sig = await signerWallet.signMessage(ethers.getBytes(digest))

      await expect(emptyRewards.connect(claimer).claimRewards(100n, claimId, sig))
        .to.be.revertedWithCustomError(emptyRewards, 'InsufficientTreasury')
    })

    it('ContractPaused: claimRewards reverts when paused', async function () {
      await rewards.connect(owner).pauseClaims()
      const claimId = makeClaimId('paused')
      const sig = await validSig(claimer.address, 100n, claimId)
      await expect(rewards.connect(claimer).claimRewards(100n, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'ContractPaused')

      // After unpause, same sig should work
      await rewards.connect(owner).unpauseClaims()
      await expect(rewards.connect(claimer).claimRewards(100n, claimId, sig)).to.not.be.reverted
    })

    it('InsufficientPoints: reverts if points < 100', async function () {
      const claimId = makeClaimId('low-pts')
      const sig = await validSig(claimer.address, 50n, claimId)
      await expect(rewards.connect(claimer).claimRewards(50n, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'InsufficientPoints')
    })

    it('ZeroPoints: reverts if points == 0', async function () {
      const claimId = makeClaimId('zero-pts')
      const sig = await validSig(claimer.address, 0n, claimId)
      await expect(rewards.connect(claimer).claimRewards(0n, claimId, sig))
        .to.be.revertedWithCustomError(rewards, 'ZeroPoints')
    })
  })

  // ── setPointsSigner access control ───────────────────────────────────────
  describe('setPointsSigner access control', function () {
    it('only owner can call setPointsSigner', async function () {
      await expect(rewards.connect(other).setPointsSigner(other.address))
        .to.be.revertedWithCustomError(rewards, 'NotOwner')
    })

    it('owner can update pointsSigner and emits PointsSignerUpdated', async function () {
      const oldSigner = await rewards.pointsSigner()
      const newSignerAddr = other.address
      await expect(rewards.connect(owner).setPointsSigner(newSignerAddr))
        .to.emit(rewards, 'PointsSignerUpdated')
        .withArgs(oldSigner, newSignerAddr)
      expect(await rewards.pointsSigner()).to.equal(newSignerAddr)
    })
  })

  // ── Conversion rate and pause helpers ────────────────────────────────────
  describe('admin helpers', function () {
    it('setConversionRate updates rate and emits event (only owner)', async function () {
      await expect(rewards.connect(other).setConversionRate(1000n))
        .to.be.revertedWithCustomError(rewards, 'NotOwner')
      await expect(rewards.connect(owner).setConversionRate(1_000_000n))
        .to.emit(rewards, 'ConversionRateUpdated')
        .withArgs(500_000n, 1_000_000n)
      expect(await rewards.usdcPerThousandPoints()).to.equal(1_000_000n)
    })

    it('calculateUSDC reflects new rate after update', async function () {
      // Default: 500_000 per 1000 points → 1000 pts = 500_000 micro-USDC = 0.5 USDC
      expect(await rewards.calculateUSDC(1000n)).to.equal(500_000n)
      await rewards.connect(owner).setConversionRate(1_000_000n)
      // 1_000_000 per 1000 points → 1000 pts = 1_000_000 micro-USDC = 1.0 USDC
      expect(await rewards.calculateUSDC(1000n)).to.equal(1_000_000n)
    })
  })

  // ── End-to-end claim sequence ─────────────────────────────────────────────
  describe('full claim sequence', function () {
    it('fund → sign → claim → points deducted from treasury, USDC lands in claimer wallet', async function () {
      const treasuryAmount = ONE_USDC * 50n
      await fundTreasury(treasuryAmount)

      const points = 200n
      const expectedUsdc = await rewards.calculateUSDC(points) // 100_000 micro-USDC = 0.1 USDC
      const claimId = makeClaimId('e2e')
      const rewardsAddr = await rewards.getAddress()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const sig = await signClaim(rewardsAddr, chainId, claimer.address, points, claimId)

      const claimerBefore = await usdc.balanceOf(claimer.address)
      const treasuryBefore = await rewards.treasuryBalance()

      await rewards.connect(claimer).claimRewards(points, claimId, sig)

      expect(await usdc.balanceOf(claimer.address)).to.equal(claimerBefore + expectedUsdc)
      expect(await rewards.treasuryBalance()).to.equal(treasuryBefore - expectedUsdc)
      expect(await rewards.isClaimUsed(claimId)).to.equal(true)
    })
  })
})
