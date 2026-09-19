// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test-only helper — a contract with no receive()/fallback(), so any plain value transfer to it fails. Used to prove a failed transfer reverts the whole release() call instead of silently corrupting accounting.
contract RejectingReceiver {}
