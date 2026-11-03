// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * MeshPortCheckout - a merchant payment on Arc, with MeshPort's merchant fee
 * taken in the same transaction.
 *
 * The customer pays the order's full price (Arc's native USDC, msg.value) to
 * this contract with the merchant and the order reference; in the same
 * transaction it sends the merchant the price minus MeshPort's fee, and the
 * fee to MeshPort's relayer wallet (it pays MeshPort's gas back). The customer
 * pays the normal price and signs once, as for any payment.
 *
 * The fee is computed HERE, from constants fixed at deploy (FEE_BPS of the
 * price, at most FEE_CAP) - no app, server or customer can lower, raise or
 * skip it. No owner, no admin, nothing can be upgraded, and it never holds
 * money: every payment is forwarded in full in the same transaction, or the
 * whole payment reverts (nothing moves).
 *
 * Arc's native currency is USDC with 18 decimals: FEE_CAP is in that unit
 * (3e18 = $3). Defaults (lib/feePolicy MERCHANT_FEE): 0.6%, cap $3.
 */
contract MeshPortCheckout {
    address public immutable feeRecipient;
    uint256 public immutable feeBps;
    uint256 public immutable feeCap;

    event Paid(
        address indexed payer, address indexed merchant, bytes32 indexed orderRef,
        uint256 price, uint256 fee
    );

    error ZeroAddress();
    error BadFee();
    error ZeroAmount();
    error PayoutFailed();

    constructor(address feeRecipient_, uint256 feeBps_, uint256 feeCap_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        // At most 5%: a deploy mistake can't take more than that from merchants.
        if (feeBps_ > 500) revert BadFee();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        feeCap = feeCap_;
    }

    /// MeshPort's fee on a payment of `price`.
    function feeFor(uint256 price) public view returns (uint256 fee) {
        fee = (price * feeBps) / 10_000;
        if (fee > feeCap) fee = feeCap;
    }

    /// Pay `merchant` the order `orderRef` (msg.value = the full price).
    function pay(address merchant, bytes32 orderRef) external payable {
        if (merchant == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee = feeFor(msg.value);
        (bool ok, ) = merchant.call{value: msg.value - fee}("");
        if (!ok) revert PayoutFailed();
        if (fee > 0) {
            (ok, ) = feeRecipient.call{value: fee}("");
            if (!ok) revert PayoutFailed();
        }
        emit Paid(msg.sender, merchant, orderRef, msg.value, fee);
    }

    /// Only pay() moves money: a plain transfer here is refused.
    receive() external payable { revert("MeshPortCheckout: use pay()"); }
}
