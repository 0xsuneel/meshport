// test/MeshPortBridgeRouter.test.js
//
// MeshPortBridgeRouter: one signature from the user → pull, fee and CCTP burn
// in a single transaction. The core property under test: whoever submits the
// transaction (normally MeshPort's relayer) can execute exactly what the user
// signed and nothing else — any changed parameter fails USDC's real EIP-712
// signature check (MockUSDC3009 follows FiatTokenV2's rules).

const { expect } = require('chai')
const hre = require('hardhat')
const { ethers } = hre

const ARC_DOMAIN = 26
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
const usdc6 = (n) => ethers.parseUnits(String(n), 6)
const pad32 = (addr) => ethers.zeroPadValue(addr, 32)

describe('MeshPortBridgeRouter', () => {
  let usdc, messenger, router, user, relayer, feeWallet, stranger

  beforeEach(async () => {
    ;[user, relayer, feeWallet, stranger] = await ethers.getSigners()
    usdc = await (await ethers.getContractFactory('MockUSDC3009')).deploy()
    messenger = await (await ethers.getContractFactory('MockTokenMessengerV2')).deploy()
    router = await (await ethers.getContractFactory('MeshPortBridgeRouter'))
      .deploy(await messenger.getAddress(), feeWallet.address)
    await usdc.mint(user.address, usdc6(1000))
  })

  // The bridge parameters a user would sign for: 100 USDC + 0.25 fee to Arc via the forwarder.
  let usdcAddr
  beforeEach(async () => { usdcAddr = await usdc.getAddress() })
  const bridgeFor = (overrides = {}) => ({
    token: usdcAddr,
    destinationDomain: ARC_DOMAIN,
    mintRecipient: pad32(user.address),
    fee: usdc6('0.25'),
    maxFee: usdc6('0.2'),
    minFinalityThreshold: 1000,
    hookData: FORWARD_HOOK,
    salt: ethers.hexlify(ethers.randomBytes(32)),
    ...overrides,
  })

  // Off-chain: what the app does — compute the nonce, sign ReceiveWithAuthorization.
  async function sign(b, { value = usdc6('100.25'), signer = user, validAfter = 0n, validBefore, nonce } = {}) {
    const now = BigInt((await ethers.provider.getBlock('latest')).timestamp)
    const vb = validBefore ?? now + 3600n
    const n = nonce ?? (await router.bridgeNonce(b))
    const sig = ethers.Signature.from(await signer.signTypedData(
      { name: 'USD Coin', version: '2', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await usdc.getAddress() },
      { ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      { from: signer.address, to: await router.getAddress(), value, validAfter, validBefore: vb, nonce: n },
    ))
    return { from: signer.address, value, validAfter, validBefore: vb, v: sig.v, r: sig.r, s: sig.s }
  }

  it('one transaction: pulls amount + fee, pays the fee, burns the rest to the recipient on Arc via the forwarder', async () => {
    const b = bridgeFor()
    const a = await sign(b)
    const nonce = await router.bridgeNonce(b)
    await expect(router.connect(relayer).bridgeWithAuthorization(b, a))
      .to.emit(router, 'Bridged')
      .withArgs(user.address, nonce, ARC_DOMAIN, pad32(user.address), usdc6(100), usdc6('0.25'), usdc6('0.2'))

    expect(await usdc.balanceOf(user.address)).to.equal(usdc6('899.75'))
    expect(await usdc.balanceOf(feeWallet.address)).to.equal(usdc6('0.25'))
    expect(await usdc.balanceOf(await messenger.getAddress())).to.equal(usdc6(100))
    const last = await messenger.last()
    expect(last.amount).to.equal(usdc6(100))
    expect(last.destinationDomain).to.equal(ARC_DOMAIN)
    expect(last.mintRecipient).to.equal(pad32(user.address))
    expect(last.burnToken).to.equal(await usdc.getAddress())
    expect(last.destinationCaller).to.equal(ethers.ZeroHash) // anyone (Circle's forwarder) may mint
    expect(last.maxFee).to.equal(usdc6('0.2'))
    expect(last.minFinalityThreshold).to.equal(1000)
    expect(last.withHook).to.equal(true)
    expect(last.hookData).to.equal(FORWARD_HOOK)
  })

  it('never keeps funds or allowance afterwards', async () => {
    const b = bridgeFor()
    await router.connect(relayer).bridgeWithAuthorization(b, await sign(b))
    const r = await router.getAddress()
    expect(await usdc.balanceOf(r)).to.equal(0n)
    expect(await usdc.allowance(r, await messenger.getAddress())).to.equal(0n)
  })

  it('without hook data it uses plain depositForBurn', async () => {
    const b = bridgeFor({ hookData: '0x' })
    await router.connect(relayer).bridgeWithAuthorization(b, await sign(b))
    expect((await messenger.last()).withHook).to.equal(false)
  })

  it('the user can submit it themselves too (no special relayer role)', async () => {
    const b = bridgeFor()
    await router.connect(user).bridgeWithAuthorization(b, await sign(b))
    expect(await messenger.calls()).to.equal(1n)
  })

  describe('the submitter cannot change what the user signed', () => {
    const tamper = {
      'recipient': (b) => ({ ...b, mintRecipient: pad32('0x000000000000000000000000000000000000dEaD') }),
      'fee (higher)': (b) => ({ ...b, fee: usdc6(5) }),
      'fee (lower)': (b) => ({ ...b, fee: 0n }),
      'CCTP maxFee': (b) => ({ ...b, maxFee: usdc6(1) }),
      'destination domain': (b) => ({ ...b, destinationDomain: 6 }),
      'finality': (b) => ({ ...b, minFinalityThreshold: 2000 }),
      'hook data': (b) => ({ ...b, hookData: '0x' }),
      'salt': (b) => ({ ...b, salt: ethers.ZeroHash }),
      'token': (b) => ({ ...b, token: '0x000000000000000000000000000000000000bEEF' }),
    }
    for (const [what, change] of Object.entries(tamper)) {
      it(`changing the ${what} is rejected and nothing moves`, async () => {
        const b = bridgeFor()
        const a = await sign(b)
        // A different token isn't USDC at all, so the call reverts there instead.
        const call = router.connect(relayer).bridgeWithAuthorization(change(b), a)
        if (what === 'token') await expect(call).to.be.reverted
        else await expect(call).to.be.revertedWith('FiatTokenV2: invalid signature')
        expect(await usdc.balanceOf(user.address)).to.equal(usdc6(1000))
        expect(await messenger.calls()).to.equal(0n)
      })
    }

    it('changing the value is rejected', async () => {
      const b = bridgeFor()
      const a = await sign(b)
      await expect(router.connect(relayer).bridgeWithAuthorization(b, { ...a, value: usdc6(500) }))
        .to.be.revertedWith('FiatTokenV2: invalid signature')
    })

    it('a lookalike token cannot use the user’s signature (EIP-712 domain is per token)', async () => {
      const fake = await (await ethers.getContractFactory('MockUSDC3009')).deploy()
      await fake.mint(user.address, usdc6(1000))
      const b = bridgeFor()
      const a = await sign(b) // signed for the real USDC
      await expect(router.connect(relayer).bridgeWithAuthorization({ ...b, token: await fake.getAddress() }, a))
        .to.be.revertedWith('FiatTokenV2: invalid signature')
      expect(await usdc.balanceOf(user.address)).to.equal(usdc6(1000))
      expect(await fake.balanceOf(user.address)).to.equal(usdc6(1000))
    })

    it('a signature from someone else cannot spend the user’s USDC', async () => {
      const b = bridgeFor()
      const a = await sign(b, { signer: stranger })
      await expect(router.connect(relayer).bridgeWithAuthorization(b, { ...a, from: user.address }))
        .to.be.revertedWith('FiatTokenV2: invalid signature')
    })

    it('an authorization with a nonce not derived from the parameters is useless', async () => {
      const b = bridgeFor()
      const a = await sign(b, { nonce: ethers.hexlify(ethers.randomBytes(32)) })
      await expect(router.connect(relayer).bridgeWithAuthorization(b, a))
        .to.be.revertedWith('FiatTokenV2: invalid signature')
    })
  })

  it('an authorization works only once (replay rejected)', async () => {
    const b = bridgeFor()
    const a = await sign(b)
    await router.connect(relayer).bridgeWithAuthorization(b, a)
    await expect(router.connect(relayer).bridgeWithAuthorization(b, a))
      .to.be.revertedWith('FiatTokenV2: authorization is used or canceled')
  })

  it('an expired authorization is rejected', async () => {
    const b = bridgeFor()
    const now = BigInt((await ethers.provider.getBlock('latest')).timestamp)
    const a = await sign(b, { validBefore: now })
    await expect(router.connect(relayer).bridgeWithAuthorization(b, a))
      .to.be.revertedWith('FiatTokenV2: authorization is expired')
  })

  it('the authorization cannot be used directly on USDC by someone else (caller must be the router)', async () => {
    const b = bridgeFor()
    const a = await sign(b)
    await expect(usdc.connect(relayer).receiveWithAuthorization(
      a.from, await router.getAddress(), a.value, a.validAfter, a.validBefore, await router.bridgeNonce(b), a.v, a.r, a.s,
    )).to.be.revertedWith('FiatTokenV2: caller must be the payee')
  })

  describe('parameter checks', () => {
    it('fee must be below the signed value', async () => {
      const b = bridgeFor({ fee: usdc6('100.25') })
      await expect(router.bridgeWithAuthorization(b, await sign(b))).to.be.revertedWithCustomError(router, 'FeeTooHigh')
    })
    it('CCTP maxFee must be below the burned amount', async () => {
      const b = bridgeFor({ maxFee: usdc6(100) })
      await expect(router.bridgeWithAuthorization(b, await sign(b))).to.be.revertedWithCustomError(router, 'MaxFeeTooHigh')
    })
    it('token must be set', async () => {
      const b = bridgeFor({ token: ethers.ZeroAddress })
      await expect(router.bridgeWithAuthorization(b, await sign(b))).to.be.revertedWithCustomError(router, 'ZeroToken')
    })
    it('recipient must be set', async () => {
      const b = bridgeFor({ mintRecipient: ethers.ZeroHash })
      await expect(router.bridgeWithAuthorization(b, await sign(b))).to.be.revertedWithCustomError(router, 'ZeroRecipient')
    })
    it('constructor rejects zero addresses', async () => {
      const F = await ethers.getContractFactory('MeshPortBridgeRouter')
      await expect(F.deploy(ethers.ZeroAddress, feeWallet.address)).to.be.revertedWithCustomError(router, 'ZeroAddress')
      await expect(F.deploy(await messenger.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(router, 'ZeroAddress')
    })
  })

  it('accepts a signature made the way the app makes it (viem) and split the way the relayer splits it', async () => {
    const { privateKeyToAccount } = require('viem/accounts')
    const { parseSignature } = require('viem')
    // Hardhat's well-known account #0 key — the `user` signer in these tests.
    const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
    expect(account.address).to.equal(user.address)
    const b = bridgeFor()
    const nonce = await router.bridgeNonce(b)
    const now = BigInt((await ethers.provider.getBlock('latest')).timestamp)
    const value = usdc6('100.25'), validBefore = now + 3600n
    const signature = await account.signTypedData({
      domain: { name: await usdc.name(), version: await usdc.version(), chainId: Number((await ethers.provider.getNetwork()).chainId), verifyingContract: await usdc.getAddress() },
      types: { ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      primaryType: 'ReceiveWithAuthorization',
      message: { from: account.address, to: await router.getAddress(), value, validAfter: 0n, validBefore, nonce },
    })
    const sig = parseSignature(signature)
    const v = sig.v !== undefined ? Number(sig.v) : 27 + (sig.yParity ?? 0)
    await router.connect(relayer).bridgeWithAuthorization(b, { from: account.address, value, validAfter: 0n, validBefore, v, r: sig.r, s: sig.s })
    expect(await usdc.balanceOf(feeWallet.address)).to.equal(usdc6('0.25'))
    expect((await messenger.last()).amount).to.equal(usdc6(100))
  })

  describe('same address on every chain (CREATE2)', () => {
    const { CREATE2_DEPLOYER, SALT, initCode, predictRouterAddress } = require('../contracts/bridge-router-create2.cjs')
    // Runtime code of the standard deterministic deployment proxy (Arachnid's CREATE2 deployer).
    const DEPLOYER_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'

    it('the committed bytecode is exactly what this source compiles to', async () => {
      const artifact = await hre.artifacts.readArtifact('MeshPortBridgeRouter')
      expect(require('../contracts/MeshPortBridgeRouter.bytecode.json').bytecode).to.equal(artifact.bytecode)
    })

    it('deploying the committed bytecode through the CREATE2 deployer lands on the predicted address', async () => {
      await ethers.provider.send('hardhat_setCode', [CREATE2_DEPLOYER, DEPLOYER_RUNTIME])
      const messengerAddr = await messenger.getAddress()
      const predicted = predictRouterAddress(feeWallet.address, messengerAddr)
      expect(await ethers.provider.getCode(predicted)).to.equal('0x')
      await (await relayer.sendTransaction({ to: CREATE2_DEPLOYER, data: ethers.concat([SALT, initCode(messengerAddr, feeWallet.address)]) })).wait()
      expect(await ethers.provider.getCode(predicted)).to.not.equal('0x')
      const deployed = await ethers.getContractAt('MeshPortBridgeRouter', predicted)
      expect(await deployed.feeRecipient()).to.equal(feeWallet.address)
      expect(await deployed.tokenMessenger()).to.equal(messengerAddr)
      // And it works: a real bridge through the CREATE2-deployed router.
      router = deployed
      const b = bridgeFor()
      await router.connect(relayer).bridgeWithAuthorization(b, await sign(b))
      expect((await messenger.last()).amount).to.equal(usdc6(100))
    })
  })

  it('bridgeNonce matches the off-chain computation the app will use', async () => {
    const b = bridgeFor()
    const chainId = (await ethers.provider.getNetwork()).chainId
    const typehash = ethers.id('MeshPortBridge(uint256 chainId,address router,address token,uint32 destinationDomain,bytes32 mintRecipient,uint256 fee,uint256 maxFee,uint32 minFinalityThreshold,bytes32 hookDataHash,bytes32 salt)')
    const offchain = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'address', 'uint32', 'bytes32', 'uint256', 'uint256', 'uint32', 'bytes32', 'bytes32'],
      [typehash, chainId, await router.getAddress(), b.token, b.destinationDomain, b.mintRecipient, b.fee, b.maxFee, b.minFinalityThreshold, ethers.keccak256(b.hookData), b.salt],
    ))
    expect(await router.bridgeNonce(b)).to.equal(offchain)
    expect(await router.BRIDGE_TYPEHASH()).to.equal(typehash)
  })
})
