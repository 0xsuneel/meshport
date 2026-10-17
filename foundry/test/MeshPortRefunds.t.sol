// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MeshPortRefunds} from "../src/MeshPortRefunds.sol";
import {RejectingReceiver} from "./helpers/RejectingReceiver.sol";
import {ReentrantCustomer} from "./helpers/ReentrantCustomer.sol";

contract MeshPortRefundsTest is Test {
    MeshPortRefunds internal refunds;

    address internal merchant  = makeAddr("merchant");
    address internal merchant2 = makeAddr("merchant2");
    address internal alice     = makeAddr("alice");     // customer
    address internal bob       = makeAddr("bob");       // another customer

    bytes32 internal constant REF_A  = keccak256("payment-001");
    bytes32 internal constant REF_B  = keccak256("payment-002");
    uint256 internal constant AMOUNT = 1 ether;

    // ───────────────────────────────────────────── setup ──────

    function setUp() public {
        refunds = new MeshPortRefunds();
        // Fund merchants so they can send msg.value
        vm.deal(merchant,  100 ether);
        vm.deal(merchant2, 100 ether);
    }

    // ══════════════════════════════════════════════════════════
    //  1. HAPPY PATH
    // ══════════════════════════════════════════════════════════

    function test_HappyPath_CustomerBalanceIncreasedByAmount() public {
        uint256 beforeBal = alice.balance;

        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "all good");

        assertEq(alice.balance - beforeBal, AMOUNT, "customer balance delta should equal msg.value");
    }

    function test_HappyPath_ContractBalanceStaysZero() public {
        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "all good");

        assertEq(address(refunds).balance, 0, "contract must hold no funds after refund");
    }

    function test_HappyPath_EventFieldsAreCorrect() public {
        // expectEmit: check all three indexed topics + data
        vm.expectEmit(true, true, true, true, address(refunds));
        emit MeshPortRefunds.Refunded(REF_A, merchant, alice, AMOUNT, "all good");

        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "all good");
    }

    function test_HappyPath_RefundOfReturnsCorrectRecord() public {
        uint256 ts = 1_700_000_000;
        vm.warp(ts);

        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "reason");

        MeshPortRefunds.Refund memory r = refunds.refundOf(merchant, REF_A);
        assertEq(r.merchant,    merchant,           "merchant field");
        assertEq(r.customer,    alice,              "customer field");
        assertEq(uint256(r.amount), AMOUNT,         "amount field");
        assertEq(uint256(r.refundedAt), ts,         "refundedAt field (block.timestamp)");
    }

    function test_HappyPath_IsRefundedReturnsTrueAfterRefund() public {
        assertFalse(refunds.isRefunded(merchant, REF_A), "should be false before refund");

        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "reason");

        assertTrue(refunds.isRefunded(merchant, REF_A), "should be true after refund");
    }

    function test_HappyPath_IsRefundedFalseForUnusedRef() public view {
        assertFalse(refunds.isRefunded(merchant, REF_B), "untouched ref should be false");
    }

    function test_HappyPath_RefundOfEmptyForUnusedRef() public view {
        MeshPortRefunds.Refund memory r = refunds.refundOf(merchant, REF_B);
        assertEq(r.merchant,    address(0), "merchant should be zero");
        assertEq(r.customer,    address(0), "customer should be zero");
        assertEq(r.amount,      0,          "amount should be zero");
        assertEq(r.refundedAt,  0,          "refundedAt should be zero");
    }

    // ══════════════════════════════════════════════════════════
    //  2. DOUBLE REFUND REVERTS
    // ══════════════════════════════════════════════════════════

    function test_DoubleRefund_RevertsAlreadyRefunded() public {
        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "first");

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.AlreadyRefunded.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "second");
    }

    // ══════════════════════════════════════════════════════════
    //  3. TWO MERCHANTS, SAME paymentRef — BOTH SUCCEED
    // ══════════════════════════════════════════════════════════

    function test_TwoMerchantsSameRef_BothSucceed() public {
        // merchant1 refunds REF_A → alice
        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "merchant1");

        assertTrue(refunds.isRefunded(merchant,  REF_A), "merchant should be refunded");
        assertFalse(refunds.isRefunded(merchant2, REF_A), "merchant2 should not yet be refunded");

        // merchant2 refunds the same REF_A → bob — independent key, must succeed
        vm.prank(merchant2);
        refunds.refund{value: 2 ether}(REF_A, payable(bob), "merchant2");

        assertTrue(refunds.isRefunded(merchant2, REF_A), "merchant2 should now be refunded");

        // Records are independent
        MeshPortRefunds.Refund memory r1 = refunds.refundOf(merchant,  REF_A);
        MeshPortRefunds.Refund memory r2 = refunds.refundOf(merchant2, REF_A);
        assertEq(r1.customer, alice,   "merchant1 record points to alice");
        assertEq(r2.customer, bob,     "merchant2 record points to bob");
        assertEq(uint256(r1.amount), AMOUNT,   "merchant1 amount");
        assertEq(uint256(r2.amount), 2 ether,  "merchant2 amount");
    }

    function test_TwoMerchantsSameRef_DoubleRefundOnlyBlocksOwnMerchant() public {
        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "first");

        // merchant tries again — should revert
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.AlreadyRefunded.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "second");

        // merchant2 uses same REF_A — should still succeed
        vm.prank(merchant2);
        refunds.refund{value: AMOUNT}(REF_A, payable(bob), "merchant2 first");
        assertTrue(refunds.isRefunded(merchant2, REF_A));
    }

    // ══════════════════════════════════════════════════════════
    //  4. ALL REVERT CASES
    // ══════════════════════════════════════════════════════════

    function test_Revert_ZeroAmount() public {
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.ZeroAmount.selector);
        refunds.refund{value: 0}(REF_A, payable(alice), "zero");
    }

    function test_Revert_InvalidCustomer_AddressZero() public {
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.InvalidCustomer.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(address(0)), "zero address");
    }

    function test_Revert_InvalidCustomer_CustomerIsMsgSender() public {
        // The merchant tries to refund themselves — must revert
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.InvalidCustomer.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(merchant), "self refund");
    }

    function test_Revert_ZeroRef() public {
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.ZeroRef.selector);
        refunds.refund{value: AMOUNT}(bytes32(0), payable(alice), "zero ref");
    }

    function test_Revert_ReasonTooLong_Exactly141Bytes() public {
        // Build a 141-byte string (one byte over the 140 limit)
        string memory longReason = new string(141);
        assembly {
            let ptr := add(longReason, 32)
            for { let i := 0 } lt(i, 141) { i := add(i, 1) } {
                mstore8(add(ptr, i), 0x41) // 'A'
            }
        }
        assertEq(bytes(longReason).length, 141, "sanity: reason length");

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.ReasonTooLong.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), longReason);
    }

    function test_Revert_ReasonTooLong_WellOver() public {
        // 200-byte string — definitely too long
        string memory longReason = new string(200);
        assembly {
            let ptr := add(longReason, 32)
            for { let i := 0 } lt(i, 200) { i := add(i, 1) } {
                mstore8(add(ptr, i), 0x42) // 'B'
            }
        }

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.ReasonTooLong.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), longReason);
    }

    function test_Pass_ReasonExactly140Bytes() public {
        // 140-byte string — exactly at the limit, must NOT revert
        string memory reason140 = new string(140);
        assembly {
            let ptr := add(reason140, 32)
            for { let i := 0 } lt(i, 140) { i := add(i, 1) } {
                mstore8(add(ptr, i), 0x43) // 'C'
            }
        }

        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), reason140); // must succeed
        assertTrue(refunds.isRefunded(merchant, REF_A));
    }

    function test_Revert_AmountTooLarge() public {
        uint256 tooLarge = uint256(type(uint128).max) + 1;
        // Give merchant enough native
        vm.deal(merchant, tooLarge + 1 ether);

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.AmountTooLarge.selector);
        refunds.refund{value: tooLarge}(REF_A, payable(alice), "too large");
    }

    function test_Revert_AlreadyRefunded() public {
        vm.prank(merchant);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "first");

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.AlreadyRefunded.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(alice), "duplicate");
    }

    // ══════════════════════════════════════════════════════════
    //  5. REJECTING CUSTOMER CONTRACT
    // ══════════════════════════════════════════════════════════

    function test_RejectingCustomer_RevertsTransferFailed() public {
        RejectingReceiver rejector = new RejectingReceiver();

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.TransferFailed.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(address(rejector)), "rejected");
    }

    function test_RejectingCustomer_RecordNotStoredOnRevert() public {
        RejectingReceiver rejector = new RejectingReceiver();

        // Confirm state is clean before
        assertFalse(refunds.isRefunded(merchant, REF_A), "should not be refunded before");

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.TransferFailed.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(address(rejector)), "rejected");

        // State must be unchanged — the whole transaction should have reverted
        // The contract writes the record BEFORE the transfer, so if TransferFailed reverts
        // the entire call, the record write is also rolled back.
        assertFalse(refunds.isRefunded(merchant, REF_A), "record must NOT be stored after TransferFailed revert");

        MeshPortRefunds.Refund memory r = refunds.refundOf(merchant, REF_A);
        assertEq(r.refundedAt, 0, "refundedAt must be 0 - state should be rolled back");
    }

    // ══════════════════════════════════════════════════════════
    //  6. REENTRANCY ATTACK
    // ══════════════════════════════════════════════════════════

    function test_Reentrancy_OriginalCallRevertsWithTransferFailed() public {
        // Deploy the reentrant attacker — it will try to call refund() again during receive()
        ReentrantCustomer attacker = new ReentrantCustomer(address(refunds));

        // The attack ref used for the re-entrant inner call
        bytes32 attackRef = keccak256("reentrant-attack");

        // Give attacker enough ETH to forward during the re-entrancy attempt
        vm.deal(address(attacker), 10 ether);

        // The attacker's receive() will try to call refund(attackRef, victim, "reentrant")
        // The victim for the inner call is alice (innocent bystander)
        attacker.setup(attackRef, payable(alice));

        // The outer call: merchant refunds to attacker
        // 1. ReentrancyGuard locks
        // 2. ETH sent to attacker.receive()
        // 3. attacker.receive() calls refund() again → ReentrancyGuard reverts inner call
        // 4. The inner revert propagates up through the low-level call → ok=false
        // 5. outer refund() reverts with TransferFailed()
        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.TransferFailed.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(address(attacker)), "to attacker");
    }

    function test_Reentrancy_NoRecordStoredAfterRevertedAttack() public {
        ReentrantCustomer attacker = new ReentrantCustomer(address(refunds));
        bytes32 attackRef = keccak256("reentrant-attack");
        vm.deal(address(attacker), 10 ether);
        attacker.setup(attackRef, payable(alice));

        vm.prank(merchant);
        vm.expectRevert(MeshPortRefunds.TransferFailed.selector);
        refunds.refund{value: AMOUNT}(REF_A, payable(address(attacker)), "to attacker");

        // Both the outer ref and the attack ref must have no record
        assertFalse(refunds.isRefunded(merchant, REF_A),      "outer ref must not be stored");
        assertFalse(refunds.isRefunded(address(attacker), attackRef), "attack ref must not be stored");
    }

    // ══════════════════════════════════════════════════════════
    //  7. DIRECT SEND TO CONTRACT REVERTS
    // ══════════════════════════════════════════════════════════

    function test_DirectSend_RevertsDirectDepositNotAllowed() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(refunds).call{value: 1 ether}("");
        assertFalse(ok, "direct send must revert");
        // Decode and verify the correct error selector
        bytes4 gotSelector = bytes4(ret);
        assertEq(gotSelector, MeshPortRefunds.DirectDepositNotAllowed.selector, "should be DirectDepositNotAllowed");
    }

    function test_DirectSend_ZeroValueCall_RevertsDirectDepositNotAllowed() public {
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(refunds).call{value: 0}("");
        assertFalse(ok, "direct zero-value send must revert");
        bytes4 gotSelector = bytes4(ret);
        assertEq(gotSelector, MeshPortRefunds.DirectDepositNotAllowed.selector, "should be DirectDepositNotAllowed");
    }

    function test_DirectSend_UnknownCalldata_RevertsDirectDepositNotAllowed() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(refunds).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok, "call with unknown selector must revert");
        bytes4 gotSelector = bytes4(ret);
        assertEq(gotSelector, MeshPortRefunds.DirectDepositNotAllowed.selector, "should be DirectDepositNotAllowed");
    }

    // ══════════════════════════════════════════════════════════
    //  8. FUZZ TEST — amount 1 to type(uint128).max
    // ══════════════════════════════════════════════════════════

    /// @dev forge will run this hundreds of times with random `amount` values.
    function testFuzz_Amount_CustomerBalanceDeltaEqualsAmount(uint256 amount) public {
        // Bound to the valid range [1, type(uint128).max]
        amount = bound(amount, 1, uint256(type(uint128).max));

        // Use a fresh paymentRef per fuzz run (derived from amount to avoid collisions across
        // runs within a single fuzz campaign — forge resets state between calls so this is
        // mostly defensive)
        bytes32 ref = keccak256(abi.encode("fuzz", amount));

        // Seed the merchant with enough native
        vm.deal(merchant, amount);

        uint256 beforeBal = alice.balance;

        vm.prank(merchant);
        refunds.refund{value: amount}(ref, payable(alice), "fuzz");

        assertEq(alice.balance - beforeBal, amount, "customer balance delta must equal amount");
        assertEq(address(refunds).balance,  0,       "contract must hold no funds");
        assertTrue(refunds.isRefunded(merchant, ref), "must be marked as refunded");
    }
}
