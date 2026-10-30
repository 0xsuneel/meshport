# Biometric unlock (WebAuthn PRF)

Code: `src/lib/biometric.ts`. Tests: `src/lib/biometric.registration.test.ts`.

## Model

The passcode is sealed with AES-GCM under a key derived (HKDF) from the
WebAuthn **PRF** output of a platform credential. The key is never stored.
No PRF means no biometric unlock: there is deliberately no weaker fallback.
Passcode login is independent of all of this and always works.

## Registration sequence

1. `navigator.credentials.create()` with `prf.eval.first = salt`,
   `authenticatorAttachment: 'platform'`, `userVerification: 'required'`.
2. `getClientExtensionResults().prf`:
   - `enabled: false` → unsupported; the credential is discarded, nothing saved.
   - `enabled: true` with or without `results.first` → continue.
3. `navigator.credentials.get()` for that credential with the **same salt**.
   This produces the PRF output when create() didn't, and is the
   verification test in every case (it is exactly the unlock path). If
   create() did return an output, both must match.
4. Seal, decrypt again, compare; then write credential id + sealed record
   together (both removed if either write fails).
5. Only then does the UI set `biometricEnabled` in the store.

Any failure after create() discards the credential via
`PublicKeyCredential.signalUnknownCredential` where supported. If step 3's
prompt is refused for lack of a fresh tap (Safari allows one prompt per
gesture), the page shows "Confirm with …"; Skip discards the credential.

Errors are classified (`cancelled`, `unsupported`, `no-screen-lock`,
`security`, `exists`, `storage`, `mismatch`, `error`) and shown with
specific messages instead of all being reported as "cancelled".

## Unlock and payments

- `unlockWithBiometric()` never throws. A cancel/failure falls back to the
  passcode pad.
- "Use passcode" or typing aborts the open OS prompt (`AbortSignal`); a late
  result is ignored.
- A record that no longer works (no PRF output, or doesn't decrypt) is
  removed and the setting turned off, so later payments go straight to the
  passcode instead of showing a prompt that can't work.
- After 3 unconfirmed prompts in a row the prompt no longer opens by itself
  (the key stays). Reset by any success.

## Lifecycle

| Event | Effect |
|---|---|
| Settings → off | record removed, credential signalled unknown |
| Re-enable | same user handle per wallet, so the passkey is replaced, not duplicated |
| Passcode change | one scan re-seals with a fresh salt; the old record is removed first. If the prompt is cancelled or refused (Safari: no fresh tap after hashing), the Enable screen asks for one tap to finish ("Keep Face ID on?"); Skip turns it off |
| Logout | record removed (store `logout()`) |
| Credential deleted in OS | prompt fails like a cancel → passcode |
| Storage cleared / other container | `AppLayout` turns the setting off |

## RP ID / origin

`rp.id` is not set, so it defaults to the page's hostname: `meshport.xyz` in
production, the preview host on Vercel previews, `localhost` in dev. The
record lives in localStorage of that same origin, so a credential and its
record can't end up on different hosts. `www.meshport.xyz` (if served
without redirect) would be a separate registration. The app's
`Permissions-Policy` doesn't restrict `publickey-credentials-*`, so the
default (`self`) applies to the top-level page.

## Biometric vs. user verification

`userVerification: 'required'` means "the device verified its owner". The
platform decides how: Windows Hello accepts its PIN, Android accepts the
screen-lock PIN/pattern, iOS/macOS fall back to the device passcode. No web
API can demand biometric-only; the Enable screen says so.

## Platforms

Verified here: unit tests with a PRF-computing fake authenticator, and a
real-browser run on Chromium 153 using the DevTools virtual platform
authenticator (with PRF, without PRF, without UV): register, unlock, reload,
passcode change, UV failure, credential deletion, disable/re-enable.

**Not verified on physical devices.** Expected behaviour from vendor support:

| Platform | Expectation |
|---|---|
| Android Chrome / installed PWA | PRF via Google Password Manager passkeys. create() often reports `enabled: true` without output → the extra get() handles it. PWA shares storage with Chrome. |
| Android fingerprint | Works through the screen lock; PIN/pattern also accepted. |
| iPhone / iPad Safari 18+ | PRF with iCloud Keychain passkeys; Apple shows "Save a passkey" first. Older iOS: no PRF → unsupported (passcode only). |
| iPhone / iPad home-screen PWA | Separate storage from Safari: enable separately in the PWA. |
| macOS Touch ID | Safari 18+ with iCloud Keychain supports PRF; other browsers depend on where the passkey is saved. |
| Windows Hello | Older Windows Hello has no PRF → unsupported, cleanly refused. Support depends on Windows and browser version. |
| Third-party passkey managers | May not implement PRF → unsupported. |

## Remaining limitations

These can't be fixed in web code without weakening the design:

- **No PRF (older iOS before 18, older Windows Hello, some third-party
  passkey managers):** biometric unlock is refused cleanly and the passcode
  is used. Supporting them would mean storing a key script can read, which
  is the insecure downgrade this design rules out.
- **iPhone/iPad home-screen app vs Safari tab:** iOS gives them separate
  storage, so each needs its own enable. The lock screen offers it in the
  app automatically (24h cooldown after Skip).
- **Browsers without `getClientCapabilities()`:** PRF support is found out
  at registration (one OS prompt, then a clear "unsupported" message).
- **Browsers without `signalUnknownCredential`** (before Chrome 132 /
  Safari 26): a discarded credential may stay listed in the OS passkey
  manager. Harmless (unusable without its record); re-enabling uses the same
  user handle, so it is replaced rather than duplicated where the manager
  stores passkeys by user.
- **Storage eviction:** after registration the app asks for persistent
  storage (`navigator.storage.persist()`). Browsers may decline, and Safari's
  7-day rule for sites not added to the Home Screen still applies; the
  setting then turns off and the passcode is used.
