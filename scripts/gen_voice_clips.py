# Generates public/voice/emma2/*.mp3 (except chime.mp3) - the phrases src/lib/voiceAlerts.ts joins.
#
# Kokoro-82M v1.0 (kokoro-multi-lang-v1_0, voice bf_emma = speaker 21) via sherpa-onnx 2.x:
#   pip install sherpa-onnx numpy
#   curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 && tar xjf kokoro-multi-lang-v1_0.tar.bz2
#   python3 scripts/gen_voice_clips.py kokoro-multi-lang-v1_0 public/voice/emma2
# Needs ffmpeg. Speed 1.05. Each clip: silence trimmed (30 ms kept), peak -1 dBFS,
# 24 kHz mono MP3 48 kbps.
#
# Whole phrases, not single words, so each keeps its natural rhythm:
#   received            "Received,"
#   t1-t99              "twenty four thousand"
#   h1-h9               "two hundred"
#   da1-da99            "twenty four dollars and"     (one_dollar_and: "one dollar and")
#   do1-do99            "twenty four dollars, on Mesport."  (one_dollar_on)
#   c1-c99              "fifty cents, on Mesport."    (c1: "one cent, on Mesport.")
#   dollars_and / dollars_on   after "... hundred" with no tens ($1,200)
# "Mesport" is added to the lexicon as m-EH-s-p-AO-r-t (it is not an English word).
import sys, os, subprocess, tempfile, numpy as np, sherpa_onnx
M, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
lex = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
lex.write(open(f"{M}/lexicon-us-en.txt", encoding="utf-8").read().rstrip("\n") + "\nmesport m ˈ ɛ s p ɔ ɹ t\n"); lex.close()
tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
    kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(model=f"{M}/model.onnx", voices=f"{M}/voices.bin", tokens=f"{M}/tokens.txt",
        data_dir=f"{M}/espeak-ng-data", lexicon=lex.name, dict_dir=f"{M}/dict", lang="en-us"),
    num_threads=4)))
SID, SPEED = 21, 1.05
ones = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
tens = "twenty thirty forty fifty sixty seventy eighty ninety".split()
def words(n):
    if n < 20: return ones[n-1]
    t, o = divmod(n, 10)
    return tens[t-2] + ("" if o == 0 else " " + ones[o-1])
ON = "on Mesport."
clips = {"received": "Received,", "dollars_and": "dollars and", "dollars_on": f"dollars, {ON}",
         "one_dollar_and": "one dollar and", "one_dollar_on": f"one dollar, {ON}"}
for n in range(1, 100):
    w = words(n)
    clips[f"t{n}"] = f"{w} thousand"
    clips[f"da{n}"] = f"{w} dollars and"
    clips[f"do{n}"] = f"{w} dollars, {ON}"
    clips[f"c{n}"] = f"{w} {'cent' if n == 1 else 'cents'}, {ON}"
for n in range(1, 10):
    clips[f"h{n}"] = f"{words(n)} hundred"
for name, text in clips.items():
    a = tts.generate(text, sid=SID, speed=SPEED)
    x = np.array(a.samples, dtype=np.float32)
    env = np.abs(x); idx = np.where(env > 0.015 * env.max())[0]
    pad = int(0.03 * a.sample_rate)
    x = x[max(0, idx[0]-pad): min(len(x), idx[-1]+pad)]
    x = x / np.abs(x).max() * 10 ** (-1/20)
    subprocess.run(["ffmpeg","-v","error","-y","-f","f32le","-ar",str(a.sample_rate),"-ac","1","-i","-",
                    "-ar","24000","-ac","1","-c:a","libmp3lame","-b:a","48k",f"{OUT}/{name}.mp3"], input=x.tobytes(), check=True)
os.unlink(lex.name)
print(len(clips), "clips")
