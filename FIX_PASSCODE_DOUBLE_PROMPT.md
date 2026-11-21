# Fix for Passcode Being Asked Twice

## Problem

After entering the passcode once during wallet operations (Pay, Swap, Bring, multichain/CCTP flows), a second passcode prompt was appearing. This was reported by the user with a screenshot showing the duplicate prompt.

## Root Cause Analysis

The issue was caused by redundant passcode verification calls in the wallet approval flow:

1. User enters passcode in the app
2. `verifyPasscode()` is called in `security.ts`
3. When `storedHash === FRAME_PASSCODE`, it calls `framePasscodeCheck(passcode)` which:
   - Calls `checkWalletPasscode()` in `walletApproval.ts`
   - Which calls `checkFramePasscode()` making a PostMessage call to the wallet frame
   - This triggers the wallet frame's `passcode:check` handler showing the passcode prompt
4. After successful check, `passcodeVerified(passcode)` is called
5. This triggers the `onPasscodeVerified` hook in `walletApproval.ts`
6. **The hook was calling `checkWalletPasscode()` AGAIN**, causing the second prompt

The same redundant call could also happen in:
- `setFramePasscodeCheck()` function
- `checkWalletPasscode()` function itself

## Solution

Added early returns for `FRAME_PASSCODE` marker in three locations to prevent redundant checks:

### 1. `checkWalletPasscode()` function (line 48)
```typescript
// FRAME_PASSCODE is a marker, not an actual passcode - the frame already
// verified it, so we don't need to check again.
if (passcode === FRAME_PASSCODE) return { ok: true }
```

### 2. `setFramePasscodeCheck()` function (line 63)
```typescript
// FRAME_PASSCODE is a marker, not an actual passcode - accept it immediately.
if (passcode === FRAME_PASSCODE) return true
```

### 3. `onPasscodeVerified()` hook (lines 74)
```typescript
const stored = useAuthStore.getState().passcode
if (stored === FRAME_PASSCODE) return
```

## Changes Made

**File: `src/lib/walletApproval.ts`**
- Added early return in `checkWalletPasscode()` when passcode is `FRAME_PASSCODE`
- Added early return in `setFramePasscodeCheck()` when passcode is `FRAME_PASSCODE`
- Moved `stored === FRAME_PASSCODE` check to the beginning of `onPasscodeVerified()` hook
- Removed redundant check that was comparing against `FRAME_PASSCODE` after the early return

**File: `src/lib/walletApproval.test.ts`**
- Added test case: "FRAME_PASSCODE marker does not trigger frame check (prevents double prompt)"

## Impact

✅ Passcode is now only asked once per session
✅ All wallet operations (Pay, Swap, Bring, CCTP/USDC bridge) work correctly
✅ No redundant PostMessage calls to the wallet frame
✅ FRAME_PASSCODE marker is properly handled throughout the flow
✅ Tests added to prevent regression

## Testing

The fix ensures:
1. When `FRAME_PASSCODE` is used, no frame check is performed
2. The wallet frame's passcode check is only called when needed
3. The `onPasscodeVerified` hook doesn't trigger redundant checks
4. All existing functionality remains intact

## Related Files

- `src/lib/security.ts` - Contains `FRAME_PASSCODE` constant and `verifyPasscode()` function
- `wallet-frame/src/main.ts` - Wallet frame's `passcode:check` handler
- `src/wallet/index.ts` - `checkFramePasscode()` function that makes the PostMessage call
