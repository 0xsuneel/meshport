// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Test-only, minimal call surface — named distinctly from the real
// contract (P2PMeshportEscrowV2 itself) specifically because Slither's
// missing-inheritance heuristic flagged a false positive ("contract X
// should inherit from interface X-shaped-name") when this was named
// IP2PMeshportEscrowV2. This interface only exists so this test-helper
// attacker contract has something typed to call against; the real
// contract was never meant to implement it.
interface IEscrowForReentrancyTest {
    function deposit(bytes32 offerKey) external payable;
    function registerTrade(bytes32 tradeKey, bytes32 offerKey, address buyer, uint256 amount) external;
    function release(bytes32 tradeKey) external;
}

/**
 * @notice Test-only helper — deposits into the escrow as its own seller and
 * buyer, then tries to re-enter release() from within its receive() hook
 * while the first release() call is still mid-transfer. Used to prove
 * ReentrancyGuard actually blocks this, not just that the happy path works.
 */
contract ReentrancyAttacker {
    IEscrowForReentrancyTest public immutable escrow;
    bytes32 public tradeKeyToReenter;
    bool public reentered;

    constructor(address escrowAddress) {
        escrow = IEscrowForReentrancyTest(escrowAddress);
    }

    function deposit(bytes32 offerKey) external payable {
        escrow.deposit{value: msg.value}(offerKey);
    }

    function registerTrade(bytes32 tradeKey, bytes32 offerKey, address buyer, uint256 amount) external {
        escrow.registerTrade(tradeKey, offerKey, buyer, amount);
    }

    function attack(bytes32 tradeKey) external {
        tradeKeyToReenter = tradeKey;
        escrow.release(tradeKey);
    }

    /// Sets the target tradeKey WITHOUT calling release() itself — needed
    /// to test reentrancy into adminResolve(), where the trade is already
    /// Frozen/Investigated (not Active) at attack time, so routing through
    /// attack()'s own release() call would revert for an unrelated reason
    /// before ever reaching what this is actually testing.
    function setTradeKeyToReenter(bytes32 tradeKey) external {
        tradeKeyToReenter = tradeKey;
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            // This call MUST revert (nonReentrant) — swallowed here so the
            // outer release() call still completes normally, letting the
            // test assert the trade ended up Released exactly once.
            try escrow.release(tradeKeyToReenter) { } catch { }
        }
    }
}
