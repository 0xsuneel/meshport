// test/MeshPortRouter.express.test.js
//
// Express Bring: once the owner set a Bring key (their signature) and gave the
// router a USDC allowance, that key alone can ask for Brings - but ONLY to the
// owner's own address on Arc, with MeshPort's fee capped, each signature once.

const { expect } = require('chai')
const hre = require('hardhat')
const { ethers } = hre

const ARC_DOMAIN = 26
const FORWARD_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000'
const usdc6 = (n) => ethers.parseUnits(String(n), 6)

describe('MeshPortRouter: Express Bring', () => {
  let usdc, messenger, service, router, owner, relayer, feeWallet, stranger, key, domain

  const setKeyTypes = { SetBringKey: [
    { name: 'owner', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ] }
  const bringTypes = { ExpressBring: [
    { name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' },
    { name: 'fee', type: 'uint256' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'hookDataHash', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
  ] }
  const now = async () => (await ethers.provider.getBlock('latest')).timestamp

  async function setKey(signer = owner, k = key.address, expiry) {
    const exp = expiry ?? (await now()) + 30 * 86400
    const nonce = await router.bringKeyNonces(owner.address)
    const sig = await signer.signTypedData(domain, setKeyTypes, { owner: owner.address, key: k, expiry: exp, nonce })
    return router.connect(relayer).setBringKey(owner.address, k, exp, sig)
  }
  async function bring(over = {}, signer = key) {
    const b = {
      owner: owner.address, token: await usdc.getAddress(), amount: usdc6(10), fee: usdc6(0.05), maxFee: usdc6(0.01),
      minFinalityThreshold: 1000, hookData: '0x', salt: ethers.hexlify(ethers.randomBytes(32)), deadline: (await now()) + 600, ...over,
    }
    const sig = await signer.signTypedData(domain, bringTypes, { ...b, hookDataHash: ethers.keccak256(b.hookData) })
    return { b, sig, tx: () => router.connect(relayer).expressBring(b, sig) }
  }

  beforeEach(async () => {
    ;[owner, relayer, feeWallet, stranger] = await ethers.getSigners()
    key = ethers.Wallet.createRandom()
    usdc = await (await ethers.getContractFactory('MockUSDC3009')).deploy()
    messenger = await (await ethers.getContractFactory('MockTokenMessengerV2')).deploy()
    service = await (await ethers.getContractFactory('MockCrossChainTokenService')).deploy()
    router = await (await ethers.getContractFactory('MeshPortRouter'))
      .deploy(await messenger.getAddress(), await service.getAddress(), feeWallet.address)
    domain = { name: 'MeshPortRouter', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await router.getAddress() }
    await usdc.mint(owner.address, usdc6(1000))
    await usdc.connect(owner).approve(await router.getAddress(), usdc6(300)) // the setup's EIP-2612 permit, in effect
  })

  it('the key alone: pulls amount + fee, pays the fee, burns to the OWNER on Arc', async () => {
    await setKey()
    const { tx } = await bring()
    await expect(tx()).to.emit(router, 'ExpressBridged')
    expect(await usdc.balanceOf(feeWallet.address)).to.equal(usdc6(0.05))
    expect(await usdc.balanceOf(owner.address)).to.equal(usdc6(1000 - 10.05))
    const last = await messenger.last()
    expect(last.amount).to.equal(usdc6(10))
    expect(last.destinationDomain).to.equal(ARC_DOMAIN)
    expect(last.mintRecipient).to.equal(ethers.zeroPadValue(owner.address, 32))
    expect(last.withHook).to.equal(false)
    expect(await usdc.allowance(await router.getAddress(), await messenger.getAddress())).to.equal(0n)
  })

  it("Circle's forwarding hook when asked", async () => {
    await setKey()
    await (await bring({ hookData: FORWARD_HOOK })).tx()
    expect((await messenger.last()).withHook).to.equal(true)
  })

  it('each signed Bring works once', async () => {
    await setKey()
    const { tx } = await bring()
    await tx()
    await expect(tx()).to.be.revertedWithCustomError(router, 'NonceUsed')
  })

  it('refused: no key set, another key, an expired key, a past deadline', async () => {
    await expect((await bring()).tx()).to.be.revertedWithCustomError(router, 'Expired')
    await setKey()
    await expect((await bring({}, ethers.Wallet.createRandom())).tx()).to.be.revertedWithCustomError(router, 'BadSignature')
    await expect((await bring({ deadline: (await now()) - 1 })).tx()).to.be.revertedWithCustomError(router, 'Expired')
    await setKey(owner, key.address, (await now()) + 5)
    await ethers.provider.send('evm_increaseTime', [10]); await ethers.provider.send('evm_mine', [])
    await expect((await bring()).tx()).to.be.revertedWithCustomError(router, 'Expired')
  })

  it("MeshPort's fee is capped (5% + 0.1 USDC), whatever the key signs", async () => {
    await setKey()
    await expect((await bring({ fee: usdc6(0.61) })).tx()).to.be.revertedWithCustomError(router, 'FeeTooHigh')
    await expect((await bring({ fee: usdc6(0.6) })).tx()).to.emit(router, 'ExpressBridged')
  })

  it('only the owner sets their key; key 0 ends it; an old setBringKey signature cannot be replayed', async () => {
    await expect(setKey(stranger)).to.be.revertedWithCustomError(router, 'BadSignature')
    const exp = (await now()) + 86400
    const sig = await owner.signTypedData(domain, setKeyTypes, { owner: owner.address, key: key.address, expiry: exp, nonce: 0 })
    await router.connect(relayer).setBringKey(owner.address, key.address, exp, sig)
    await setKey(owner, ethers.ZeroAddress, 0) // ended
    await expect((await bring()).tx()).to.be.revertedWithCustomError(router, 'Expired')
    // Replaying the first signature (nonce 0) to bring the key back fails.
    await expect(router.connect(relayer).setBringKey(owner.address, key.address, exp, sig)).to.be.revertedWithCustomError(router, 'BadSignature')
  })

  it('nothing beyond the allowance the owner gave', async () => {
    await setKey()
    await usdc.connect(owner).approve(await router.getAddress(), usdc6(5))
    await expect((await bring()).tx()).to.be.reverted
  })
})
