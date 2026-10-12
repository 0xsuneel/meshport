// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEscrowOwed {
    function withdrawOwed() external;
}

/// @notice Test-only buyer that rejects value until told to accept it - a
/// stand-in for an Arc address that is blocklisted and later unblocked.
contract ToggleReceiver {
    bool public accepting;

    function setAccepting(bool on) external { accepting = on; }

    function withdrawOwed(address escrow) external { IEscrowOwed(escrow).withdrawOwed(); }

    receive() external payable {
        require(accepting, "ToggleReceiver: rejecting");
    }
}

/// @notice Test-only buyer whose receive() burns every unit of gas it is given.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}
