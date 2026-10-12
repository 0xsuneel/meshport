// test/P2PMeshportEscrowV3.autoAccept.test.js
//
// V3's only addition over V2: the per-offer auto-accept operator. The rest
// of V3 is covered by P2PMeshportEscrowV3.test.js (all V2 tests, ported).
// What must hold: only the seller names an operator; the operator can
// register trades only inside the seller's limits and cancel only unpaid
// trades past the window; it can never release, withdraw or move value;
// the buyer can cancel gas-free by signature.
const { expect } = require('chai')
const { ethers } = require('hardhat')

// offerKeyOf(offerId, seller) on-chain; idOf() maps a key back to its offerId (see P2PMeshportEscrowV3.test.js).
const offerIds = new Map()
const offerKeyFor = (name, seller) => {
  const id = ethers.keccak256(ethers.toUtf8Bytes(name))
  const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [id, seller]))
  offerIds.set(key, id)
  return key
}
const idOf = key => offerIds.get(key) ?? key
const tradeKeyFor = id => ethers.keccak256(ethers.toUtf8Bytes(id))

describe('P2PMeshportEscrowV3 auto-accept', function () {
  let escrow, seller, buyer, operator, attacker, rm1, rm2, rm3
  const ONE = ethers.parseEther('1')
  const MIN = ONE / 10n, MAX = ONE / 2n
  let offerKey

  beforeEach(async function () {
    ;[, seller, buyer, operator, attacker, rm1, rm2, rm3] = await ethers.getSigners()
    const F = await ethers.getContractFactory('P2PMeshportEscrowV3')
    escrow = await F.deploy([rm1.address, rm2.address, rm3.address])
    await escrow.waitForDeployment()
    offerKey = offerKeyFor('ad-1', seller.address)
    await expect(escrow.connect(seller).depositWithAutoAccept(idOf(offerKey), operator.address, MIN, MAX, { value: ONE }))
      .to.emit(escrow, 'AutoAcceptSet').withArgs(offerKey, operator.address, MIN, MAX)
  })

  it('operator registers a trade for a buyer instantly, within limits', async function () {
    const tk = tradeKeyFor('t1')
    await expect(escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX))
      .to.emit(escrow, 'TradeRegistered').withArgs(offerKey, tk, seller.address, buyer.address, MAX)
    const t = await escrow.trades(tk)
    expect(t.seller).to.equal(seller.address)
    expect(t.buyer).to.equal(buyer.address)
  })

  it('operator cannot register outside the seller limits', async function () {
    await expect(escrow.connect(operator).registerTrade(tradeKeyFor('lo'), offerKey, buyer.address, MIN - 1n))
      .to.be.revertedWith('P2PEscrowV3: amount outside the seller\'s limits')
    await expect(escrow.connect(operator).registerTrade(tradeKeyFor('hi'), offerKey, buyer.address, MAX + 1n))
      .to.be.revertedWith('P2PEscrowV3: amount outside the seller\'s limits')
  })

  it('operator cannot exceed what is available (reservations still count)', async function () {
    await escrow.connect(operator).registerTrade(tradeKeyFor('a'), offerKey, buyer.address, MAX)
    await escrow.connect(operator).registerTrade(tradeKeyFor('b'), offerKey, buyer.address, MAX)
    await expect(escrow.connect(operator).registerTrade(tradeKeyFor('c'), offerKey, buyer.address, MIN))
      .to.be.revertedWith('P2PEscrowV3: invalid trade amount')
  })

  it('a non-operator stranger still cannot register', async function () {
    await expect(escrow.connect(attacker).registerTrade(tradeKeyFor('x'), offerKey, buyer.address, MIN))
      .to.be.revertedWith('P2PEscrowV3: only the offer\'s seller can register a trade')
  })

  it('the seller cannot be the buyer', async function () {
    await expect(escrow.connect(operator).registerTrade(tradeKeyFor('self'), offerKey, seller.address, MIN))
      .to.be.revertedWith('P2PEscrowV3: seller cannot buy from themselves')
  })

  it('only the seller can set or change the operator', async function () {
    await expect(escrow.connect(attacker).setAutoAccept(offerKey, attacker.address, MIN, MAX))
      .to.be.revertedWith('P2PEscrowV3: not the offer\'s seller')
    await expect(escrow.connect(operator).setAutoAccept(offerKey, attacker.address, MIN, MAX))
      .to.be.revertedWith('P2PEscrowV3: not the offer\'s seller')
    await expect(escrow.connect(seller).setAutoAccept(offerKey, operator.address, MAX, MIN))
      .to.be.revertedWith('P2PEscrowV3: invalid trade limits')
    await expect(escrow.connect(seller).setAutoAccept(offerKey, seller.address, MIN, MAX))
      .to.be.revertedWith('P2PEscrowV3: seller cannot be its own operator')
  })

  it('turning auto-accept off stops the operator', async function () {
    await escrow.connect(seller).setAutoAccept(offerKey, ethers.ZeroAddress, 0, 0)
    await expect(escrow.connect(operator).registerTrade(tradeKeyFor('off'), offerKey, buyer.address, MIN))
      .to.be.revertedWith('P2PEscrowV3: only the offer\'s seller can register a trade')
  })

  it('operator can never release, withdraw, or move value', async function () {
    const tk = tradeKeyFor('nv')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MIN)
    await expect(escrow.connect(operator).release(tk)).to.be.revertedWith('P2PEscrowV3: only the trade\'s seller can release it')
    await expect(escrow.connect(operator).withdrawRemaining(offerKey)).to.be.revertedWith('P2PEscrowV3: not the offer\'s seller')
    // Depositing the same offer id only ever creates the operator's OWN escrow - never touches the seller's.
    const before = await escrow.getRemaining(offerKey)
    await escrow.connect(operator).deposit(idOf(offerKey), { value: 1n })
    expect(await escrow.getRemaining(offerKey)).to.equal(before)
    expect(await escrow.getSeller(offerKey)).to.equal(seller.address)
  })

  it('seller release still works on an operator-registered trade', async function () {
    const tk = tradeKeyFor('rel')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX)
    const before = await ethers.provider.getBalance(buyer.address)
    await escrow.connect(seller).release(tk)
    expect((await ethers.provider.getBalance(buyer.address)) - before).to.equal(MAX)
  })

  it('operator can cancel an UNPAID trade only after the payment window', async function () {
    const tk = tradeKeyFor('exp')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX)
    await expect(escrow.connect(operator).cancelTrade(tk)).to.be.revertedWith('P2PEscrowV3: the buyer\'s payment window is still open')
    await ethers.provider.send('evm_increaseTime', [30 * 60 + 1]); await ethers.provider.send('evm_mine')
    await expect(escrow.connect(operator).cancelTrade(tk)).to.emit(escrow, 'TradeCancelled').withArgs(offerKey, tk, operator.address, seller.address, MAX)
    // the reservation is back: the full deposit is withdrawable again
    await expect(escrow.connect(seller).withdrawRemaining(offerKey)).to.emit(escrow, 'Withdrawn').withArgs(offerKey, seller.address, ONE)
  })

  it('operator cannot cancel once the buyer marked paid', async function () {
    const tk = tradeKeyFor('paid')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX)
    const sig = await buyer.signMessage(ethers.getBytes(await escrow.markPaidDigest(tk)))
    await escrow.connect(operator).markPaidFor(tk, sig)
    await ethers.provider.send('evm_increaseTime', [30 * 60 + 1]); await ethers.provider.send('evm_mine')
    await expect(escrow.connect(operator).cancelTrade(tk)).to.be.revertedWith('P2PEscrowV3: buyer marked this trade paid - release it or open a dispute')
  })

  it('buyer can cancel gas-free by signature, any time before paying', async function () {
    const tk = tradeKeyFor('bc')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX)
    const sig = await buyer.signMessage(ethers.getBytes(await escrow.cancelDigest(tk)))
    await expect(escrow.connect(operator).cancelTradeFor(tk, sig)).to.emit(escrow, 'TradeCancelled').withArgs(offerKey, tk, buyer.address, seller.address, MAX)
  })

  it('a cancel signature from anyone but the buyer is rejected', async function () {
    const tk = tradeKeyFor('bad')
    await escrow.connect(operator).registerTrade(tk, offerKey, buyer.address, MAX)
    const sig = await attacker.signMessage(ethers.getBytes(await escrow.cancelDigest(tk)))
    await expect(escrow.connect(operator).cancelTradeFor(tk, sig)).to.be.revertedWith('P2PEscrowV3: only the trade\'s buyer can sign a cancel')
    // a mark-paid signature cannot be replayed as a cancel
    const paidSig = await buyer.signMessage(ethers.getBytes(await escrow.markPaidDigest(tk)))
    await expect(escrow.connect(operator).cancelTradeFor(tk, paidSig)).to.be.revertedWith('P2PEscrowV3: only the trade\'s buyer can sign a cancel')
  })
})
