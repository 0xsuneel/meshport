# MeshPort Android app (Play Store)

The Android app is a Trusted Web Activity: a small Android shell that opens
https://meshport.xyz full screen in Chrome. It is built with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) from
`twa-manifest.json` in this folder.

## The line above the gesture bar

Installed from Chrome (a WebAPK), Android draws a thin separator line above
its navigation/gesture bar, and no website setting can change it. In this app
it is set by `navigationDividerColor` / `navigationDividerColorDark`, which
match the bar (`navigationColor` / `navigationColorDark`), so no line shows.

## Build

```sh
npm i -g @bubblewrap/cli
cd android
bubblewrap update   # generates the Android project from twa-manifest.json
bubblewrap build    # signed app bundle: app-release-bundle.aab
```

Before the first build:

- `packageId` (`xyz.meshport.app`) is a placeholder - choose the final one;
  it can never change after the first Play Store upload.
- `bubblewrap build` creates `android.keystore` if it is missing. Keep it and
  its passwords safe and out of git - an app can't be updated without its key.
- After uploading to Play Console, copy the app-signing SHA-256 fingerprint
  into `public/.well-known/assetlinks.json` (Digital Asset Links), or the app
  opens with an address bar.
