# Voice-alert words

Short recorded words the business app joins to announce a payment
(see `phrasesFor` in `src/lib/voiceAlerts.ts`), e.g. $24.50 =
`received` + `n24` + `dollars_and` + `n50` + `cents_on`.

- `emma/` - British English female voice ("bf_emma"), generated with
  [Kokoro-82M](https://github.com/hexgrad/kokoro) via sherpa-onnx
  (`scripts/gen_voice_clips.py`). Kokoro and its voices are licensed under
  the Apache License 2.0.
  - `received`, `hundred`, `thousand`
  - `n1` … `n99` - "one" … "ninety nine"
  - `dollar_and` / `dollars_and`, `dollar_on` / `dollars_on` ("dollars, on Mesport.")
  - `cent_on` / `cents_on` ("cents, on Mesport.")
- `emma/chime.mp3` - the MeshPort chime (three rising bell notes), our own.

Each clip is trimmed and peak-normalised, 24 kHz mono MP3. 108 words cover
every amount up to $99,999.99 (larger ones use the device's own speech).
