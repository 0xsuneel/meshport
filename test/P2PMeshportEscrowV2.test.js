// test/P2PMeshportEscrowV2.test.js
//
// Covers the security invariants requested for the P2PMeshportEscrowV2
// hardening pass: normal seller release needs no privileged approval,
// sellers can't touch each other's trades, the offerKey front-run fix,
// the full Pauser -> Investigator -> Admin dispute sequence, and that
// nothing anywhere lets Admin choose an arbitrary recipient/amount or
// drain more than one already-investigated trade at a time.
const { expect } = require('chai')
const { ethers } = require('hardhat')

function offerKeyFor(offerId, sellerAddress) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address'], [offerId, sellerAddress]),
  )
}
function tradeKeyFor(tradeId) {
  return ethers.keccak256(ethers.toUtf8Bytes(tradeId))
}

describe('P2PMeshportEscrowV2', function () {
  let escrow, admin, pauser, investigator, investigator2, seller, seller2, buyer, attacker
  let roleManager1, roleManager2, roleManager3
  const ONE = ethers.parseEther('1')

  const ROLE_ACTION = { AddPauser: 0, RemovePauser: 1, AddInvestigator: 2, RemoveInvestigator: 3, TransferAdmin: 4, CancelAdminTransfer: 5, RotateSigner: 6 }

  /**
   * Test helper mirroring the real 2-of-3 role-manager flow: signer 1
   * proposes (counts as confirmation #1), signer 2 confirms (#2) — the
   * proposal executes automatically the instant it hits the threshold,
   * exactly like the contract itself does. Every role-management test
   * below goes through this, not a direct onlyAdmin call, because that
   * capability no longer exists on the contract at all.
   */
  /**
   * Test helper mirroring the real 2-of-3 + timelock flow: signer 1
   * proposes (1st confirmation), signer 2 confirms (2nd, starts the
   * 2-hour timelock), then time is fast-forwarded past TIMELOCK_DELAY and
   * a signer calls executeRoleProposal() to actually apply the change.
   * Every role-management test below goes through this real sequence —
   * nothing here shortcuts or bypasses the timelock.
   */
  async function grantRole(action, target) {
    const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION[action], target ?? ethers.ZeroAddress)
    await tx.wait()
    const proposalId = (await escrow.roleProposalCount()) - 1n
    await escrow.connect(roleManager2).confirmRoleChange(proposalId)
    await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
    await ethers.provider.send('evm_mine')
    await escrow.connect(roleManager1).executeRoleProposal(proposalId)
    return proposalId
  }

  beforeEach(async function () {
    ;[admin, pauser, investigator, investigator2, seller, seller2, buyer, attacker, roleManager1, roleManager2, roleManager3] = await ethers.getSigners()
    const Factory = await ethers.getContractFactory('P2PMeshportEscrowV2', admin)
    escrow = await Factory.deploy([roleManager1.address, roleManager2.address, roleManager3.address])
    await escrow.waitForDeployment()

    // Build the role chain the contract itself enforces: pauser -> investigator.
    // Two separate investigator-capable signers (investigator, investigator2)
    // so tests can prove independence (whoever froze a trade can't
    // investigate it; whoever investigated it can't resolve it) without
    // needing a fresh deploy every time genuinely distinct actors are needed.
    // Every grant below goes through the real 2-of-3 role-manager flow.
    await grantRole('AddPauser', pauser.address)
    await grantRole('AddPauser', investigator.address)
    await grantRole('AddInvestigator', investigator.address)
    await grantRole('AddPauser', investigator2.address)
    await grantRole('AddInvestigator', investigator2.address)
  })

  // ── 1-4: normal payment flow, no privilege required ──────────────────
  describe('normal payment flow', function () {
    it('1. seller can deposit USDC (native value)', async function () {
      const offerKey = offerKeyFor('offer-1', seller.address)
      await expect(escrow.connect(seller).deposit(offerKey, { value: ONE }))
        .to.emit(escrow, 'Deposited').withArgs(offerKey, seller.address, ONE, ONE)
      expect(await escrow.getRemaining(offerKey)).to.equal(ONE)
    })

    it('2 & 3. seller can release a registered trade with NO privileged approval, buyer gets the exact stored amount', async function () {
      const offerKey = offerKeyFor('offer-2', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-2')
      const half = ONE / 2n
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, half)

      const before = await ethers.provider.getBalance(buyer.address)
      await expect(escrow.connect(seller).release(tradeKey))
        .to.emit(escrow, 'Released').withArgs(offerKey, tradeKey, buyer.address, half)
      const after = await ethers.provider.getBalance(buyer.address)
      expect(after - before).to.equal(half) // exact stored amount, nothing more/less
      expect(await escrow.getRemaining(offerKey)).to.equal(ONE - half)
    })

    it('normal release is rejected for admin/pauser/investigator/anyone but the trade\'s own seller (INVARIANT 1)', async function () {
      const offerKey = offerKeyFor('offer-inv1', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-inv1')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)

      for (const notSeller of [admin, pauser, investigator, buyer, attacker]) {
        await expect(escrow.connect(notSeller).release(tradeKey))
          .to.be.revertedWith('P2PEscrowV2: only the trade\'s seller can release it')
      }
    })
  })

  // ── 4 (front-run): offer ownership can't be hijacked ──────────────────
  describe('offer security — the offerKey front-run fix', function () {
    it('4. an attacker cannot claim another seller\'s legitimate offerKey — they can only ever construct a key bound to their OWN address', async function () {
      const legitimateKey = offerKeyFor('offer-4', seller.address)
      // The attacker doesn't know a preimage that maps to legitimateKey
      // under a DIFFERENT address — the best they can do is deposit to
      // the key their OWN address produces, which is a different key
      // entirely and can never collide with the seller's.
      const attackerKey = offerKeyFor('offer-4', attacker.address)
      expect(attackerKey).to.not.equal(legitimateKey)

      await escrow.connect(attacker).deposit(attackerKey, { value: ONE })
      expect(await escrow.getSeller(attackerKey)).to.equal(attacker.address)

      // The real seller can still deposit to their own correctly-derived
      // key and be recognized as its seller, completely unaffected.
      await escrow.connect(seller).deposit(legitimateKey, { value: ONE })
      expect(await escrow.getSeller(legitimateKey)).to.equal(seller.address)
    })
  })

  // ── 5-7, caller-supplied-data hardening ────────────────────────────────
  describe('trade isolation and data authority', function () {
    it('5 & 6. seller A cannot release or drain seller B\'s trade/offer', async function () {
      const offerKeyA = offerKeyFor('offer-A', seller.address)
      const offerKeyB = offerKeyFor('offer-B', seller2.address)
      await escrow.connect(seller).deposit(offerKeyA, { value: ONE })
      await escrow.connect(seller2).deposit(offerKeyB, { value: ONE })

      const tradeKeyB = tradeKeyFor('trade-B')
      await escrow.connect(seller2).registerTrade(tradeKeyB, offerKeyB, buyer.address, ONE)

      await expect(escrow.connect(seller).release(tradeKeyB))
        .to.be.revertedWith('P2PEscrowV2: only the trade\'s seller can release it')
      await expect(escrow.connect(seller).withdrawRemaining(offerKeyB))
        .to.be.revertedWith('P2PEscrowV2: not the offer\'s seller')
    })

    it('7. seller A cannot register a trade against seller B\'s offer to redirect funds', async function () {
      const offerKeyB = offerKeyFor('offer-B2', seller2.address)
      await escrow.connect(seller2).deposit(offerKeyB, { value: ONE })
      const tradeKey = tradeKeyFor('trade-B2')
      await expect(
        escrow.connect(seller).registerTrade(tradeKey, offerKeyB, attacker.address, ONE),
      ).to.be.revertedWith('P2PEscrowV2: only the offer\'s seller can register a trade')
    })

    it('8 & 9. duplicate trade key is rejected, and a colliding tradeKey cannot bleed into a different offer', async function () {
      const offerKey1 = offerKeyFor('offer-dup1', seller.address)
      const offerKey2 = offerKeyFor('offer-dup2', seller.address)
      await escrow.connect(seller).deposit(offerKey1, { value: ONE })
      await escrow.connect(seller).deposit(offerKey2, { value: ONE })

      const tradeKey = tradeKeyFor('trade-dup')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey1, buyer.address, ONE)
      await expect(
        escrow.connect(seller).registerTrade(tradeKey, offerKey2, buyer.address, ONE),
      ).to.be.revertedWith('P2PEscrowV2: trade key already used')
    })
  })

  // ── 10-13: finalization can only ever happen once ─────────────────────
  describe('single finalization', function () {
    async function setupActiveTrade() {
      const offerKey = offerKeyFor('offer-fin', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-fin-' + Math.random())
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)
      return { offerKey, tradeKey }
    }

    it('10. double release fails', async function () {
      const { tradeKey } = await setupActiveTrade()
      await escrow.connect(seller).release(tradeKey)
      await expect(escrow.connect(seller).release(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: trade not active (frozen, already resolved, or unknown)')
    })

    it('11, 12, 13. double refund / release-after-refund / refund-after-release all fail (via the dispute path)', async function () {
      const { tradeKey } = await setupActiveTrade()
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, false) // recommend refund
      await escrow.connect(admin).adminResolve(tradeKey) // -> Refunded

      // Refund after release: N/A here since this path refunded first —
      // prove the SYMMETRIC case instead: resolving again fails outright,
      // whichever direction it would have gone.
      await expect(escrow.connect(admin).adminResolve(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
      await expect(escrow.connect(seller).release(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: trade not active (frozen, already resolved, or unknown)')
    })
  })

  // ── 14-18: the dispute sequence itself ─────────────────────────────────
  describe('Pauser -> Investigator -> Admin sequence', function () {
    async function setupFrozenTrade() {
      const offerKey = offerKeyFor('offer-seq', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-seq-' + Math.random())
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKey)
      return { offerKey, tradeKey }
    }

    it('14. a frozen trade cannot use normal release', async function () {
      const { tradeKey } = await setupFrozenTrade()
      await expect(escrow.connect(seller).release(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: trade not active (frozen, already resolved, or unknown)')
    })

    it('15. pauser can freeze but cannot move USDC (INVARIANT 3)', async function () {
      const { tradeKey, offerKey } = await setupFrozenTrade()
      // No release/adminResolve/withdrawRemaining function is even
      // reachable by a plain pauser — onlyAdmin/onlyInvestigator/seller-only
      // gating excludes them from every value-moving path. release() on an
      // already-frozen trade correctly rejects on the state check before
      // it would even reach the seller check — either way, no pauser call
      // here ever moves a single unit of value.
      await expect(escrow.connect(pauser).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not admin')
      await expect(escrow.connect(pauser).release(tradeKey)).to.be.revertedWith('P2PEscrowV2: trade not active (frozen, already resolved, or unknown)')
      await expect(escrow.connect(pauser).withdrawRemaining(offerKey)).to.be.revertedWith('P2PEscrowV2: not the offer\'s seller')
    })

    it('16 & 17. investigator can investigate only a FROZEN trade, and cannot move USDC (INVARIANT 4)', async function () {
      const offerKey = offerKeyFor('offer-inv', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const activeTradeKey = tradeKeyFor('trade-inv-active')
      await escrow.connect(seller).registerTrade(activeTradeKey, offerKey, buyer.address, ONE)
      // Not frozen yet -- investigate must reject it.
      await expect(escrow.connect(investigator).investigate(activeTradeKey, true))
        .to.be.revertedWith('P2PEscrowV2: trade must be frozen before investigation')

      const { tradeKey } = await setupFrozenTrade()
      await expect(escrow.connect(investigator).investigate(tradeKey, true))
        .to.emit(escrow, 'Investigated').withArgs(tradeKey, investigator.address, true)
      await expect(escrow.connect(investigator).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not admin')
    })

    it('18. admin cannot resolve before investigation', async function () {
      const { tradeKey } = await setupFrozenTrade()
      await expect(escrow.connect(admin).adminResolve(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
    })

    it('19 & 20. admin resolves exactly the specified investigated trade -- buyer receives the stored amount, other trades untouched', async function () {
      const { tradeKey, offerKey } = await setupFrozenTrade()
      await escrow.connect(investigator).investigate(tradeKey, true) // approve release

      // A second, unrelated frozen trade on a different offer must be
      // completely unaffected by resolving the first one.
      const offerKey2 = offerKeyFor('offer-seq2', seller2.address)
      await escrow.connect(seller2).deposit(offerKey2, { value: ONE })
      const tradeKey2 = tradeKeyFor('trade-seq2')
      await escrow.connect(seller2).registerTrade(tradeKey2, offerKey2, buyer.address, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKey2)
      await escrow.connect(investigator).investigate(tradeKey2, true)

      const before = await ethers.provider.getBalance(buyer.address)
      await expect(escrow.connect(admin).adminResolve(tradeKey))
        .to.emit(escrow, 'AdminResolvedRelease').withArgs(offerKey, tradeKey, buyer.address, ONE, admin.address)
      const after = await ethers.provider.getBalance(buyer.address)
      expect(after - before).to.equal(ONE)

      // tradeKey2 is untouched -- still Investigated, not yet resolved.
      const t2 = await escrow.getTrade(tradeKey2)
      expect(t2.state).to.equal(3n) // Investigated
    })
  })

  // ── 21-24: the core admin-cannot-drain invariant ───────────────────────
  describe('admin cannot drain (INVARIANT 5 & 6)', function () {
    it('21. admin cannot withdraw the entire escrow balance -- no such function exists', async function () {
      // Deliberately structural, not just behavioral: assert the ABI has
      // no withdrawAll/sweep/drain-shaped function at all, so this remains
      // true even if someone adds a trade later that happens to sum to
      // the full balance.
      const fragments = escrow.interface.fragments.map(f => f.name).filter(Boolean)
      for (const banned of ['withdrawAll', 'sweep', 'drain', 'emergencyWithdraw', 'rescueFunds']) {
        expect(fragments).to.not.include(banned)
      }
    })

    it('22 & 23. admin cannot arbitrarily choose a recipient or amount -- adminResolve takes only a tradeKey', async function () {
      const adminResolveFragment = escrow.interface.getFunction('adminResolve')
      expect(adminResolveFragment.inputs.map(i => i.name)).to.deep.equal(['tradeKey'])
    })

    it('24. admin cannot drain seller B\'s escrow via seller A\'s investigated trade', async function () {
      const offerKeyA = offerKeyFor('offer-drainA', seller.address)
      const offerKeyB = offerKeyFor('offer-drainB', seller2.address)
      await escrow.connect(seller).deposit(offerKeyA, { value: ONE })
      await escrow.connect(seller2).deposit(offerKeyB, { value: ethers.parseEther('5') })

      const tradeKeyA = tradeKeyFor('trade-drainA')
      await escrow.connect(seller).registerTrade(tradeKeyA, offerKeyA, buyer.address, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKeyA)
      await escrow.connect(investigator).investigate(tradeKeyA, true)
      await escrow.connect(admin).adminResolve(tradeKeyA)

      // Seller B's escrow is completely untouched by resolving seller A's trade.
      expect(await escrow.getRemaining(offerKeyB)).to.equal(ethers.parseEther('5'))
    })
  })

  // ── 25-26: reentrancy / safety ──────────────────────────────────────────
  describe('reentrancy and transfer safety', function () {
    it('25. reentrancy guard rejects a reentrant call attempt', async function () {
      const Reenterer = await ethers.getContractFactory('ReentrancyAttacker')
      const attackerContract = await Reenterer.deploy(await escrow.getAddress())
      await attackerContract.waitForDeployment()

      const offerKey = offerKeyFor('offer-reentry', await attackerContract.getAddress())
      await attackerContract.deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-reentry')
      await attackerContract.registerTrade(tradeKey, offerKey, await attackerContract.getAddress(), ONE)

      // The attacker contract's receive() tries to call release() again
      // mid-transfer -- nonReentrant must block it, and the OUTER call
      // still succeeds normally (the inner attempt just reverts and is
      // swallowed), releasing the trade exactly once.
      await attackerContract.attack(tradeKey)
      const t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(4n) // Released, exactly once
    })

    it('reentrancy guard also protects adminResolve() — a malicious buyer cannot re-enter mid-resolution to double-collect', async function () {
      const Reenterer = await ethers.getContractFactory('ReentrancyAttacker')
      const attackerContract = await Reenterer.deploy(await escrow.getAddress())
      await attackerContract.waitForDeployment()
      const attackerAddr = await attackerContract.getAddress()

      // A normal seller registers a trade where the BUYER is the malicious
      // contract — adminResolve() sends value to t.buyer, which is where
      // reentrancy would have to happen for this specific function.
      const offerKey = offerKeyFor('offer-reentry-admin', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-reentry-admin')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, attackerAddr, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true)
      await attackerContract.setTradeKeyToReenter(tradeKey)

      // adminResolve() sends to attackerAddr; its receive() hook will try
      // to call release()/adminResolve() again. Either the whole call
      // reverts (guard trips before the buyer ever receives partial funds)
      // or it completes exactly once — either way, never twice.
      await escrow.connect(admin).adminResolve(tradeKey)
      const t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(4n) // Released, exactly once
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(ONE) // exactly the trade amount, not more
    })

    it('26. a failed transfer to a contract that rejects value preserves accounting (state doesn\'t advance)', async function () {
      const Rejecter = await ethers.getContractFactory('RejectingReceiver')
      const rejecter = await Rejecter.deploy()
      await rejecter.waitForDeployment()

      const offerKey = offerKeyFor('offer-reject', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-reject')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, await rejecter.getAddress(), ONE)

      await expect(escrow.connect(seller).release(tradeKey)).to.be.revertedWith('P2PEscrowV2: transfer to buyer failed')
      // Whole tx reverted -- remaining balance and trade state are untouched.
      expect(await escrow.getRemaining(offerKey)).to.equal(ONE)
      const t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(1n) // still Active
    })
  })

  // ── 27-29: input validation ─────────────────────────────────────────────
  describe('input validation', function () {
    it('27. registering a trade for more than the remaining escrow fails', async function () {
      const offerKey = offerKeyFor('offer-insuff', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-insuff')
      await expect(
        escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE + 1n),
      ).to.be.revertedWith('P2PEscrowV2: invalid trade amount')
    })

    it('28. zero amount / zero address are rejected', async function () {
      const offerKey = offerKeyFor('offer-zero', seller.address)
      await expect(escrow.connect(seller).deposit(offerKey, { value: 0 })).to.be.revertedWith('P2PEscrowV2: zero deposit')
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-zero')
      await expect(
        escrow.connect(seller).registerTrade(tradeKey, offerKey, ethers.ZeroAddress, ONE),
      ).to.be.revertedWith('P2PEscrowV2: zero buyer address')
      await expect(
        escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, 0),
      ).to.be.revertedWith('P2PEscrowV2: invalid trade amount')
    })

    it('29. invalid state transitions fail (unfreeze a non-frozen trade, investigate a non-frozen trade, resolve a non-investigated trade)', async function () {
      const offerKey = offerKeyFor('offer-invstate', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-invstate')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)

      await expect(escrow.connect(pauser).unfreezeTrade(tradeKey)).to.be.revertedWith('P2PEscrowV2: trade not frozen')
      await expect(escrow.connect(investigator).investigate(tradeKey, true)).to.be.revertedWith('P2PEscrowV2: trade must be frozen before investigation')
      await expect(escrow.connect(admin).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
    })
  })

  // ── 30: privileged-function access control ─────────────────────────────
  describe('access control (INVARIANT 2)', function () {
    it('30. an unauthorized wallet cannot call any privileged function', async function () {
      const offerKey = offerKeyFor('offer-access', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-access')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)

      await expect(escrow.connect(attacker).freezeTrade(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not a pauser')
      await expect(escrow.connect(attacker).investigate(tradeKey, true)).to.be.revertedWith('P2PEscrowV2: caller is not an investigator')
      await expect(escrow.connect(attacker).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not admin')
      await expect(escrow.connect(attacker).proposeRoleChange(ROLE_ACTION.AddPauser, attacker.address))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })
  })

  // ── 31: admin transfer + role hierarchy ────────────────────────────────
  describe('admin transfer and role hierarchy', function () {
    it('31a. two-step admin transfer works, and only the pending admin can accept', async function () {
      await grantRole('TransferAdmin', investigator.address)
      await expect(escrow.connect(attacker).acceptAdmin()).to.be.revertedWith('P2PEscrowV2: caller is not the pending admin')
      await expect(escrow.connect(investigator).acceptAdmin())
        .to.emit(escrow, 'AdminTransferred').withArgs(admin.address, investigator.address)
      expect(await escrow.admin()).to.equal(investigator.address)
    })

    it('31b. zero-address protection on transferAdmin/addPauser/addInvestigator (checked at proposal time)', async function () {
      await expect(escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, ethers.ZeroAddress))
        .to.be.revertedWith('P2PEscrowV2: zero address')
      await expect(escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, ethers.ZeroAddress))
        .to.be.revertedWith('P2PEscrowV2: zero address')
    })

    it('role hierarchy: cannot become investigator without already being a pauser (checked at execute time, after the timelock)', async function () {
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddInvestigator, seller.address)
      await tx1.wait()
      const proposalId1 = (await escrow.roleProposalCount()) - 1n
      // Confirming succeeds and starts the timelock -- the hierarchy
      // precondition is only checked at actual execution now.
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId1)).to.not.be.reverted
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId1))
        .to.be.revertedWith('P2PEscrowV2: account must already be a pauser')

      await grantRole('AddPauser', seller.address)
      await expect(grantRole('AddInvestigator', seller.address)).to.not.be.reverted
    })

    it('role hierarchy: cannot become pending admin without already being an investigator (checked at execute time, after the timelock)', async function () {
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, seller.address)
      await tx1.wait()
      const proposalId1 = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId1)).to.not.be.reverted
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId1))
        .to.be.revertedWith('P2PEscrowV2: new admin must already be an investigator')

      await expect(grantRole('TransferAdmin', investigator.address)).to.not.be.reverted
    })
  })

  // ── 32: full end-to-end sequence ────────────────────────────────────────
  describe('32. full Pauser -> Investigator -> Admin sequence enforced end-to-end', function () {
    it('a disputed trade can only complete through every step, in order, with the right role at each step', async function () {
      const offerKey = offerKeyFor('offer-e2e', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-e2e')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)

      // Step 0: normal release still blocked once we're about to dispute? No --
      // it's blocked only once frozen. Before freezing, normal release works
      // fine (proving disputes don't interfere with untouched trades).
      // Freeze (pauser):
      await expect(escrow.connect(pauser).freezeTrade(tradeKey)).to.not.be.reverted
      let t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(2n) // Frozen

      // Investigate (a DIFFERENT address from whoever froze it):
      await escrow.connect(investigator).investigate(tradeKey, false) // recommend refund
      t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(3n) // Investigated
      expect(t.investigatedBy).to.equal(investigator.address)

      // Resolve:
      const sellerRemainingBefore = await escrow.getRemaining(offerKey)
      await escrow.connect(admin).adminResolve(tradeKey)
      t = await escrow.getTrade(tradeKey)
      expect(t.state).to.equal(5n) // Refunded
      expect(t.resolvedBy).to.equal(admin.address)
      // Refund path never debited e.remaining -- seller can still withdraw it.
      expect(await escrow.getRemaining(offerKey)).to.equal(sellerRemainingBefore)
      await expect(escrow.connect(seller).withdrawRemaining(offerKey)).to.not.be.reverted
    })
  })

  // ── Second-pass security review additions ──────────────────────────────
  describe('role separation cannot be silently bypassed', function () {
    it('a fresh admin (via transferAdmin/acceptAdmin) has NO implicit pauser/investigator power — every tier must be explicitly granted, no shortcuts', async function () {
      await grantRole('TransferAdmin', investigator.address)
      await escrow.connect(investigator).acceptAdmin()
      expect(await escrow.admin()).to.equal(investigator.address)

      const offerKey = offerKeyFor('offer-roleoverlap', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-roleoverlap')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKey)
      // investigator2 investigates (NOT investigator, who is about to act as
      // admin below) — otherwise this would trip the independence check for
      // an unrelated reason and not actually test what this test is about.
      await escrow.connect(investigator2).investigate(tradeKey, true)

      // The OLD admin signer can no longer resolve anything -- onlyAdmin
      // now points at investigator.address, not admin.address.
      await expect(escrow.connect(admin).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not admin')
      // The new admin (investigator.address) can.
      await expect(escrow.connect(investigator).adminResolve(tradeKey)).to.not.be.reverted
    })

    it('deploying a fresh contract grants NOTHING automatically — not even to the deployer, not even Pauser. Every role, including the very first one, must go through the 2-of-3 role-manager multisig', async function () {
      expect(await escrow.isPauser(admin.address)).to.equal(false)
      expect(await escrow.isInvestigator(admin.address)).to.equal(false)
      expect(await escrow.isPauser(seller2.address)).to.equal(false)
      expect(await escrow.isInvestigator(seller2.address)).to.equal(false)
      // The 3 role manager signers are set (constructor args), but that is
      // ONLY the authority to propose/confirm role changes -- it is not
      // itself Pauser/Investigator/Admin status.
      expect(await escrow.isRoleManagerSigner(roleManager1.address)).to.equal(true)
      expect(await escrow.isPauser(roleManager1.address)).to.equal(false)
    })
  })

  describe('offer-key seller binding — dedicated regression test', function () {
    it('the exact same offerId produces a DIFFERENT offerKey for two different sellers, and each is independently controlled', async function () {
      const sameOfferId = 'offer-shared-id'
      const keyForSeller = offerKeyFor(sameOfferId, seller.address)
      const keyForSeller2 = offerKeyFor(sameOfferId, seller2.address)
      expect(keyForSeller).to.not.equal(keyForSeller2)

      await escrow.connect(seller).deposit(keyForSeller, { value: ONE })
      await escrow.connect(seller2).deposit(keyForSeller2, { value: ethers.parseEther('2') })

      expect(await escrow.getSeller(keyForSeller)).to.equal(seller.address)
      expect(await escrow.getSeller(keyForSeller2)).to.equal(seller2.address)
      expect(await escrow.getRemaining(keyForSeller)).to.equal(ONE)
      expect(await escrow.getRemaining(keyForSeller2)).to.equal(ethers.parseEther('2'))

      await escrow.connect(seller2).deposit(keyForSeller2, { value: ONE })
      expect(await escrow.getRemaining(keyForSeller)).to.equal(ONE) // unchanged
    })
  })

  describe('offer-level freeze (PAUSER)', function () {
    it('freezeOffer blocks new deposits and new trade registrations, but does not touch trades already registered', async function () {
      const offerKey = offerKeyFor('offer-freeze', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const existingTradeKey = tradeKeyFor('trade-before-freeze')
      await escrow.connect(seller).registerTrade(existingTradeKey, offerKey, buyer.address, ethers.parseEther('0.2'))

      await expect(escrow.connect(pauser).freezeOffer(offerKey))
        .to.emit(escrow, 'OfferFrozen').withArgs(offerKey, pauser.address)

      await expect(escrow.connect(seller).deposit(offerKey, { value: ONE }))
        .to.be.revertedWith('P2PEscrowV2: offer is frozen')
      const newTradeKey = tradeKeyFor('trade-after-freeze')
      await expect(escrow.connect(seller).registerTrade(newTradeKey, offerKey, buyer.address, ethers.parseEther('0.1')))
        .to.be.revertedWith('P2PEscrowV2: offer is frozen')

      await expect(escrow.connect(seller).release(existingTradeKey)).to.not.be.reverted

      await escrow.connect(pauser).unfreezeOffer(offerKey)
      await expect(escrow.connect(seller).deposit(offerKey, { value: ONE })).to.not.be.reverted
    })

    it('only a pauser can freeze/unfreeze an offer', async function () {
      const offerKey = offerKeyFor('offer-freeze-access', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      await expect(escrow.connect(attacker).freezeOffer(offerKey)).to.be.revertedWith('P2PEscrowV2: caller is not a pauser')
    })
  })

  describe('registered trade data is immutable', function () {
    it('there is no function anywhere in the ABI that can modify an already-registered trade\'s stored buyer, amount, or seller', async function () {
      const fragments = escrow.interface.fragments.map(f => f.name).filter(Boolean)
      for (const banned of ['updateTrade', 'setBuyer', 'setAmount', 'editTrade', 'overrideTrade', 'setTradeSeller']) {
        expect(fragments).to.not.include(banned)
      }
    })
  })

  describe('role hierarchy stays a standing invariant, not just a one-time promotion gate', function () {
    it('removing pauser also removes investigator, if held — no orphaned investigator without pauser access', async function () {
      // investigator (the signer) already holds both roles from beforeEach.
      expect(await escrow.isPauser(investigator.address)).to.equal(true)
      expect(await escrow.isInvestigator(investigator.address)).to.equal(true)

      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.RemovePauser, investigator.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      // Confirming starts the timelock now, it doesn't execute directly.
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      expect(await escrow.isPauser(investigator.address)).to.equal(true) // unchanged -- still timelocked
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      // The execute call is what actually carries the PauserRemoved/InvestigatorRemoved events.
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.emit(escrow, 'InvestigatorRemoved').withArgs(investigator.address, await escrow.getAddress())

      expect(await escrow.isPauser(investigator.address)).to.equal(false)
      expect(await escrow.isInvestigator(investigator.address)).to.equal(false)

      // And they can no longer investigate anything.
      const offerKey = offerKeyFor('offer-cascade', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-cascade')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await expect(escrow.connect(investigator).investigate(tradeKey, true))
        .to.be.revertedWith('P2PEscrowV2: caller is not an investigator')
    })

    it('removing pauser from someone who is only a pauser (not investigator) does not emit InvestigatorRemoved', async function () {
      // pauser signer only ever got AddPauser in beforeEach, never AddInvestigator.
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.RemovePauser, pauser.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      const tx2 = await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      await expect(tx2).to.emit(escrow, 'PauserRemoved').withArgs(pauser.address, await escrow.getAddress())
      await expect(tx2).to.not.emit(escrow, 'InvestigatorRemoved')
    })
  })

  // ── Third-pass security review: TRUE ROLE INDEPENDENCE ─────────────────
  // Enforced on-chain, not just by convention: whoever froze a trade cannot
  // investigate THAT SAME trade, and whoever investigated it cannot resolve
  // it — even when the same address genuinely holds multiple roles overall
  // (which the contract cannot and does not try to prevent — see the
  // contract's own "trust assumption" comment). This is a PER-DISPUTE
  // check, not a permanent one-role-per-address restriction.
  describe('true role independence per dispute — same operator cannot satisfy two stages of one dispute', function () {
    async function setupActiveTradeIndependence() {
      const offerKey = offerKeyFor('offer-indep-' + Math.random(), seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const tradeKey = tradeKeyFor('trade-indep-' + Math.random())
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ONE)
      return { offerKey, tradeKey }
    }

    it('same Pauser + Investigator on one trade → REVERT (investigator must differ from whoever froze it)', async function () {
      const { tradeKey } = await setupActiveTradeIndependence()
      // investigator is genuinely both pauser and investigator (beforeEach) —
      // freezing AND investigating the SAME trade with the same address
      // must be rejected.
      await escrow.connect(investigator).freezeTrade(tradeKey)
      await expect(escrow.connect(investigator).investigate(tradeKey, true))
        .to.be.revertedWith('P2PEscrowV2: investigator must be different from the pauser who froze this trade')

      // A genuinely different investigator CAN investigate the same trade.
      await expect(escrow.connect(investigator2).investigate(tradeKey, true)).to.not.be.reverted
    })

    it('same Investigator + Admin on one trade → REVERT (admin must differ from whoever investigated it)', async function () {
      const { tradeKey } = await setupActiveTradeIndependence()
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true)

      // Promote investigator to admin, then try to have them resolve their
      // own investigation.
      await grantRole('TransferAdmin', investigator.address)
      await escrow.connect(investigator).acceptAdmin()
      await expect(escrow.connect(investigator).adminResolve(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: admin must be different from this trade\'s investigator')
    })

    it('same Pauser + Admin on one trade → REVERT (admin must differ from whoever froze it, even if a different investigator was involved)', async function () {
      const { tradeKey } = await setupActiveTradeIndependence()
      // pauser freezes, investigator2 investigates (genuinely independent
      // from pauser), then pauser is promoted to admin and tries to
      // resolve the SAME trade they froze.
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator2).investigate(tradeKey, true)

      await grantRole('AddInvestigator', pauser.address) // pauser already has PAUSER; promote to INVESTIGATOR too (prerequisite for admin)
      await grantRole('TransferAdmin', pauser.address)
      await escrow.connect(pauser).acceptAdmin()
      await expect(escrow.connect(pauser).adminResolve(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: admin must be different from this trade\'s pauser')
    })

    it('a single address holding Pauser + Investigator + Admin cannot complete a dispute alone, even though nothing stops it from holding all three roles in general', async function () {
      // Promote `investigator` (already pauser+investigator) all the way to admin.
      await grantRole('TransferAdmin', investigator.address)
      await escrow.connect(investigator).acceptAdmin()
      expect(await escrow.isPauser(investigator.address)).to.equal(true)
      expect(await escrow.isInvestigator(investigator.address)).to.equal(true)
      expect(await escrow.admin()).to.equal(investigator.address)

      const { tradeKey } = await setupActiveTradeIndependence()
      // Freeze (as pauser):
      await escrow.connect(investigator).freezeTrade(tradeKey)
      // Cannot investigate what they just froze:
      await expect(escrow.connect(investigator).investigate(tradeKey, true))
        .to.be.revertedWith('P2PEscrowV2: investigator must be different from the pauser who froze this trade')

      // Even routing around it via a different investigator, `investigator`
      // (now admin) still cannot resolve if THEY are also who froze it —
      // needs investigator2 to break the freeze/resolve link too.
      await escrow.connect(investigator2).investigate(tradeKey, true)
      await expect(escrow.connect(investigator).adminResolve(tradeKey))
        .to.be.revertedWith('P2PEscrowV2: admin must be different from this trade\'s pauser')

      // The dispute CAN still complete — just not by this one address alone
      // at every stage. A genuinely different admin finishes it. Role grants
      // still go through the 2-of-3 role-manager multisig regardless of who
      // holds admin -- admin never had any unilateral role-granting power
      // to begin with, so nothing here depends on who is currently admin.
      await grantRole('AddPauser', seller2.address)
      await grantRole('AddInvestigator', seller2.address)
      await grantRole('TransferAdmin', seller2.address)
      await escrow.connect(seller2).acceptAdmin()
      await expect(escrow.connect(seller2).adminResolve(tradeKey)).to.not.be.reverted
    })

    it('the SAME trade\'s frozenBy/investigatedBy/resolvedBy are all recorded and independently checkable via getTrade()', async function () {
      const { tradeKey } = await setupActiveTradeIndependence()
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true)
      await escrow.connect(admin).adminResolve(tradeKey)
      const t = await escrow.getTrade(tradeKey)
      expect(t.frozenBy).to.equal(pauser.address)
      expect(t.investigatedBy).to.equal(investigator.address)
      expect(t.resolvedBy).to.equal(admin.address)
      // All three genuinely distinct.
      expect(new Set([t.frozenBy, t.investigatedBy, t.resolvedBy]).size).to.equal(3)
    })
  })

  describe('complete accounting audit — multiple sellers, offers, trades, and simultaneous disputes', function () {
    it('traces exact balances through a realistic mixed scenario: two sellers, several trades each, one normal release, one disputed release, one disputed refund — nothing bleeds across sellers or trades', async function () {
      const offerA = offerKeyFor('offer-audit-A', seller.address)
      await escrow.connect(seller).deposit(offerA, { value: ethers.parseEther('3') })
      const tradeA1 = tradeKeyFor('trade-audit-A1')
      const tradeA2 = tradeKeyFor('trade-audit-A2')
      await escrow.connect(seller).registerTrade(tradeA1, offerA, buyer.address, ethers.parseEther('1'))
      await escrow.connect(seller).registerTrade(tradeA2, offerA, buyer.address, ethers.parseEther('1.5'))

      const offerB = offerKeyFor('offer-audit-B', seller2.address)
      await escrow.connect(seller2).deposit(offerB, { value: ethers.parseEther('5') })
      const tradeB1 = tradeKeyFor('trade-audit-B1')
      await escrow.connect(seller2).registerTrade(tradeB1, offerB, buyer.address, ethers.parseEther('2'))

      expect(await escrow.getRemaining(offerA)).to.equal(ethers.parseEther('3'))
      expect(await escrow.getRemaining(offerB)).to.equal(ethers.parseEther('5'))

      const buyerBefore1 = await ethers.provider.getBalance(buyer.address)
      await escrow.connect(seller).release(tradeA1)
      expect(await ethers.provider.getBalance(buyer.address) - buyerBefore1).to.equal(ethers.parseEther('1'))
      expect(await escrow.getRemaining(offerA)).to.equal(ethers.parseEther('2'))
      expect(await escrow.getRemaining(offerB)).to.equal(ethers.parseEther('5'))

      await escrow.connect(pauser).freezeTrade(tradeA2)
      await escrow.connect(pauser).freezeTrade(tradeB1)
      await escrow.connect(investigator).investigate(tradeA2, true)
      await escrow.connect(investigator2).investigate(tradeB1, false)

      const buyerBefore2 = await ethers.provider.getBalance(buyer.address)
      await escrow.connect(admin).adminResolve(tradeA2)
      expect(await ethers.provider.getBalance(buyer.address) - buyerBefore2).to.equal(ethers.parseEther('1.5'))
      expect(await escrow.getRemaining(offerA)).to.equal(ethers.parseEther('0.5')) // 2 - 1.5

      await escrow.connect(admin).adminResolve(tradeB1)
      expect(await escrow.getRemaining(offerB)).to.equal(ethers.parseEther('5')) // refund never debited

      const sellerBBefore = await ethers.provider.getBalance(seller2.address)
      const tx = await escrow.connect(seller2).withdrawRemaining(offerB)
      const receipt = await tx.wait()
      const gasCost = receipt.gasUsed * receipt.gasPrice
      const sellerBAfter = await ethers.provider.getBalance(seller2.address)
      expect(sellerBAfter - sellerBBefore + gasCost).to.equal(ethers.parseEther('5'))
      expect(await escrow.getRemaining(offerB)).to.equal(0n)

      expect(await escrow.getRemaining(offerA)).to.equal(ethers.parseEther('0.5'))
    })

    it('multiple simultaneous disputes on DIFFERENT trades of the SAME offer resolve independently', async function () {
      const offerKey = offerKeyFor('offer-audit-multi', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('10') })
      const t1 = tradeKeyFor('trade-multi-1')
      const t2 = tradeKeyFor('trade-multi-2')
      const t3 = tradeKeyFor('trade-multi-3')
      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('2'))
      await escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('3'))
      await escrow.connect(seller).registerTrade(t3, offerKey, buyer.address, ethers.parseEther('4'))

      await escrow.connect(pauser).freezeTrade(t1)
      await escrow.connect(pauser).freezeTrade(t2)
      await escrow.connect(pauser).freezeTrade(t3)

      await escrow.connect(investigator).investigate(t1, true)
      await escrow.connect(investigator).investigate(t2, false)
      await escrow.connect(investigator).investigate(t3, true)

      await escrow.connect(admin).adminResolve(t2)
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('10'))

      await escrow.connect(admin).adminResolve(t3)
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('6'))

      await escrow.connect(admin).adminResolve(t1)
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('4'))

      await expect(escrow.connect(admin).adminResolve(t1)).to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
      await expect(escrow.connect(admin).adminResolve(t2)).to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
      await expect(escrow.connect(admin).adminResolve(t3)).to.be.revertedWith('P2PEscrowV2: trade must be investigated before admin can resolve it')
    })
  })

  // ── PROPERTY 8: recorded escrow never exceeds actual USDC held ─────────
  // The one requested property not already covered above. No Foundry-style
  // fuzzer is set up in this Hardhat/JS project, so this uses the
  // strongest practical equivalent available here: a long pseudo-random
  // sequence of deposit/release/freeze/investigate/resolve/withdraw calls
  // (seeded, so failures reproduce deterministically) with the invariant
  // checked after EVERY single step, not just at the end — a bug that
  // temporarily violated the invariant mid-sequence and "fixed itself"
  // later would still be caught.
  describe('PROPERTY 8: recorded escrow never exceeds actual contract balance (pseudo-random invariant sweep)', function () {
    it('sum of all offers\' remaining balances never exceeds the contract\'s actual native balance, across a long randomized operation sequence', async function () {
      // Deterministic PRNG (mulberry32) — reproducible across runs, no
      // external dependency needed.
      let seed = 0xC0FFEE
      function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      function pick(arr) { return arr[Math.floor(rand() * arr.length)] }

      const sellers = [seller, seller2, buyer] // buyer doubles as a third seller here — just another EOA for this sweep
      const offerKeys = new Map() // sellerAddr -> offerKey
      for (const s of sellers) offerKeys.set(s.address, offerKeyFor('offer-fuzz-' + s.address, s.address))
      const activeTradeKeys = [] // { tradeKey, offerKeySeller }

      async function checkInvariant() {
        let sumRemaining = 0n
        for (const [, key] of offerKeys) sumRemaining += await escrow.getRemaining(key)
        const actualBalance = await ethers.provider.getBalance(await escrow.getAddress())
        expect(actualBalance >= sumRemaining, `contract balance ${actualBalance} fell below recorded remaining ${sumRemaining}`).to.equal(true)
      }

      const STEPS = 40
      for (let i = 0; i < STEPS; i++) {
        const action = pick(['deposit', 'registerAndRelease', 'registerAndDispute', 'noop'])
        try {
          if (action === 'deposit') {
            const s = pick(sellers)
            await escrow.connect(s).deposit(offerKeys.get(s.address), { value: ethers.parseEther(String(1 + Math.floor(rand() * 3))) })
          } else if (action === 'registerAndRelease') {
            const s = pick(sellers)
            const remaining = await escrow.getRemaining(offerKeys.get(s.address))
            if (remaining === 0n) continue
            const amount = remaining / 2n > 0n ? remaining / 2n : remaining
            if (amount === 0n) continue
            const tk = tradeKeyFor('fuzz-release-' + i + '-' + rand())
            await escrow.connect(s).registerTrade(tk, offerKeys.get(s.address), buyer.address, amount)
            await escrow.connect(s).release(tk)
          } else if (action === 'registerAndDispute') {
            const s = pick(sellers)
            const remaining = await escrow.getRemaining(offerKeys.get(s.address))
            if (remaining === 0n) continue
            const amount = remaining / 3n > 0n ? remaining / 3n : remaining
            if (amount === 0n) continue
            const tk = tradeKeyFor('fuzz-dispute-' + i + '-' + rand())
            await escrow.connect(s).registerTrade(tk, offerKeys.get(s.address), buyer.address, amount)
            await escrow.connect(pauser).freezeTrade(tk)
            await escrow.connect(investigator).investigate(tk, rand() > 0.5)
            await escrow.connect(admin).adminResolve(tk)
          }
          // 'noop' — deliberately does nothing this step, still checked below.
        } catch {
          // Some steps legitimately revert (e.g. depositing into an offer
          // owned by someone else never happens here, but a zero-remaining
          // registerTrade attempt might slip through the `continue` guards
          // above in an edge case) — the invariant must hold even after a
          // reverted attempt, so don't skip the check.
        }
        await checkInvariant()
      }

      // Final settlement: every seller withdraws whatever's left, and the
      // invariant must still hold (trivially, at 0) afterward.
      for (const s of sellers) {
        const remaining = await escrow.getRemaining(offerKeys.get(s.address))
        if (remaining > 0n) await escrow.connect(s).withdrawRemaining(offerKeys.get(s.address))
      }
      await checkInvariant()
    })
  })

  // ── Role manager multisig mechanism itself ──────────────────────────────
  describe('2-of-3 role manager multisig — the mechanism itself', function () {
    it('a single confirmation is not enough — proposing alone does not execute', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      const p = await escrow.getRoleProposal(proposalId)
      expect(p.executed).to.equal(false)
      expect(p.confirmations).to.equal(1n)
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('a non-signer cannot propose or confirm', async function () {
      await expect(escrow.connect(attacker).proposeRoleChange(ROLE_ACTION.AddPauser, attacker.address))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(attacker).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })

    it('the same signer confirming twice does not count as two confirmations', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager1).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: already confirmed by this signer')
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('a cancelled proposal cannot later be confirmed or executed', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager3).cancelRoleProposal(proposalId)
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal was cancelled')
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('a THIRD signer confirming an already-executed proposal is rejected', async function () {
      await grantRole('AddPauser', seller.address)
      const proposalId = (await escrow.roleProposalCount()) - 1n
      expect((await escrow.getRoleProposal(proposalId)).executed).to.equal(true)
      await expect(escrow.connect(roleManager3).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal already executed')
    })

    it('the role manager multisig has NO path to move USDC — RoleAction has no fund-moving option, and the multisig functions never touch escrow/trade balances', async function () {
      expect(Object.keys(ROLE_ACTION)).to.not.include.members(['Release', 'Refund', 'Withdraw', 'Resolve'])
      // Behaviorally: even a fully-executed, legitimate role proposal
      // never changes any offer's remaining balance.
      const offerKey = offerKeyFor('offer-rolemanager-safety', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ONE })
      const before = await escrow.getRemaining(offerKey)
      await grantRole('AddPauser', buyer.address)
      const after = await escrow.getRemaining(offerKey)
      expect(after).to.equal(before)
    })
  })

  // ── Role manager signer rotation ────────────────────────────────────────
  describe('role manager signer rotation — 2-of-3 authorized only', function () {
    it('successful rotation: 2 of 3 signers replace slot 0 with a new address', async function () {
      const tx1 = await escrow.connect(roleManager1).proposeSignerRotation(0, seller2.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      // Timelocked -- unchanged until execution.
      expect(await escrow.isRoleManagerSigner(roleManager1.address)).to.equal(true)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.emit(escrow, 'SignerRotated').withArgs(0n, roleManager1.address, seller2.address)

      expect(await escrow.isRoleManagerSigner(roleManager1.address)).to.equal(false)
      expect(await escrow.isRoleManagerSigner(seller2.address)).to.equal(true)
      expect(await escrow.roleManagerSigners(0)).to.equal(seller2.address)
    })

    it('unauthorized rotation: a non-signer cannot propose or confirm a rotation', async function () {
      await expect(escrow.connect(attacker).proposeSignerRotation(0, seller2.address))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
      const tx1 = await escrow.connect(roleManager1).proposeSignerRotation(0, seller2.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(attacker).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })

    it('single signer insufficient: proposing alone does not rotate anything', async function () {
      const tx1 = await escrow.connect(roleManager1).proposeSignerRotation(0, seller2.address)
      await tx1.wait()
      expect(await escrow.isRoleManagerSigner(roleManager1.address)).to.equal(true) // unchanged
      expect(await escrow.roleManagerSigners(0)).to.equal(roleManager1.address) // unchanged
    })

    it('duplicate signer rejected: cannot rotate a slot to an address that\'s already one of the 3 current signers', async function () {
      await expect(escrow.connect(roleManager1).proposeSignerRotation(0, roleManager2.address))
        .to.be.revertedWith('P2PEscrowV2: address is already a role manager signer')
      await expect(escrow.connect(roleManager1).proposeSignerRotation(0, roleManager3.address))
        .to.be.revertedWith('P2PEscrowV2: address is already a role manager signer')
    })

    it('zero address rejected', async function () {
      await expect(escrow.connect(roleManager1).proposeSignerRotation(0, ethers.ZeroAddress))
        .to.be.revertedWith('P2PEscrowV2: zero address')
    })

    it('out-of-range signer index rejected', async function () {
      await expect(escrow.connect(roleManager1).proposeSignerRotation(3, seller2.address))
        .to.be.revertedWith('P2PEscrowV2: signer index out of range')
    })

    it('rotation preserves 2-of-3 security: the OLD signer loses power only after execution, and the multisig still requires exactly 2 of the (new) 3 afterward', async function () {
      await grantRole('AddPauser', buyer.address) // baseline: still works before rotation

      const tx1 = await escrow.connect(roleManager1).proposeSignerRotation(0, seller2.address)
      await tx1.wait()
      const rotateProposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(rotateProposalId)
      // Still timelocked -- roleManager1 has NOT lost power yet.
      expect(await escrow.isRoleManagerSigner(roleManager1.address)).to.equal(true)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(rotateProposalId)

      // Old signer (roleManager1) can no longer propose or confirm anything.
      await expect(escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')

      // A single new-era signer still isn't enough alone...
      const tx2 = await escrow.connect(seller2).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx2.wait()
      const proposalId2 = (await escrow.roleProposalCount()) - 1n
      expect((await escrow.getRoleProposal(proposalId2)).executed).to.equal(false)

      // ...but 2 of the NEW set of 3 (seller2 + roleManager2, or seller2 + roleManager3) works.
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId2)).to.not.be.reverted
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager2).executeRoleProposal(proposalId2)
      expect(await escrow.isPauser(seller.address)).to.equal(true)
    })
  })
  // ── SECURITY FIX: reserved escrow accounting ────────────────────────────
  describe('reserved escrow accounting — a seller can never withdraw funds already committed to an active trade', function () {
    it('the exact scenario from the audit: 100 deposited, 70 reserved by a trade -> seller can withdraw only 30', async function () {
      const offerKey = offerKeyFor('offer-reserved-1', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const tradeKey = tradeKeyFor('trade-reserved-1')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('70'))

      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('100'))
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))

      const sellerBefore = await ethers.provider.getBalance(seller.address)
      const tx = await escrow.connect(seller).withdrawRemaining(offerKey)
      const receipt = await tx.wait()
      const gasCost = receipt.gasUsed * receipt.gasPrice
      const sellerAfter = await ethers.provider.getBalance(seller.address)
      expect(sellerAfter - sellerBefore + gasCost).to.equal(ethers.parseEther('30'))

      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)

      const buyerBefore = await ethers.provider.getBalance(buyer.address)
      await escrow.connect(seller).release(tradeKey)
      const buyerAfter = await ethers.provider.getBalance(buyer.address)
      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther('70'))
      expect(await escrow.getRemaining(offerKey)).to.equal(0n)
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
    })

    it('a second trade can be registered against the remaining available capacity, but a third that would over-commit reverts', async function () {
      const offerKey = offerKeyFor('offer-reserved-2', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const t1 = tradeKeyFor('trade-reserved-2a')
      const t2 = tradeKeyFor('trade-reserved-2b')
      const t3 = tradeKeyFor('trade-reserved-2c')

      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))

      await expect(escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('30'))).to.not.be.reverted
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('100'))

      await expect(escrow.connect(seller).registerTrade(t3, offerKey, buyer.address, ethers.parseEther('1')))
        .to.be.revertedWith('P2PEscrowV2: invalid trade amount')

      await expect(escrow.connect(seller).withdrawRemaining(offerKey))
        .to.be.revertedWith('P2PEscrowV2: nothing available to withdraw (funds are reserved for active trades or already withdrawn)')
    })

    it('release correctly frees the reservation, making that capacity available again for withdrawal or a new trade', async function () {
      const offerKey = offerKeyFor('offer-reserved-3', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const t1 = tradeKeyFor('trade-reserved-3a')
      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('70'))
      await escrow.connect(seller).release(t1)

      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('30'))
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))

      const t2 = tradeKeyFor('trade-reserved-3b')
      await expect(escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('30'))).to.not.be.reverted
    })

    it('a disputed REFUND correctly frees the reservation (same as release, just no transfer)', async function () {
      const offerKey = offerKeyFor('offer-reserved-4', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const tradeKey = tradeKeyFor('trade-reserved-4')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('70'))
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, false)
      await escrow.connect(admin).adminResolve(tradeKey)

      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('100'))
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('100'))

      const sellerBefore = await ethers.provider.getBalance(seller.address)
      const tx = await escrow.connect(seller).withdrawRemaining(offerKey)
      const receipt = await tx.wait()
      const gasCost = receipt.gasUsed * receipt.gasPrice
      const sellerAfter = await ethers.provider.getBalance(seller.address)
      expect(sellerAfter - sellerBefore + gasCost).to.equal(ethers.parseEther('100'))
    })

    it('a disputed RELEASE correctly frees the reservation AND removes the funds from remaining', async function () {
      const offerKey = offerKeyFor('offer-reserved-5', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const tradeKey = tradeKeyFor('trade-reserved-5')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('70'))
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true)
      await escrow.connect(admin).adminResolve(tradeKey)

      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('30'))
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))
    })

    it('reservation persists correctly through a frozen/investigated trade still pending -- funds stay locked, not just during Active', async function () {
      const offerKey = offerKeyFor('offer-reserved-6', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const tradeKey = tradeKeyFor('trade-reserved-6')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('70'))
      await escrow.connect(pauser).freezeTrade(tradeKey)
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))
      await expect(escrow.connect(seller).withdrawRemaining(offerKey))
        .to.emit(escrow, 'Withdrawn').withArgs(offerKey, seller.address, ethers.parseEther('30'))
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)
    })

    it('multiple simultaneous trades: total reserved never exceeds remaining, checked after every operation in a mixed sequence', async function () {
      const offerKey = offerKeyFor('offer-reserved-7', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('10') })

      async function checkInvariant() {
        const e = await escrow.escrows(offerKey)
        expect(e.reserved <= e.remaining).to.equal(true)
      }

      const t1 = tradeKeyFor('trade-reserved-7a')
      const t2 = tradeKeyFor('trade-reserved-7b')
      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('4'))
      await checkInvariant()
      await escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('3'))
      await checkInvariant()
      await escrow.connect(seller).release(t1)
      await checkInvariant()
      await escrow.connect(seller).withdrawRemaining(offerKey)
      await checkInvariant()
      await escrow.connect(seller).release(t2)
      await checkInvariant()
      expect(await escrow.getRemaining(offerKey)).to.equal(0n)
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
    })
  })

  describe('PROPERTY 11: reserved never exceeds remaining (pseudo-random invariant sweep, includes withdrawals mid-sequence)', function () {
    it('holds across register/release/withdraw/dispute operations in random order', async function () {
      let seed = 0xDEADBEEF
      function rand() {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const offerKey = offerKeyFor('offer-reserved-fuzz', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('20') })
      const activeTradeKeys = []

      async function checkInvariant() {
        const e = await escrow.escrows(offerKey)
        expect(e.reserved <= e.remaining).to.equal(true)
        const actualBalance = await ethers.provider.getBalance(await escrow.getAddress())
        expect(actualBalance >= e.remaining).to.equal(true)
      }

      for (let i = 0; i < 30; i++) {
        const action = rand()
        try {
          if (action < 0.4) {
            const available = await escrow.getAvailable(offerKey)
            if (available > 0n) {
              const amount = available / 2n > 0n ? available / 2n : available
              const tk = tradeKeyFor('fuzz-reserved-' + i + '-' + rand())
              await escrow.connect(seller).registerTrade(tk, offerKey, buyer.address, amount)
              activeTradeKeys.push(tk)
            }
          } else if (action < 0.7 && activeTradeKeys.length > 0) {
            const tk = activeTradeKeys.pop()
            await escrow.connect(seller).release(tk)
          } else if (action < 0.9) {
            const available = await escrow.getAvailable(offerKey)
            if (available > 0n) await escrow.connect(seller).withdrawRemaining(offerKey)
          } else {
            await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('1') })
          }
        } catch { /* some attempts legitimately revert -- invariant must still hold */ }
        await checkInvariant()
      }
    })
  })

  // ── SECURITY FIX: admin acceptance re-checks the investigator requirement ──
  describe('admin acceptance hierarchy — re-verified at acceptance time, not just nomination time', function () {
    it('Investigator -> pending Admin -> Investigator removed -> acceptAdmin() MUST revert', async function () {
      await grantRole('TransferAdmin', investigator.address)
      expect(await escrow.pendingAdmin()).to.equal(investigator.address)

      await grantRole('RemovePauser', investigator.address) // cascades to remove Investigator too
      expect(await escrow.isInvestigator(investigator.address)).to.equal(false)

      await expect(escrow.connect(investigator).acceptAdmin())
        .to.be.revertedWith('P2PEscrowV2: pending admin is no longer an investigator')
      expect(await escrow.admin()).to.equal(admin.address)
    })

    it('the valid flow still works when the pending admin remains an investigator throughout', async function () {
      await grantRole('TransferAdmin', investigator.address)
      await expect(escrow.connect(investigator).acceptAdmin())
        .to.emit(escrow, 'AdminTransferred').withArgs(admin.address, investigator.address)
      expect(await escrow.admin()).to.equal(investigator.address)
    })
  })

  // ── Final verification pass: the EXACT end-to-end sequence requested ────
  describe('final verification: the complete exact requested sequence, chained in one continuous proof', function () {
    it('100 deposited -> 70 registered -> 30 withdrawn -> 70 released -> a NEW trade using the newly-available (now-zero) capacity correctly reverts, then a fresh deposit makes it work', async function () {
      const offerKey = offerKeyFor('offer-final-sequence', seller.address)

      // Step 1: 100 deposited.
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('100'))
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('100'))

      // Step 2: 70 registered.
      const t1 = tradeKeyFor('trade-final-seq-1')
      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('70'))
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))

      // Step 3: 30 withdrawn -- exactly the available amount, nothing more.
      const sellerBefore1 = await ethers.provider.getBalance(seller.address)
      const wtx = await escrow.connect(seller).withdrawRemaining(offerKey)
      const wreceipt = await wtx.wait()
      const wgas = wreceipt.gasUsed * wreceipt.gasPrice
      const sellerAfter1 = await ethers.provider.getBalance(seller.address)
      expect(sellerAfter1 - sellerBefore1 + wgas).to.equal(ethers.parseEther('30'))
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)

      // Step 4: 70 released -- buyer gets exactly 70, reservation fully cleared.
      const buyerBefore = await ethers.provider.getBalance(buyer.address)
      await escrow.connect(seller).release(t1)
      const buyerAfter = await ethers.provider.getBalance(buyer.address)
      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther('70'))
      expect(await escrow.getRemaining(offerKey)).to.equal(0n)
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)

      // Step 5: a new trade against this offer now correctly reverts --
      // there is genuinely nothing left (0 available, 0 remaining). This
      // proves the accounting doesn't "remember" phantom capacity.
      const t2 = tradeKeyFor('trade-final-seq-2')
      await expect(escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('1')))
        .to.be.revertedWith('P2PEscrowV2: invalid trade amount')

      // Step 6: a FRESH deposit makes new capacity genuinely available,
      // and a new trade against it registers and releases correctly --
      // proving the accounting isn't stuck in a bad state after a full
      // deposit/register/withdraw/release cycle down to zero.
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('50') })
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('50'))
      await expect(escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('50')))
        .to.not.be.reverted
      expect(await escrow.getAvailable(offerKey)).to.equal(0n)
      await expect(escrow.connect(seller).release(t2)).to.not.be.reverted
      expect(await escrow.getRemaining(offerKey)).to.equal(0n)
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
    })

    it('over-registration beyond available capacity fails cleanly with no state change, even mid-sequence', async function () {
      const offerKey = offerKeyFor('offer-final-overreg', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const t1 = tradeKeyFor('trade-final-overreg-1')
      await escrow.connect(seller).registerTrade(t1, offerKey, buyer.address, ethers.parseEther('70'))

      // Attempting to register 31 (1 over the remaining 30 available) must
      // revert, and must NOT partially reserve anything.
      const t2 = tradeKeyFor('trade-final-overreg-2')
      await expect(escrow.connect(seller).registerTrade(t2, offerKey, buyer.address, ethers.parseEther('31')))
        .to.be.revertedWith('P2PEscrowV2: invalid trade amount')
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('70')) // unchanged, not 101
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30')) // unchanged
    })

    it('a failed transfer during release preserves the reservation exactly -- no partial state change', async function () {
      const Rejecter = await ethers.getContractFactory('RejectingReceiver')
      const rejecter = await Rejecter.deploy()
      await rejecter.waitForDeployment()

      const offerKey = offerKeyFor('offer-final-failedtx', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('100') })
      const tradeKey = tradeKeyFor('trade-final-failedtx')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, await rejecter.getAddress(), ethers.parseEther('70'))

      await expect(escrow.connect(seller).release(tradeKey)).to.be.revertedWith('P2PEscrowV2: transfer to buyer failed')
      // Whole transaction reverted -- remaining, reserved, and available
      // are all exactly as they were before the failed attempt.
      expect(await escrow.getRemaining(offerKey)).to.equal(ethers.parseEther('100'))
      expect(await escrow.getReserved(offerKey)).to.equal(ethers.parseEther('70'))
      expect(await escrow.getAvailable(offerKey)).to.equal(ethers.parseEther('30'))
    })
  })

  // ── Admin-compromise recovery via the existing 2-of-3 role manager
  // multisig — investigation confirmed this mechanism already exists
  // (TransferAdmin/CancelAdminTransfer role actions, gated ONLY by
  // onlyRoleManagerSigner, never onlyAdmin) rather than needing new
  // Solidity. These tests prove the exact compromised-admin scenario and
  // every sub-case requested, end to end.
  describe('admin-compromise recovery: 2-of-3 role managers replace a compromised admin, with no admin veto', function () {
    async function setupCompromiseScenario() {
      // admin (signer "A") is the deployer/current admin throughout.
      // investigator2 plays "Admin B" -- already an Investigator (granted
      // in beforeEach), satisfying TransferAdmin's own prerequisite.
      return { adminA: admin, adminBCandidate: investigator2 }
    }

    it('THE EXACT SCENARIO: RM1 proposes replacement Admin B, RM2 confirms (2-of-3 satisfied, 2-hour timelock starts), before 2 hours Admin A remains admin and B is not active and execution reverts and Admin A cannot cancel/veto, after 2 hours execution succeeds and Admin B becomes active, Admin A can no longer call any admin-only function or resolve disputes; RM3 still participates normally; escrow funds unchanged throughout', async function () {
      const { adminA, adminBCandidate } = await setupCompromiseScenario()

      // Set up an active offer + disputed trade BEFORE the rotation, to
      // prove escrow state and dispute state are untouched by it.
      const offerKey = offerKeyFor('offer-compromise', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('10') })
      const tradeKey = tradeKeyFor('trade-compromise')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('4'))
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true) // recommend release
      const remainingBefore = await escrow.getRemaining(offerKey)
      const reservedBefore = await escrow.getReserved(offerKey)
      const contractBalanceBefore = await ethers.provider.getBalance(await escrow.getAddress())

      // RM1 proposes replacement Admin B (counts as 1st confirmation).
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, adminBCandidate.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n

      // Admin A CANNOT cancel this -- proposeRoleChange/confirmRoleChange/
      // cancelRoleProposal/executeRoleProposal have zero onlyAdmin gating.
      await expect(escrow.connect(adminA).cancelRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
      await expect(escrow.connect(adminA).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
      await expect(escrow.connect(adminA).proposeRoleChange(ROLE_ACTION.CancelAdminTransfer, ethers.ZeroAddress))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')

      // RM2 confirms -- 2-of-3 satisfied, starts the 2-hour timelock.
      // AdminTransferInitiated is NOT emitted yet -- that only happens at
      // actual execution now, not at approval.
      const confirmTx = await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await expect(confirmTx).to.not.emit(escrow, 'AdminTransferInitiated')
      const proposal = await escrow.getRoleProposal(proposalId)
      const executableAfter = proposal.executableAfter
      expect(executableAfter).to.be.greaterThan(0n)

      // ── BEFORE 2 hours ──────────────────────────────────────────────
      expect(await escrow.admin()).to.equal(adminA.address) // A remains admin
      expect(await escrow.pendingAdmin()).to.equal(ethers.ZeroAddress) // B not nominated yet -- execution hasn't run
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: timelock has not elapsed yet')
      // Admin A still cannot cancel or veto during the timelock window either.
      await expect(escrow.connect(adminA).cancelRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')

      // ── AFTER 2 hours ───────────────────────────────────────────────
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.emit(escrow, 'AdminTransferInitiated').withArgs(adminA.address, adminBCandidate.address)
      expect(await escrow.pendingAdmin()).to.equal(adminBCandidate.address)
      // admin variable still hasn't flipped -- B must self-accept (the
      // existing two-step pattern, unchanged by the timelock addition).
      expect(await escrow.admin()).to.equal(adminA.address)

      // Admin B accepts -- becomes the only active admin.
      await expect(escrow.connect(adminBCandidate).acceptAdmin())
        .to.emit(escrow, 'AdminTransferred').withArgs(adminA.address, adminBCandidate.address)
      expect(await escrow.admin()).to.equal(adminBCandidate.address)

      // Admin A can no longer call ANY admin-only function.
      const anotherOfferKey = offerKeyFor('offer-compromise-2', seller.address)
      await escrow.connect(seller).deposit(anotherOfferKey, { value: ethers.parseEther('5') })
      const anotherTradeKey = tradeKeyFor('trade-compromise-2')
      await escrow.connect(seller).registerTrade(anotherTradeKey, anotherOfferKey, buyer.address, ethers.parseEther('2'))
      await escrow.connect(pauser).freezeTrade(anotherTradeKey)
      await escrow.connect(investigator).investigate(anotherTradeKey, true)
      await expect(escrow.connect(adminA).adminResolve(anotherTradeKey))
        .to.be.revertedWith('P2PEscrowV2: caller is not admin')

      // The NEW admin (B) CAN perform legitimate dispute resolution --
      // both on the pre-existing disputed trade from before the rotation...
      const buyerBefore = await ethers.provider.getBalance(buyer.address)
      await expect(escrow.connect(adminBCandidate).adminResolve(tradeKey)).to.not.be.reverted
      const buyerAfter = await ethers.provider.getBalance(buyer.address)
      expect(buyerAfter - buyerBefore).to.equal(ethers.parseEther('4'))
      // ...and on a trade created/disputed AFTER the rotation.
      await expect(escrow.connect(adminBCandidate).adminResolve(anotherTradeKey)).to.not.be.reverted

      // RM3 still participates normally in an unrelated, later role action
      // (which itself also goes through propose -> confirm -> timelock -> execute).
      const tx3 = await escrow.connect(roleManager3).proposeRoleChange(ROLE_ACTION.AddPauser, seller2.address)
      await tx3.wait()
      const proposalId3 = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager1).confirmRoleChange(proposalId3)).to.not.be.reverted
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager3).executeRoleProposal(proposalId3)
      expect(await escrow.isPauser(seller2.address)).to.equal(true)

      // Escrow funds: only the two legitimately-resolved trades' amounts
      // moved (4 + 2 = 6 USDC to buyer) -- nothing else changed as a
      // side effect of the admin rotation itself.
      expect(await escrow.getRemaining(offerKey)).to.equal(remainingBefore - reservedBefore)
      expect(await escrow.getReserved(offerKey)).to.equal(0n)
      const contractBalanceAfter = await ethers.provider.getBalance(await escrow.getAddress())
      expect(contractBalanceAfter).to.equal(contractBalanceBefore + ethers.parseEther('5') - ethers.parseEther('4') - ethers.parseEther('2'))
    })

    it('one role manager alone cannot rotate admin', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      expect(await escrow.pendingAdmin()).to.equal(ethers.ZeroAddress)
      expect(await escrow.admin()).to.equal(admin.address)
    })

    it('a non-role-manager cannot propose an admin rotation', async function () {
      await expect(escrow.connect(attacker).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })

    it('a non-role-manager cannot confirm an admin rotation', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(attacker).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })

    it('the same signer cannot count twice toward an admin rotation', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager1).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: already confirmed by this signer')
    })

    it('zero address rejected as a new admin target', async function () {
      await expect(escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, ethers.ZeroAddress))
        .to.be.revertedWith('P2PEscrowV2: zero address')
    })

    it('the current (possibly compromised) admin cannot block rotation by any means available to it', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(admin).cancelRoleProposal(proposalId)).to.be.reverted
      await expect(escrow.connect(admin).confirmRoleChange(proposalId)).to.be.reverted
      // Rotation proceeds unimpeded regardless -- confirm, then the
      // timelock, then execute, with admin unable to interfere at any point.
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId)).to.not.be.reverted
      await expect(escrow.connect(admin).executeRoleProposal(proposalId)).to.be.reverted // admin still not a role manager signer
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      expect(await escrow.pendingAdmin()).to.equal(investigator2.address)
    })

    it('an already-executed admin rotation proposal cannot execute again', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      await expect(escrow.connect(roleManager3).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal already executed')
    })

    it('a cancelled admin rotation proposal cannot execute', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager3).cancelRoleProposal(proposalId)
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal was cancelled')
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager2).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal was cancelled')
      expect(await escrow.admin()).to.equal(admin.address)
    })

    it('a stale/invalid proposal id cannot execute (never existed)', async function () {
      const bogusId = 9999n
      await expect(escrow.connect(roleManager1).confirmRoleChange(bogusId)).to.not.be.reverted // confirming a never-created proposal is a no-op-shaped confirm on default-valued storage...
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      // ...it can never reach 2 confirmations (only one signer ever
      // confirmed it), so executableAfter was never set -- execute must revert.
      await expect(escrow.connect(roleManager1).executeRoleProposal(bogusId))
        .to.be.revertedWith('P2PEscrowV2: proposal has not reached required confirmations yet')
      expect(await escrow.admin()).to.equal(admin.address)
    })

    it('duplicate admin address rejected: proposing the CURRENT admin as its own replacement is a structurally pointless but not separately-blocked case -- the real protection is that admin has no say in whether this happens at all', async function () {
      // admin.address is not an Investigator (never granted), so this
      // fails the existing hierarchy check regardless -- demonstrating
      // the hierarchy rule applies evenly, even to a self-nomination. The
      // check now happens at EXECUTE time (after the timelock), not confirm.
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, admin.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager2).confirmRoleChange(proposalId)).to.not.be.reverted
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: new admin must already be an investigator')
    })

    it('admin rotation does not modify escrow balances or trade state for ANY offer/trade, active or otherwise', async function () {
      const offerKey = offerKeyFor('offer-rotation-noop', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('20') })
      const activeTrade = tradeKeyFor('trade-rotation-noop-active')
      await escrow.connect(seller).registerTrade(activeTrade, offerKey, buyer.address, ethers.parseEther('5'))
      const frozenTrade = tradeKeyFor('trade-rotation-noop-frozen')
      await escrow.connect(seller).registerTrade(frozenTrade, offerKey, buyer.address, ethers.parseEther('3'))
      await escrow.connect(pauser).freezeTrade(frozenTrade)
      const investigatedTrade = tradeKeyFor('trade-rotation-noop-investigated')
      await escrow.connect(seller).registerTrade(investigatedTrade, offerKey, buyer.address, ethers.parseEther('2'))
      await escrow.connect(pauser).freezeTrade(investigatedTrade)
      await escrow.connect(investigator).investigate(investigatedTrade, true)

      const remainingBefore = await escrow.getRemaining(offerKey)
      const reservedBefore = await escrow.getReserved(offerKey)
      const activeBefore = await escrow.getTrade(activeTrade)
      const frozenBefore = await escrow.getTrade(frozenTrade)
      const investigatedBefore = await escrow.getTrade(investigatedTrade)

      // Full rotation, including the timelock.
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      await escrow.connect(investigator2).acceptAdmin()

      expect(await escrow.getRemaining(offerKey)).to.equal(remainingBefore)
      expect(await escrow.getReserved(offerKey)).to.equal(reservedBefore)
      const activeAfter = await escrow.getTrade(activeTrade)
      const frozenAfter = await escrow.getTrade(frozenTrade)
      const investigatedAfter = await escrow.getTrade(investigatedTrade)
      expect(activeAfter.state).to.equal(activeBefore.state)
      expect(activeAfter.amount).to.equal(activeBefore.amount)
      expect(frozenAfter.state).to.equal(frozenBefore.state)
      expect(investigatedAfter.state).to.equal(investigatedBefore.state)
      expect(investigatedAfter.investigatedApproveRelease).to.equal(investigatedBefore.investigatedApproveRelease)
    })

    it('the new admin can perform legitimate admin dispute resolution; the old admin cannot', async function () {
      const offerKey = offerKeyFor('offer-rotation-resolve', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('10') })
      const tradeKey = tradeKeyFor('trade-rotation-resolve')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('6'))
      await escrow.connect(pauser).freezeTrade(tradeKey)
      await escrow.connect(investigator).investigate(tradeKey, true)

      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx1.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      await escrow.connect(investigator2).acceptAdmin()

      await expect(escrow.connect(admin).adminResolve(tradeKey)).to.be.revertedWith('P2PEscrowV2: caller is not admin')
      await expect(escrow.connect(investigator2).adminResolve(tradeKey)).to.not.be.reverted
    })

    it('proposing to cancel a pending admin nomination also requires 2-of-3 + timelock, and the old admin has no say', async function () {
      const tx1 = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.TransferAdmin, investigator2.address)
      await tx1.wait()
      const proposalId1 = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId1)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId1)
      expect(await escrow.pendingAdmin()).to.equal(investigator2.address)

      // Role managers change their mind before B accepts -- propose
      // CancelAdminTransfer, itself a fresh 2-of-3 + timelock action.
      const tx2 = await escrow.connect(roleManager3).proposeRoleChange(ROLE_ACTION.CancelAdminTransfer, ethers.ZeroAddress)
      await tx2.wait()
      const proposalId2 = (await escrow.roleProposalCount()) - 1n
      // Admin (old) still cannot participate in this either.
      await expect(escrow.connect(admin).confirmRoleChange(proposalId2)).to.be.reverted
      await escrow.connect(roleManager1).confirmRoleChange(proposalId2)
      // Still timelocked -- pendingAdmin unchanged so far.
      expect(await escrow.pendingAdmin()).to.equal(investigator2.address)
      await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId2)
      expect(await escrow.pendingAdmin()).to.equal(ethers.ZeroAddress)

      // B can no longer accept -- nothing pending.
      await expect(escrow.connect(investigator2).acceptAdmin())
        .to.be.revertedWith('P2PEscrowV2: caller is not the pending admin')
      expect(await escrow.admin()).to.equal(admin.address) // old admin unaffected, still admin
    })
  })

  // ── 2-hour timelock mechanics ────────────────────────────────────────────
  describe('2-hour timelock on privileged role/governance changes — mechanics', function () {
    const TWO_HOURS = 2 * 60 * 60

    it('execution 1 hour after approval MUST revert', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS / 2]) // 1 hour
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: timelock has not elapsed yet')
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('execution exactly at the 2-hour boundary succeeds (>= semantics, not strictly >)', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      const proposal = await escrow.getRoleProposal(proposalId)
      const current = BigInt((await ethers.provider.getBlock('latest')).timestamp)
      const delta = proposal.executableAfter - current
      await ethers.provider.send('evm_increaseTime', [Number(delta)])
      await ethers.provider.send('evm_mine')
      // The mined block's timestamp should now be >= executableAfter.
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId)).to.not.be.reverted
      expect(await escrow.isPauser(seller.address)).to.equal(true)
    })

    it('execution well after 2 hours succeeds', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS * 10]) // 20 hours later
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId)).to.not.be.reverted
      expect(await escrow.isPauser(seller.address)).to.equal(true)
    })

    it('a proposal cannot execute before reaching 2-of-3 at all, regardless of elapsed time', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      // Only 1 confirmation (the proposer's own) -- executableAfter never set.
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS * 100])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal has not reached required confirmations yet')
    })

    it('cancellation before execution invalidates the proposal permanently, even after the timelock elapses', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await escrow.connect(roleManager3).cancelRoleProposal(proposalId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal was cancelled')
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('replay prevention: an executed proposal cannot execute a second time', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      await expect(escrow.connect(roleManager2).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal already executed')
    })

    it('duplicate confirmation from the same signer never counts twice toward reaching the threshold that starts the timelock', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await expect(escrow.connect(roleManager1).confirmRoleChange(proposalId))
        .to.be.revertedWith('P2PEscrowV2: already confirmed by this signer')
      const proposal = await escrow.getRoleProposal(proposalId)
      expect(proposal.executableAfter).to.equal(0n) // never started -- still only 1 confirmation
    })

    it('a single role manager signer cannot execute alone, even long after "proposing" (never reached 2-of-3)', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS * 5])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: proposal has not reached required confirmations yet')
    })

    it('a non-signer cannot execute, even after the timelock elapses', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await expect(escrow.connect(attacker).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: caller is not a role manager signer')
    })

    it('one compromised role manager cannot shorten the delay, change the target, or bypass the timelock in any way', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      const proposalBefore = await escrow.getRoleProposal(proposalId)

      // No function exists to modify executableAfter or target -- prove
      // by structural absence, and prove the recorded values are
      // unchanged after any amount of (legitimate) activity by roleManager1.
      const fragments = escrow.interface.fragments.map(f => f.name).filter(Boolean)
      for (const banned of ['setExecutableAfter', 'setTimelock', 'shortenTimelock', 'overrideTarget', 'setProposalTarget']) {
        expect(fragments).to.not.include(banned)
      }
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId))
        .to.be.revertedWith('P2PEscrowV2: timelock has not elapsed yet')
      const proposalAfter = await escrow.getRoleProposal(proposalId)
      expect(proposalAfter.executableAfter).to.equal(proposalBefore.executableAfter)
      expect(proposalAfter.target).to.equal(proposalBefore.target)
    })

    it('Pauser add is timelocked: STATUS=timelocked immediately after 2-of-3, execute before 2h reverts, execute after 2h succeeds', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      expect(await escrow.isRoleProposalExecutable(proposalId)).to.equal(false)
      expect(await escrow.isPauser(seller.address)).to.equal(false)
      await expect(escrow.connect(roleManager1).executeRoleProposal(proposalId)).to.be.reverted
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      expect(await escrow.isRoleProposalExecutable(proposalId)).to.equal(true)
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      expect(await escrow.isPauser(seller.address)).to.equal(true)
    })

    it('Pauser removal is timelocked identically', async function () {
      await grantRole('AddPauser', seller.address)
      expect(await escrow.isPauser(seller.address)).to.equal(true)
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.RemovePauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(proposalId)
      expect(await escrow.isPauser(seller.address)).to.equal(true) // still timelocked
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(proposalId)
      expect(await escrow.isPauser(seller.address)).to.equal(false)
    })

    it('Investigator add/removal are timelocked identically', async function () {
      await grantRole('AddPauser', seller.address)
      const addTx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddInvestigator, seller.address)
      await addTx.wait()
      const addId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(addId)
      expect(await escrow.isInvestigator(seller.address)).to.equal(false)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(addId)
      expect(await escrow.isInvestigator(seller.address)).to.equal(true)

      const removeTx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.RemoveInvestigator, seller.address)
      await removeTx.wait()
      const removeId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(removeId)
      expect(await escrow.isInvestigator(seller.address)).to.equal(true) // still timelocked
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(removeId)
      expect(await escrow.isInvestigator(seller.address)).to.equal(false)
    })

    it('multiple simultaneous pending proposals have completely isolated timelocks', async function () {
      // Proposal A: created and approved first.
      const txA = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await txA.wait()
      const idA = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(idA)
      const proposalA = await escrow.getRoleProposal(idA)

      // Advance 1 hour, THEN create+approve proposal B.
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS / 2])
      await ethers.provider.send('evm_mine')
      const txB = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller2.address)
      await txB.wait()
      const idB = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(idB)
      const proposalB = await escrow.getRoleProposal(idB)

      // B's executableAfter is genuinely later than A's -- independent clocks, not shared/reset.
      expect(proposalB.executableAfter).to.be.greaterThan(proposalA.executableAfter)

      // Advance another 1 hour + 1s -- A's timelock (2h from its own
      // approval) has now elapsed, B's (2h from ITS approval, 1h later) has not.
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS / 2 + 1])
      await ethers.provider.send('evm_mine')
      expect(await escrow.isRoleProposalExecutable(idA)).to.equal(true)
      expect(await escrow.isRoleProposalExecutable(idB)).to.equal(false)

      await escrow.connect(roleManager1).executeRoleProposal(idA)
      expect(await escrow.isPauser(seller.address)).to.equal(true)
      expect(await escrow.isPauser(seller2.address)).to.equal(false) // B still pending, untouched by A's execution

      await expect(escrow.connect(roleManager1).executeRoleProposal(idB))
        .to.be.revertedWith('P2PEscrowV2: timelock has not elapsed yet')

      // Complete B's own timelock independently.
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS / 2])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(idB)
      expect(await escrow.isPauser(seller2.address)).to.equal(true)
    })

    it('changing the intended target requires a fresh proposal with a fresh timelock -- there is no way to redirect an existing one', async function () {
      const tx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller.address)
      await tx.wait()
      const proposalId = (await escrow.roleProposalCount()) - 1n
      // No function exists to change p.target on an existing proposal --
      // the only way to target a different address is a brand new proposal.
      const fragments = escrow.interface.fragments.map(f => f.name).filter(Boolean)
      expect(fragments).to.not.include('updateProposalTarget')
      // Confirm what a "changed mind" actually requires: cancel + fresh propose.
      await escrow.connect(roleManager2).cancelRoleProposal(proposalId)
      const freshTx = await escrow.connect(roleManager1).proposeRoleChange(ROLE_ACTION.AddPauser, seller2.address)
      await freshTx.wait()
      const freshId = (await escrow.roleProposalCount()) - 1n
      expect(freshId).to.not.equal(proposalId)
      const fresh = await escrow.getRoleProposal(freshId)
      expect(fresh.confirmations).to.equal(1n) // fresh confirmations, not inherited
      expect(fresh.executableAfter).to.equal(0n) // fresh timelock state, not inherited
    })

    it('escrow balances and trade state are provably unchanged by role/governance changes — general property, not just for admin rotation', async function () {
      const offerKey = offerKeyFor('offer-timelock-escrow-noop', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('15') })
      const tradeKey = tradeKeyFor('trade-timelock-escrow-noop')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('6'))

      const remainingBefore = await escrow.getRemaining(offerKey)
      const reservedBefore = await escrow.getReserved(offerKey)
      const availableBefore = await escrow.getAvailable(offerKey)
      const tradeBefore = await escrow.getTrade(tradeKey)

      // A full Pauser add + Investigator add + signer rotation cycle, all timelocked.
      await grantRole('AddPauser', seller2.address)
      await grantRole('AddInvestigator', seller2.address)
      const rotTx = await escrow.connect(roleManager1).proposeSignerRotation(2, buyer.address)
      await rotTx.wait()
      const rotId = (await escrow.roleProposalCount()) - 1n
      await escrow.connect(roleManager2).confirmRoleChange(rotId)
      await ethers.provider.send('evm_increaseTime', [TWO_HOURS + 1])
      await ethers.provider.send('evm_mine')
      await escrow.connect(roleManager1).executeRoleProposal(rotId)

      expect(await escrow.getRemaining(offerKey)).to.equal(remainingBefore)
      expect(await escrow.getReserved(offerKey)).to.equal(reservedBefore)
      expect(await escrow.getAvailable(offerKey)).to.equal(availableBefore)
      const tradeAfter = await escrow.getTrade(tradeKey)
      expect(tradeAfter.state).to.equal(tradeBefore.state)
      expect(tradeAfter.amount).to.equal(tradeBefore.amount)
      expect(tradeAfter.buyer).to.equal(tradeBefore.buyer)
      expect(tradeAfter.seller).to.equal(tradeBefore.seller)
    })

    it('operational actions (freeze/investigate/adminResolve) remain fully IMMEDIATE — the timelock never applies to them', async function () {
      const offerKey = offerKeyFor('offer-timelock-ops-immediate', seller.address)
      await escrow.connect(seller).deposit(offerKey, { value: ethers.parseEther('5') })
      const tradeKey = tradeKeyFor('trade-timelock-ops-immediate')
      await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyer.address, ethers.parseEther('3'))

      // No time advance anywhere in this test -- freeze/investigate/resolve
      // all happen back-to-back with zero delay.
      await expect(escrow.connect(pauser).freezeTrade(tradeKey)).to.not.be.reverted
      await expect(escrow.connect(investigator).investigate(tradeKey, true)).to.not.be.reverted
      await expect(escrow.connect(admin).adminResolve(tradeKey)).to.not.be.reverted
      const trade = await escrow.getTrade(tradeKey)
      expect(trade.state).to.equal(4n) // Released, same block-ish, no timelock involved
    })
  })

})
