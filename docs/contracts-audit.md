# MeshPort Contracts Audit

> **Status (2026-10-07):**
> - **C-1 — rejected, not applied.** Arc USDC exposes an ERC-20 interface at
>   `0x3600…0000` (6 decimals); `MeshPortRewards` was deployed against it and
>   production has 26 completed on-chain reward claims. Rewriting it to native
>   `msg.value` would break working rewards.
> - **H-1 — fixed** in `contracts/MeshPortBridgeRouter.sol` (takes effect on redeploy).
> - **M-1 — fixed** in `contracts/MeshPortRewards.sol`: 2-day timelock (takes effect on redeploy).
> - **L-1 — fixed** in `contracts/MeshPortRewards.sol`: two-step, timelocked ownership transfer.
> - **L-2 — not fixed:** per-day mapping entries are normal contract storage; not worth the extra gas/complexity.

**Date:** 2026-10-07  
**Contracts:** P2PMeshportEscrowV2.sol, MeshPortBridgeRouter.sol, MeshPortRewards.sol  
**Target chain:** Arc Testnet (chain ID 5042002) — native currency is USDC (18 dec), no ERC-20 for native asset  
**Auditors:** solidity-auditor (rule corpus, max severity) + functional-auditor (adversarial, max severity)

---

## Summary Table

| Severity | Count | Fixed? |
|---|---|---|
| CRITICAL | 1 | No — needs contract changes |
| HIGH | 1 | No — needs contract changes |
| MEDIUM | 1 | No — needs contract changes |
| LOW | 2 | No |
| INFO | 2 | No |

---

## CRITICAL

### C-1: MeshPortRewards uses ERC-20 USDC interface — incompatible with Arc native USDC
**Location:** `MeshPortRewards.sol:17-21, 99, 156, 170, 224`  
**Contract:** MeshPortRewards  

**Description:**  
`MeshPortRewards` declares an `IUSDC` interface with `transfer`, `transferFrom`, and `balanceOf` and constructs with a `_usdcToken` address. On Arc Testnet, USDC is the **native gas currency** — it is NOT an ERC-20 contract. There is no token address to call `transfer()` on; value moves via `msg.value` / `.call{value: amount}`.

As deployed on Arc Testnet, every function in this contract that touches USDC is broken:
- `fundTreasury` — calls `IUSDC.transferFrom()` → reverts (no ERC-20 contract at that address)
- `claimRewards` — calls `IUSDC.transfer()` → reverts
- `treasuryBalance` / `withdrawTreasury` — calls `IUSDC.balanceOf()` → reverts
- The entire rewards payout system is non-functional on Arc

**PoC:** Call `claimRewards(100, claimId, sig)` with a valid signature on the deployed Arc Testnet contract — it will revert with a low-level call failure because the `usdcToken` address is either address(0) (if not set) or the USDC ERC-20 address from another chain (which does not exist on Arc).

**Recommendation:**  
Rewrite the treasury accounting to use native value:
```solidity
// Fund: payable function
function fundTreasury() external payable {
    require(msg.value > 0, "zero amount");
    emit TreasuryFunded(msg.sender, msg.value, block.timestamp);
}

// Balance
function treasuryBalance() public view returns (uint256) {
    return address(this).balance;
}

// Claim payout
(bool ok, ) = payable(msg.sender).call{value: usdcAmount}("");
if (!ok) revert TransferFailed();

// Withdraw
(bool ok, ) = payable(owner).call{value: amount}("");
if (!ok) revert TransferFailed();
```
Remove the `IUSDC` interface and `usdcToken` state variable entirely. The constructor no longer needs `_usdcToken`.

---

## HIGH

### H-1: MeshPortBridgeRouter post-burn allowance reset return value not checked
**Location:** `MeshPortBridgeRouter.sol:169`  
**Contract:** MeshPortBridgeRouter  

**Description:**  
After `tokenMessenger.depositForBurn(...)` completes, line 169 calls:
```solidity
usdc.approve(address(tokenMessenger), 0);
```
The return value is **not checked**. The pre-burn approvals (lines 151-152) correctly revert on failure with `ApproveFailed()`. The post-burn reset does not. If this call fails silently (e.g. on a USDC version that returns `false` instead of reverting), a residual allowance remains on `tokenMessenger` after the transaction. A future deposit to this router on the same USDC instance would then start with a non-zero allowance, which the pre-burn zero-reset on line 151 is intended to clear — but the non-zero-to-non-zero revert protection documented on lines 146-150 assumes the pre-burn reset always lands. This is defense-in-depth breakage rather than an immediate drain path.

**Recommendation:**  
```solidity
// Line 169 — make the post-burn reset mandatory
if (!usdc.approve(address(tokenMessenger), 0)) revert ApproveFailed();
```

---

## MEDIUM

### M-1: MeshPortRewards admin actions lack timelock — signer rotation and rate changes are instant
**Location:** `MeshPortRewards.sol:182 (setPointsSigner), 195 (setConversionRate), 220 (withdrawTreasury)`  
**Contract:** MeshPortRewards  

