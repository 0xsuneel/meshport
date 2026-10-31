// test/MeshPortRouter.tokens.test.js
//
// MeshPortRouter, EURC / cirBTC (CCTPx): Bring through MeshPort's relayer. The
// user signs once; the relayer submits and pays the gas and Circle's CCTPx
// fee (msg.value); MeshPort's fee comes out of the token. Same core property
// as the USDC router: the submitter can run exactly what the user signed and
// nothing else. EIP-3009 path against MockUSDC3009 (EURC is a FiatToken),
// permit path against MockPermitToken.

const { expect } = require('chai')
const hre = require('hardhat')
const { ethers } = hre

const ARC_DOMAIN = 26
const EURC_ID = '0x2587821a0ee7daa174b95436b5dab1731cfa1844775b010217d3c0dd02a4eecd'
const BTC_ID = '0x7c27b7b6485f3ea49b7d1a439e288d3c3116f533302afabb7e372dfc0770cc7d'
const QUOTE = '0x1234'
const u6 = (n) => ethers.parseUnits(String(n), 6)
const u8 = (n) => ethers.parseUnits(String(n), 8)
const NATIVE_FEE = ethers.parseEther('0.001')

describe('MeshPortRouter: EURC / cirBTC', () => {
  let eurc, btc, service, router, user, relayer, feeWallet, stranger

  beforeEach(async () => {
    ;[user, relayer, feeWallet, stranger] = await ethers.getSigners()
    eurc = await (await ethers.getContractFactory('MockUSDC3009')).deploy()
    btc = await (await ethers.getContractFactory('MockPermitToken')).deploy()
    service = await (await ethers.getContractFactory('MockCrossChainTokenService')).deploy()
    await service.register(EURC_ID, await eurc.getAddress())
    await service.register(BTC_ID, await btc.getAddress())
    await service.setNativeFee(NATIVE_FEE)
    const messenger = await (await ethers.getContractFactory('MockTokenMessengerV2')).deploy()
    router = await (await ethers.getContractFactory('MeshPortRouter')).deploy(await messenger.getAddress(), await service.getAddress(), feeWallet.address)
    await eurc.mint(user.address, u6(1000))
    await btc.mint(user.address, u8(1))
  })

  const bridgeFor = async (overrides = {}) => ({
    token: await eurc.getAddress(),
    tokenId: EURC_ID,
    destinationDomain: ARC_DOMAIN,
    recipient: user.address,
    fee: u6('0.3'),
    minFinalityThreshold: 1000,
    salt: ethers.hexlify(ethers.randomBytes(32)),
    ...overrides,
  })
  const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp)
  const chainId = async () => (await ethers.provider.getNetwork()).chainId

  // EIP-3009: ReceiveWithAuthorization with nonce = bridgeNonce(b).
  async function sign3009(b, { value = u6('100.3'), signer = user, nonce } = {}) {
    const vb = (await now()) + 3600n
    const n = nonce ?? (await router.tokenBridgeNonce(b))
    const sig = ethers.Signature.from(await signer.signTypedData(
      { name: 'USD Coin', version: '2', chainId: await chainId(), verifyingContract: await eurc.getAddress() },
      { ReceiveWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      { from: signer.address, to: await router.getAddress(), value, validAfter: 0n, validBefore: vb, nonce: n },
    ))
    return { from: signer.address, value, validAfter: 0n, validBefore: vb, v: sig.v, r: sig.r, s: sig.s }
  }

  // Permit path: EIP-2612 permit to the router + BridgePermit over bridgeNonce(b).
  async function signPermit(b, { value = u8('0.5'), signer = user, nonce } = {}) {
    const deadline = (await now()) + 3600n
    const p = ethers.Signature.from(await signer.signTypedData(
      { name: 'Circle Bitcoin', version: '1', chainId: await chainId(), verifyingContract: await btc.getAddress() },
      { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] },
      { owner: signer.address, spender: await router.getAddress(), value, nonce: await btc.nonces(signer.address), deadline },
    ))
    const bs = ethers.Signature.from(await signer.signTypedData(
      { name: 'MeshPortRouter', version: '1', chainId: await chainId(), verifyingContract: await router.getAddress() },
      { BridgePermit: [
        { name: 'from', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      { from: signer.address, value, deadline, nonce: nonce ?? (await router.tokenBridgeNonce(b)) },
    ))
    return { from: signer.address, value, deadline, v: p.v, r: p.r, s: p.s, bv: bs.v, br: bs.r, bs: bs.s }
  }

  describe('EIP-3009 (EURC)', () => {
    it('one transaction: pulls amount + fee, pays MeshPort, sends the rest to the user on Arc; the relayer pays Circle', async () => {
      const b = await bridgeFor()
      const a = await sign3009(b)
      const nonce = await router.tokenBridgeNonce(b)
      await expect(router.connect(relayer).tokenBridgeWithAuthorization(b, a, QUOTE, { value: NATIVE_FEE }))
        .to.emit(router, 'TokenBridged')
        .withArgs(user.address, nonce, await eurc.getAddress(), ARC_DOMAIN, user.address, u6(100), u6('0.3'))

      expect(await eurc.balanceOf(user.address)).to.equal(u6('899.7'))
      expect(await eurc.balanceOf(feeWallet.address)).to.equal(u6('0.3'))
      expect(await eurc.balanceOf(await service.getAddress())).to.equal(u6(100))
      const last = await service.last()
      expect(last.tokenId).to.equal(EURC_ID)
      expect(last.amount).to.equal(u6(100))
      expect(last.destinationDomain).to.equal(ARC_DOMAIN)
      expect(last.destinationAddress).to.equal(user.address.toLowerCase())
      expect(last.destinationCaller).to.equal(ethers.ZeroHash)
      expect(last.minFinalityThreshold).to.equal(1000)
      expect(last.signedQuote).to.equal(QUOTE)
      expect(last.refundAddress).to.equal(relayer.address)
      expect(last.value).to.equal(NATIVE_FEE)
      expect(last.autoExecuteHookData).to.equal(false)
      expect(last.hookData).to.equal('0x')
    })

    it('keeps no tokens, allowance or native currency', async () => {
      const b = await bridgeFor()
      await router.connect(relayer).tokenBridgeWithAuthorization(b, await sign3009(b), QUOTE, { value: NATIVE_FEE })
      const r = await router.getAddress()
      expect(await eurc.balanceOf(r)).to.equal(0n)
      expect(await eurc.allowance(r, await service.getAddress())).to.equal(0n)
      expect(await ethers.provider.getBalance(r)).to.equal(0n)
    })

    for (const [what, change] of [
      ['recipient', { recipient: null }],
      ['fee', { fee: u6('5') }],
      ['destination', { destinationDomain: 0 }],
      ['token id', { tokenId: BTC_ID }],
      ['finality', { minFinalityThreshold: 2000 }],
    ]) {
      it(`a changed ${what} fails the user's signature`, async () => {
        const b = await bridgeFor()
        const a = await sign3009(b)
        const changed = { ...b, ...change, ...(change.recipient === null ? { recipient: stranger.address } : {}) }
        await expect(router.connect(relayer).tokenBridgeWithAuthorization(changed, a, QUOTE, { value: NATIVE_FEE }))
          .to.be.revertedWith('FiatTokenV2: invalid signature')
      })
    }

    it('each authorization works once', async () => {
      const b = await bridgeFor()
      const a = await sign3009(b)
      await router.connect(relayer).tokenBridgeWithAuthorization(b, a, QUOTE, { value: NATIVE_FEE })
      await expect(router.connect(relayer).tokenBridgeWithAuthorization(b, a, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWith('FiatTokenV2: authorization is used or canceled')
    })

    it("without Circle's native fee nothing moves", async () => {
      const b = await bridgeFor()
      await expect(router.connect(relayer).tokenBridgeWithAuthorization(b, await sign3009(b), QUOTE)).to.be.revertedWith('fee')
      expect(await eurc.balanceOf(user.address)).to.equal(u6(1000))
    })

    it('rejects a fee of the whole value, a zero recipient and a zero token', async () => {
      const b = await bridgeFor({ fee: u6('100.3') })
      await expect(router.tokenBridgeWithAuthorization(b, await sign3009(b), QUOTE, { value: NATIVE_FEE })).to.be.revertedWithCustomError(router, 'FeeTooHigh')
      const z = await bridgeFor({ recipient: ethers.ZeroAddress })
      await expect(router.tokenBridgeWithAuthorization(z, await sign3009(z), QUOTE, { value: NATIVE_FEE })).to.be.revertedWithCustomError(router, 'ZeroRecipient')
      const t = await bridgeFor({ token: ethers.ZeroAddress })
      await expect(router.tokenBridgeWithAuthorization(t, await sign3009(t), QUOTE, { value: NATIVE_FEE })).to.be.revertedWithCustomError(router, 'ZeroToken')
    })

    it('tokens sent to the router by mistake do not block it', async () => {
      await eurc.mint(await router.getAddress(), u6(1))
      const b = await bridgeFor()
      await expect(router.connect(relayer).tokenBridgeWithAuthorization(b, await sign3009(b), QUOTE, { value: NATIVE_FEE })).to.emit(router, 'TokenBridged')
    })

    it('refuses plain native transfers', async () => {
      await expect(relayer.sendTransaction({ to: await router.getAddress(), value: 1n })).to.be.reverted
    })
  })

  describe('permit (cirBTC)', () => {
    const btcBridge = async (o = {}) => bridgeFor({ token: await btc.getAddress(), tokenId: BTC_ID, fee: u8('0.0001'), ...o })

    it('pulls with the permit, pays MeshPort, sends the rest', async () => {
      const b = await btcBridge()
      const p = await signPermit(b)
      await expect(router.connect(relayer).tokenBridgeWithPermit(b, p, QUOTE, { value: NATIVE_FEE })).to.emit(router, 'TokenBridged')
      expect(await btc.balanceOf(user.address)).to.equal(u8('0.5'))
      expect(await btc.balanceOf(feeWallet.address)).to.equal(u8('0.0001'))
      expect(await btc.balanceOf(await service.getAddress())).to.equal(u8('0.4999'))
      expect(await btc.balanceOf(await router.getAddress())).to.equal(0n)
    })

    it('a changed parameter fails the bridge signature', async () => {
      const b = await btcBridge()
      const p = await signPermit(b)
      await expect(router.connect(relayer).tokenBridgeWithPermit({ ...b, recipient: stranger.address }, p, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWithCustomError(router, 'BadSignature')
      await expect(router.connect(relayer).tokenBridgeWithPermit({ ...b, fee: u8('0.1') }, p, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWithCustomError(router, 'BadSignature')
    })

    it('works once, and still works when someone submitted the permit first', async () => {
      const b = await btcBridge()
      const p = await signPermit(b)
      await btc.connect(stranger).permit(p.from, await router.getAddress(), p.value, p.deadline, p.v, p.r, p.s)
      await router.connect(relayer).tokenBridgeWithPermit(b, p, QUOTE, { value: NATIVE_FEE })
      await expect(router.connect(relayer).tokenBridgeWithPermit(b, p, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWithCustomError(router, 'NonceUsed')
    })

    it('a signature from someone else is refused', async () => {
      const b = await btcBridge()
      const p = await signPermit(b, { signer: stranger })
      await expect(router.connect(relayer).tokenBridgeWithPermit(b, { ...p, from: user.address }, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWithCustomError(router, 'BadSignature')
    })

    it('an expired deadline is refused', async () => {
      const b = await btcBridge()
      const p = await signPermit(b)
      await ethers.provider.send('evm_increaseTime', [7200])
      await expect(router.connect(relayer).tokenBridgeWithPermit(b, p, QUOTE, { value: NATIVE_FEE }))
        .to.be.revertedWithCustomError(router, 'Expired')
    })
  })
})


// src/lib/gaslessToken.test.ts checks the app computes this same nonce.
describe('MeshPortRouter tokenBridgeNonce (shared with the app)', () => {
  it('bridgeNonce for fixed parameters', async () => {
    await hre.network.provider.send('hardhat_reset')
    const [deployer, fee] = await ethers.getSigners()
    const router = await (await ethers.getContractFactory('MeshPortRouter', deployer)).deploy(fee.address, fee.address, fee.address)
    expect(await router.getAddress()).to.equal('0x5FbDB2315678afecb367f032d93F642f64180aa3')
    const nonce = await router.tokenBridgeNonce({
      token: '0x1111111111111111111111111111111111111111', tokenId: EURC_ID, destinationDomain: ARC_DOMAIN,
      recipient: '0x2222222222222222222222222222222222222222', fee: 300000n, minFinalityThreshold: 1000,
      salt: '0x' + 'ab'.repeat(32),
    })
    expect(nonce).to.equal('0x7b5a933e299b687d3456f46cd911d7cd8d100082cfc093976bbcc83b7c99772d')
  })
})
