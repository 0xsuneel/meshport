// test/MeshPortCheckout.test.js
//
// MeshPortCheckout: a merchant payment with MeshPort's fee taken in the same
// transaction, computed by the contract itself (0.6%, cap $3 - native USDC on
// Arc has 18 decimals). Nothing can skip or change the fee, and the contract
// never keeps money.

const { expect } = require('chai')
const hre = require('hardhat')
const { ethers } = hre

const usd = (n) => ethers.parseEther(String(n)) // Arc native USDC: 18 decimals
const ORDER = ethers.keccak256(ethers.toUtf8Bytes('order-123'))

describe('MeshPortCheckout', () => {
  let checkout, customer, merchant, feeWallet, stranger

  beforeEach(async () => {
    ;[customer, merchant, feeWallet, stranger] = await ethers.getSigners()
    checkout = await (await ethers.getContractFactory('MeshPortCheckout')).deploy(feeWallet.address, 60, usd(3))
  })

  it('pays the merchant 99.4% and MeshPort 0.6%, in one transaction, and keeps nothing', async () => {
    const m0 = await ethers.provider.getBalance(merchant.address)
    const f0 = await ethers.provider.getBalance(feeWallet.address)
    await expect(checkout.connect(customer).pay(merchant.address, ORDER, { value: usd(100) }))
      .to.emit(checkout, 'Paid').withArgs(customer.address, merchant.address, ORDER, usd(100), usd(0.6))
    expect(await ethers.provider.getBalance(merchant.address) - m0).to.equal(usd(99.4))
    expect(await ethers.provider.getBalance(feeWallet.address) - f0).to.equal(usd(0.6))
    expect(await ethers.provider.getBalance(await checkout.getAddress())).to.equal(0n)
  })

  it('caps the fee at $3', async () => {
    expect(await checkout.feeFor(usd(1000))).to.equal(usd(3))   // 0.6% = $6 → $3
    expect(await checkout.feeFor(usd(500))).to.equal(usd(3))
    expect(await checkout.feeFor(usd(10))).to.equal(usd(0.06))
    const m0 = await ethers.provider.getBalance(merchant.address)
    await checkout.pay(merchant.address, ORDER, { value: usd(5_000) })
    expect(await ethers.provider.getBalance(merchant.address) - m0).to.equal(usd(4_997))
  })

  it('a merchant that refuses money: the whole payment reverts - nothing moves, no fee', async () => {
    const bad = await (await ethers.getContractFactory('RevertingReceiver')).deploy()
    const f0 = await ethers.provider.getBalance(feeWallet.address)
    await expect(checkout.pay(await bad.getAddress(), ORDER, { value: usd(5) })).to.be.revertedWithCustomError(checkout, 'PayoutFailed')
    expect(await ethers.provider.getBalance(feeWallet.address)).to.equal(f0)
  })

  it('refuses a zero payment, no merchant, a plain transfer, and a fee setting above 5%', async () => {
    await expect(checkout.pay(merchant.address, ORDER, { value: 0 })).to.be.revertedWithCustomError(checkout, 'ZeroAmount')
    await expect(checkout.pay(ethers.ZeroAddress, ORDER, { value: usd(1) })).to.be.revertedWithCustomError(checkout, 'ZeroAddress')
    await expect(stranger.sendTransaction({ to: await checkout.getAddress(), value: usd(1) })).to.be.reverted
    const F = await ethers.getContractFactory('MeshPortCheckout')
    await expect(F.deploy(feeWallet.address, 501, usd(3))).to.be.revertedWithCustomError(checkout, 'BadFee')
    await expect(F.deploy(ethers.ZeroAddress, 60, usd(3))).to.be.revertedWithCustomError(checkout, 'ZeroAddress')
  })

  it('a tiny payment rounds the fee down (never more than 0.6%)', async () => {
    expect(await checkout.feeFor(100n)).to.equal(0n)
    expect(await checkout.feeFor(10_000n)).to.equal(60n)
  })
})
