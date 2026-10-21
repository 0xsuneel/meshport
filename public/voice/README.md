# Voice-alert phrases

Recorded phrases the business app joins to announce a payment
(see `src/lib/voiceAlerts.ts` for the clip names).

- `emma/` - British English female voice ("bf_emma"), generated with
  [Kokoro-82M](https://github.com/hexgrad/kokoro) via sherpa-onnx.
  Kokoro and its voices are licensed under the Apache License 2.0.
- `emma/chime.mp3` - the MeshPort chime (three rising bell notes), our own.

Each clip is trimmed and peak-normalised, 24 kHz mono MP3.
