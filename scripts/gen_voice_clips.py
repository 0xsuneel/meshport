# Generates public/voice/emma/*.mp3 (except chime.mp3) - the words src/lib/voiceAlerts.ts joins.
#
# Kokoro-82M (kokoro-en-v0_19, voice bf_emma = speaker 7) via sherpa-onnx 1.10.46
# (2.x needs a lexicon this model does not ship):
#   pip install "sherpa-onnx==1.10.46" numpy
#   curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2 && tar xjf kokoro-en-v0_19.tar.bz2
#   python3 scripts/gen_voice_clips.py kokoro-en-v0_19 public/voice/emma
# Needs ffmpeg. Each clip: silence trimmed, peak -1 dBFS, 24 kHz mono MP3 32 kbps.
import sys, os, subprocess, numpy as np, sherpa_onnx
M, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
    model=f"{M}/model.onnx", voices=f"{M}/voices.bin", tokens=f"{M}/tokens.txt", data_dir=f"{M}/espeak-ng-data"), num_threads=4)))
ones = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
tens = "twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    if n < 20: return ones[n-1]
    t, o = divmod(n, 10)
    return tens[t-2] + ("" if o == 0 else " " + ones[o-1])
clips = {f"n{n}": words(n) for n in range(1, 100)}
clips.update({
    "received": "Received", "hundred": "hundred", "thousand": "thousand",
    "dollars_and": "dollars and", "dollar_and": "dollar and",
    "dollars_on": "dollars, on Mesport.", "dollar_on": "dollar, on Mesport.",
    "cents_on": "cents, on Mesport.", "cent_on": "cent, on Mesport.",
})
SR = 24000
for name, text in clips.items():
    a = tts.generate(text, sid=7, speed=1.0)
    x = np.array(a.samples, dtype=np.float32)
    # trim silence (keep 20 ms), peak-normalise to -1 dBFS
    env = np.abs(x); thr = 0.02 * env.max(); idx = np.where(env > thr)[0]
    pad = int(0.02 * a.sample_rate)
    x = x[max(0, idx[0]-pad): min(len(x), idx[-1]+pad)]
    x = x / np.abs(x).max() * 10 ** (-1/20)
    subprocess.run(["ffmpeg","-v","error","-y","-f","f32le","-ar",str(a.sample_rate),"-ac","1","-i","-",
                    "-ar",str(SR),"-ac","1","-c:a","libmp3lame","-b:a","32k",f"{OUT}/{name}.mp3"], input=x.tobytes(), check=True)
print(len(clips), "clips")
