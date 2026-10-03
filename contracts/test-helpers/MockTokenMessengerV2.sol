// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Pull { function transferFrom(address f, address t, uint256 v) external returns (bool); }

/**
 * @notice Test-only CCTP V2 TokenMessenger: pulls `amount` from the caller
 * (like the real one, which then burns it) and records the call so tests can
 * check exactly what was burned, to whom, and with which fee/hook.
 */
contract MockTokenMessengerV2 {
    struct Call {
        uint256 amount; uint32 destinationDomain; bytes32 mintRecipient; address burnToken;
        bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; bool withHook;
    }
    Call public last;
    uint256 public calls;

    function depositForBurn(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
        bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold
    ) external {
        _record(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, "", false);
    }

    function depositForBurnWithHook(
        uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken,
        bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes calldata hookData
    ) external {
        _record(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData, true);
    }

    function _record(
        uint256 amount, uint32 d, bytes32 r, address t, bytes32 c, uint256 m, uint32 f, bytes memory h, bool w
    ) internal {
        require(IERC20Pull(t).transferFrom(msg.sender, address(this), amount), "pull");
        last = Call(amount, d, r, t, c, m, f, h, w);
        calls++;
    }
}
