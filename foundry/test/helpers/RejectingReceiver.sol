// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev A contract with no receive() or fallback() — any ETH transfer to it reverts.
/// Used to test the TransferFailed() revert path in MeshPortRefunds.
contract RejectingReceiver {
    // Intentionally no receive() and no fallback().
    // Any attempt to send ETH here will revert with no data.
}
