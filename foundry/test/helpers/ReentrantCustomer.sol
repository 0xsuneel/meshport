// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMeshPortRefunds {
    function refund(bytes32 paymentRef, address payable customer, string calldata reason) external payable;
}

/// @dev A malicious customer contract that tries to re-enter MeshPortRefunds.refund()
/// during the ETH callback triggered by the original refund call.
/// The reentrancy should be blocked by ReentrancyGuard, causing the inner call to revert,
/// which propagates back and causes the outer call.call to return ok=false,
/// which means the outer refund() also reverts with TransferFailed().
contract ReentrantCustomer {
    IMeshPortRefunds public target;
    bytes32 public attackRef;
    address payable public victim; // an innocent address to try to refund to
    uint256 public receiveCount;

    constructor(address _target) {
        target = IMeshPortRefunds(_target);
    }

    function setup(bytes32 _attackRef, address payable _victim) external {
        attackRef = _attackRef;
        victim = _victim;
    }

    /// @dev Called when the refund contract sends ETH to this address.
    /// Tries to re-enter refund() with a different paymentRef.
    receive() external payable {
        receiveCount++;
        if (receiveCount == 1) {
            // Attempt reentrancy: try to call refund again
            // This should fail because of ReentrancyGuard
            // We use a try/catch so this contract's receive() returns without reverting,
            // BUT we want this to cause the OUTER call to also revert.
            // Actually, for the test: we want the outer refund to revert with TransferFailed
            // because the reentrancy guard causes the inner call to revert, which causes
            // this receive() to revert (we re-throw below), which causes ok=false.
            target.refund{value: msg.value}(attackRef, victim, "reentrant");
            // If we reach here (we won't), it means reentrancy guard wasn't triggered
        }
    }
}
