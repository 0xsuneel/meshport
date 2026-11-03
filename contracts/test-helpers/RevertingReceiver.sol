// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// Test helper: a merchant address that refuses money.
contract RevertingReceiver {
    receive() external payable { revert("no"); }
}