**Description:**  
`pointsSigner`, `usdcPerThousandPoints`, and `withdrawTreasury` are all single-transaction `onlyOwner` operations with no timelock or multisig. If the owner key is compromised:
- Attacker rotates `pointsSigner` to their own key → signs unlimited claim vouchers → drains treasury in one block
- Attacker calls `withdrawTreasury(totalBalance)` → full treasury drained immediately

Users have no reaction window. There are no on-chain events queued before execution.

**Note:** This finding is lower-priority to fix than C-1 because the contract is currently non-functional on Arc (see C-1), but must be addressed before any fixed version goes to mainnet.

**Recommendation:**  
Implement a two-step timelock for `setPointsSigner`, `setConversionRate`, and `withdrawTreasury`:
```solidity
uint256 public constant TIMELOCK_DELAY = 2 days;
mapping(bytes32 => uint256) public timelockQueue;

function queueSignerUpdate(address newSigner) external onlyOwner {
    timelockQueue[keccak256(abi.encode("signer", newSigner))] = block.timestamp + TIMELOCK_DELAY;
    emit SignerUpdateQueued(newSigner, block.timestamp + TIMELOCK_DELAY);
}

function executeSignerUpdate(address newSigner) external onlyOwner {
    bytes32 key = keccak256(abi.encode("signer", newSigner));
    require(timelockQueue[key] != 0 && block.timestamp >= timelockQueue[key], "timelock");
    delete timelockQueue[key];
    pointsSigner = newSigner;
    emit PointsSignerUpdated(pointsSigner, newSigner);
}
```

---

## LOW

### L-1: MeshPortRewards — `owner` is immutable, no transfer mechanism
**Location:** `MeshPortRewards.sol:27`  

**Description:**  
`owner` is set in the constructor and marked `immutable` — there is no `transferOwnership` or two-step ownership transfer. If the owner key is lost, `setPointsSigner`, `setConversionRate`, `pauseClaims`, `unpauseClaims`, and `withdrawTreasury` are all permanently inaccessible. For a contract holding user funds this is a fund-lock risk if the deployer key is compromised or lost.

**Recommendation:** Add a two-step `transferOwnership` / `acceptOwnership` pattern (OpenZeppelin's `Ownable2Step`). Since `owner` is currently `immutable`, this requires making it a storage variable:
```solidity
address public owner;
address public pendingOwner;

function transferOwnership(address newOwner) external onlyOwner {
    pendingOwner = newOwner;
}
function acceptOwnership() external {
    require(msg.sender == pendingOwner, "not pending owner");
    owner = pendingOwner;
    pendingOwner = address(0);
}
```

### L-2: MeshPortRewards — `dailyClaimed` mapping never cleaned, unbounded growth
**Location:** `MeshPortRewards.sol:44`  

**Description:**  
`dailyClaimed[user][day]` is written on every claim and never deleted. Over time this mapping grows indefinitely (one entry per user per day they claim). On a busy testnet this is negligible, but on mainnet at scale it produces unbounded state growth with no pruning mechanism.

**Recommendation:** Either add a `delete dailyClaimed[user][day - 1]` cleanup on claim (pruning yesterday's entry), or use a single uint256 per user that stores `(day << 128 | amount)` and compares the packed day field before use, avoiding per-day storage entirely.

---

## INFO

### I-1: P2PMeshportEscrowV2 — role separation design is sound, no issues found
**Location:** `P2PMeshportEscrowV2.sol` (all)  

The three previously-documented vulnerabilities (offer hijack, trusted release params, unconstrained admin release) are correctly fixed. Checks-effects-interactions ordering is consistent on all value-sending functions. OpenZeppelin `ReentrancyGuard` is applied correctly. The mutual-exclusivity constraint on roles (no address holds more than one role) is enforced at grant time and re-verified at acceptance time for `acceptAdmin()`. The `SUBMITTED_UNKNOWN` / `CONFIRMED` state machine in off-chain tracking aligns correctly with on-chain trade state.

**No findings for P2PMeshportEscrowV2.**

### I-2: MeshPortBridgeRouter — architecture is sound, relayer cannot redirect funds
**Location:** `MeshPortBridgeRouter.sol` (all)  

The deterministic nonce design (`bridgeNonce` = hash of all bridge parameters) correctly prevents the relayer from changing any user-signed parameter. `receiveWithAuthorization` enforces `to == msg.sender` (the router), so the authorization cannot be replayed outside the router. No funds or allowances persist between transactions. The `receive()` revert prevents accidental native-token lockup.

The only finding is the unchecked post-burn `approve(0)` return value (H-1 above).

---

## Fix Priority

| Priority | Action |
|---|---|
| 1. CRITICAL | Rewrite MeshPortRewards treasury/claim to native USDC (payable), remove ERC-20 interface |
| 2. HIGH | Check return value of post-burn `approve(0)` in MeshPortBridgeRouter |
| 3. MEDIUM | Add timelock to MeshPortRewards admin functions before any mainnet deploy |
| 4. LOW-L1 | Replace immutable `owner` with `Ownable2Step` in MeshPortRewards |
| 5. LOW-L2 | Add daily-claim storage pruning in MeshPortRewards |
