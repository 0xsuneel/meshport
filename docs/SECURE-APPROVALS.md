# Secure approvals: the passcode and "what you approve" live in the wallet frame

Why (audit 7 Nov 2026, findings C1, C3, M4, H8, H10): the passcode is typed in
the app's own page and handed to the wallet frame, so code running in the app
page (a bad npm dependency, an extension, an XSS) could read it, and one
approval let the page sign anything. The fix is to make the wallet frame's
origin (wallet.meshport.xyz) the only place the passcode is typed and the
only place that decides what an approval covers.

## Phase 1 — approvals bound to what is shown

Update 7 Nov: the passcode is entered on the app's own shared passcode pad
(the same one as the lock screen) on every screen. The sheet's intent goes
to the wallet frame with the passcode (`fastpay:approve`), which checks the
passcode and binds the approval to that intent. The frame-hosted keypad
page (`confirm.html`, below) is kept in the frame but not used by the app.

Original phase 1 design:

- `wallet-frame/confirm.html`: a keypad page on the wallet origin, shown in
  the app as a visible iframe (the same pattern as `reveal.html`). It shows
  what is being approved ("Pay 5 USDC to 0x12…ab") as text drawn by the
  frame, and takes the passcode. The app never sees the digits.
- The hidden wallet frame opens a one-time ticket for each approval
  (`confirm:open`, with the intent: pay / transfer / swap / bring and its
  token, amount, recipient), checks the passcode typed on the keypad page
  itself (BroadcastChannel, same origin only), and tells the app only
  "approved" with that ticket.
- The app's `PinSheet` shows that page instead of its own keypad whenever
  the frame supports it and the wallet's passcode lives in the frame.
  `verifyPasscode` accepts the frame's ticket, so the ~20 screens that use
  `PinSheet` keep working unchanged.
- Express signatures are bound to the approved intent:
  - a payment pull must pay exactly the approved amount, token and
    recipient (plus the key's gas refund and MeshPort's fee, capped);
  - a transfer's burn must match the approved amount, destination and
    recipient;
  - a swap's pull must be the approved token and amount;
  - a Bring must be for the approved chain and amount.
  An approval without an intent (an older app, a screen that didn't pass
  one) no longer covers an Express pull: that move goes the normal way.
- Fingerprint stays as a button next to the keypad; until phase 2 it still
  opens the passcode in the app. The lock screen keeps the app's keypad
  until phase 2.

## Phase 2 — fingerprint unlock and the lock screen in the frame

- The lock screen uses the same keypad page.
- Fingerprint (WebAuthn PRF) moves into the frame origin: the sealed
  passcode is kept in the frame, opened there, never in the app. Existing
  fingerprint set-ups need one re-enrolment.
- Private-key wallets: approvals bound to the transaction digest instead of
  a 2-minute window (H8).
- A passcode reset in the frame (`circle-passcode:forget`) only from the
  keypad page with the current passcode, or after a fresh sign-in the frame
  can verify (H10).

## Phase 3 — Circle's session out of the app (C3)

- A separate origin (e.g. `circle.meshport.xyz`) holds the Circle user token
  and encryption key and runs Circle's Web SDK; the app asks it for typed
  signatures the same way it asks the wallet frame. Kept apart from the
  wallet frame on purpose: Circle's SDK is third-party code and must not run
  in the origin that holds private keys.
- Needs: a new Vercel project for that origin, the Google OAuth redirect URI
  and Circle's allowed domain updated to it, and a one-time re-sign-in.
