// test/P2PMeshportEscrowV3.payout.test.js
//
// A buyer payout that can't be sent (Arc reverts a native send to a
// blocklisted address; a contract may reject it or burn all gas) must not
// leave a trade stuck. release() and adminResolve() finish the trade and
// hold the USDC in owedToBuyer; only that buyer can collect it later.
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

describe('P2PMeshportEscrowV3 buyer payouts', function () {
  let escrow, admin, pauser, investigator, seller, buyer, stranger, rm1, rm2, rm3
  const ONE = ethers.parseEther('1')

  async function grantRole(action, target) {
    await escrow.connect(rm1).proposeRoleChange(action, target)
    const id = (await escrow.roleProposalCount()) - 1n
    await escrow.connect(rm2).confirmRoleChange(id)
    await ethers.provider.send('evm_increaseTime', [2 * 60 * 60 + 1])
    await ethers.provider.send('evm_mine')
    await escrow.connect(rm1).executeRoleProposal(id)
  }
  async function deploy(name) {
    const c = await (await ethers.getContractFactory(name)).deploy()
    await c.waitForDeployment()
    return c
  }
  async function trade(id, buyerAddr) {
    const offerKey = offerKeyFor(`offer-${id}`, seller.address)
    await escrow.connect(seller).deposit(idOf(offerKey), { value: ONE })
    const tradeKey = tradeKeyFor(`trade-${id}`)
    await escrow.connect(seller).registerTrade(tradeKey, offerKey, buyerAddr, ONE)
    return { offerKey, tradeKey }
  }
  async function disputeToApprovedRelease(tradeKey) {
    await escrow.connect(pauser).freezeTrade(tradeKey)
    await escrow.connect(investigator).investigate(tradeKey, true)
  }

  beforeEach(async function () {
    ;[admin, pauser, investigator, seller, buyer, stranger, rm1, rm2, rm3] = await ethers.getSigners()
    escrow = await (await ethers.getContractFactory('P2PMeshportEscrowV3', admin)).deploy([rm1.address, rm2.address, rm3.address])
    await escrow.waitForDeployment()
    await grantRole(0, pauser.address) // AddPauser
    await grantRole(2, investigator.address) // AddInvestigator
  })

  it('a normal buyer is paid straight away and owes nothing', async function () {
    const { tradeKey } = await trade('eoa', buyer.address)
    await expect(escrow.connect(seller).release(tradeKey)).to.changeEtherBalance(buyer, ONE)
    expect(await escrow.owedToBuyer(buyer.address)).to.equal(0n)
  })

  it('a release with too little gas reverts instead of skipping the payment', async function () {
    const { tradeKey } = await trade('lowgas', buyer.address)
    const est = await escrow.connect(seller).release.estimateGas(tradeKey)
    // The estimate is enough to pay the wallet directly...
    await expect(escrow.connect(seller).release(tradeKey, { gasLimit: est })).to.changeEtherBalance(buyer, ONE)
    expect(await escrow.owedToBuyer(buyer.address)).to.equal(0n)
  })

  it('a release starved of gas cannot fall back to owed - it reverts and the trade stays Active', async function () {
    const { tradeKey } = await trade('starved', buyer.address)
    await expect(escrow.connect(seller).release(tradeKey, { gasLimit: 90_000 })).to.be.reverted
    expect((await escrow.getTrade(tradeKey)).state).to.equal(1n)
    expect(await escrow.owedToBuyer(buyer.address)).to.equal(0n)
  })

  it('adminResolve release to a rejecting buyer completes instead of sticking at Investigated', async function () {
    const r = await deploy('ToggleReceiver')
    const addr = await r.getAddress()
    const { offerKey, tradeKey } = await trade('stuck', addr)
    await disputeToApprovedRelease(tradeKey)

    await expect(escrow.connect(admin).adminResolve(tradeKey))
      .to.emit(escrow, 'PayoutDeferred').withArgs(tradeKey, addr, ONE)
      .and.to.emit(escrow, 'AdminResolvedRelease')
    expect((await escrow.getTrade(tradeKey)).state).to.equal(4n) // Released - terminal
    expect(await escrow.getReserved(offerKey)).to.equal(0n)
    expect(await escrow.getRemaining(offerKey)).to.equal(0n)
    expect(await escrow.owedToBuyer(addr)).to.equal(ONE)
    // Can't be resolved twice.
    await expect(escrow.connect(admin).adminResolve(tradeKey)).to.be.reverted
  })

  it('the buyer collects what is owed once it can receive again (e.g. unblocked), exactly once', async function () {
    const r = await deploy('ToggleReceiver')
    const addr = await r.getAddress()
    const { tradeKey } = await trade('collect', addr)
    await escrow.connect(seller).release(tradeKey)

    // Still rejecting: the pull fails and nothing changes.
    await expect(r.withdrawOwed(await escrow.getAddress())).to.be.revertedWith('P2PEscrowV3: owed transfer failed')
    expect(await escrow.owedToBuyer(addr)).to.equal(ONE)

    await r.setAccepting(true)
    await expect(r.withdrawOwed(await escrow.getAddress()))
      .to.emit(escrow, 'OwedWithdrawn').withArgs(addr, ONE)
    expect(await ethers.provider.getBalance(addr)).to.equal(ONE)
    expect(await escrow.owedToBuyer(addr)).to.equal(0n)
    await expect(r.withdrawOwed(await escrow.getAddress())).to.be.revertedWith('P2PEscrowV3: nothing owed to this address')
  })

  it('nobody else can collect a buyer\'s owed USDC', async function () {
    const r = await deploy('ToggleReceiver')
    const { tradeKey } = await trade('other', await r.getAddress())
    await escrow.connect(seller).release(tradeKey)
    await expect(escrow.connect(stranger).withdrawOwed()).to.be.revertedWith('P2PEscrowV3: nothing owed to this address')
    await expect(escrow.connect(seller).withdrawOwed()).to.be.revertedWith('P2PEscrowV3: nothing owed to this address')
  })

  it('owed USDC never becomes withdrawable by the seller', async function () {
    const r = await deploy('ToggleReceiver')
    const { offerKey, tradeKey } = await trade('seller', await r.getAddress())
    await escrow.connect(seller).release(tradeKey)
    await expect(escrow.connect(seller).withdrawRemaining(offerKey)).to.be.reverted
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(ONE) // still held for the buyer
  })

  it('a buyer that burns all forwarded gas cannot make the release run out of gas', async function () {
    const g = await deploy('GasBurner')
    const addr = await g.getAddress()
    const { tradeKey } = await trade('burn', addr)
    await disputeToApprovedRelease(tradeKey)
    await expect(escrow.connect(admin).adminResolve(tradeKey, { gasLimit: 3_000_000 }))
      .to.emit(escrow, 'PayoutDeferred').withArgs(tradeKey, addr, ONE)
    expect((await escrow.getTrade(tradeKey)).state).to.equal(4n)
  })

  it('withdrawOwed is stopped while the contract is paused', async function () {
    const r = await deploy('ToggleReceiver')
    const { tradeKey } = await trade('paused', await r.getAddress())
    await escrow.connect(seller).release(tradeKey)
    await r.setAccepting(true)
    await escrow.connect(pauser).pause()
    await expect(r.withdrawOwed(await escrow.getAddress())).to.be.reverted
    await escrow.connect(pauser).unpause()
    await r.withdrawOwed(await escrow.getAddress())
    expect(await escrow.owedToBuyer(await r.getAddress())).to.equal(0n)
  })
})
