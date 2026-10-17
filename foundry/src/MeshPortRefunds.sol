// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MeshPortRefunds
/// @notice One-shot merchant-to-customer USDC refunds on Arc. The merchant calls refund(), sends the refund as msg.value (Arc native = USDC), and the contract immediately forwards it to the customer. A paymentRef can only be refunded once per merchant. MeshPort backend verifies the Refunded event.
/// @dev Minimal, non-custodial, non-upgradeable. No admin, no owner, no stored funds.
contract MeshPortRefunds is ReentrancyGuard {
    struct Refund {
        address merchant;
        address customer;
        uint128 amount;
        uint64 refundedAt;
    }

    /// @dev keyed by keccak256(abi.encode(merchant, paymentRef))
    mapping(bytes32 => Refund) private _refunds;

    error ZeroAmount();
    error InvalidCustomer();
    error ZeroRef();
    error ReasonTooLong();
    error AmountTooLarge();
    error AlreadyRefunded();
    error TransferFailed();
    error DirectDepositNotAllowed();

    event Refunded(
        bytes32 indexed paymentRef,
        address indexed merchant,
        address indexed customer,
        uint256 amount,
        string reason
    );

    /// @notice Refund a customer by forwarding msg.value immediately to them.
    /// @param paymentRef Merchant payment reference, unique per merchant.
    /// @param customer Recipient customer address that receives the refund.
    /// @param reason Free-form reason for the refund, max 140 bytes.
    function refund(bytes32 paymentRef, address payable customer, string calldata reason) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (customer == address(0) || customer == msg.sender) revert InvalidCustomer();
        if (paymentRef == bytes32(0)) revert ZeroRef();
        if (bytes(reason).length > 140) revert ReasonTooLong();
        if (msg.value > type(uint128).max) revert AmountTooLarge();

        bytes32 key = keccak256(abi.encode(msg.sender, paymentRef));
        if (_refunds[key].refundedAt != 0) revert AlreadyRefunded();

        _refunds[key] = Refund({
            merchant: msg.sender,
            customer: customer,
            amount: uint128(msg.value),
            refundedAt: uint64(block.timestamp)
        });

        (bool ok, ) = customer.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Refunded(paymentRef, msg.sender, customer, msg.value, reason);
    }

    /// @notice Return the stored refund record for a merchant/paymentRef pair.
    /// @param merchant Merchant address used for the refund key.
    /// @param paymentRef Merchant payment reference used for the refund key.
    /// @return Refund record, or empty fields if not refunded.
    function refundOf(address merchant, bytes32 paymentRef) external view returns (Refund memory) {
        return _refunds[keccak256(abi.encode(merchant, paymentRef))];
    }

    /// @notice Check whether a merchant/paymentRef pair has already been refunded.
    /// @param merchant Merchant address used for the refund key.
    /// @param paymentRef Merchant payment reference used for the refund key.
    /// @return True when refundedAt is non-zero.
    function isRefunded(address merchant, bytes32 paymentRef) external view returns (bool) {
        return _refunds[keccak256(abi.encode(merchant, paymentRef))].refundedAt != 0;
    }

    /// @notice Reject direct native token deposits to keep the contract non-custodial.
    receive() external payable {
        revert DirectDepositNotAllowed();
    }

    /// @notice Reject unknown calls and direct native token deposits.
    fallback() external payable {
        revert DirectDepositNotAllowed();
    }
}
