# whisper.cpp dictation bench (Android plan M4, 2026-10-26)

`npx tsx scripts/bench-stt.ts --bin <whisper-server.exe> --models <dir> --threads 4,8 --fleurs 8` — the script, the stand-in lessons and the reading scripts are in `scripts/bench-stt/`.

**Setup.** whisper.cpp official `whisper-bin-x64` CPU build (`whisper-server`), Intel i5-14600KF (20 threads), 32 GB. Servers run `temperature 0`, `response_format json`, one warm-up request before timing. Speed = audio seconds / wall seconds for the HTTP request, so 1.0 is exactly real time.

**Clips.**
- *FLEURS*: the first 8 distinct utterances of the test split (nb_no 176 words / 99 s, en_us 160 words / 77 s). The "vocabulary" rows give this unrelated speech the technical lesson's prompt, so they measure what a stale prompt costs.
- *tech*: the owner reading the script in `lesson-<lang>.json` (nb 89 words / 50 s, en 119 words / 59 s), one speaker, one take each. The prompt is the real pipeline's `dictationVocabulary` over that lesson fixture, which contains only some of the clip's terms.

**Scoring.** Word error rate after lower-casing and stripping punctuation and hyphens; the transcripts go through the app's own `cleanWhisperText` and `dropPromptEcho`. One 89–119 word clip: a single word is about 1% WER, so differences of 1–3 points are noise.

## Results

| Lang | Model | Threads | FLEURS WER | FLEURS + prompt | Speed | tech WER | tech + prompt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| nb | nb-whisper-small q5_0 (175 MB) | 4 | 6.3% | 7.4% | 5.4× | 15.7% | 19.1% |
| nb | nb-whisper-small q5_0 | 8 | 6.3% | 7.4% | 8.0× | 18.0% | 15.7% |
| nb | nb-whisper-medium q5_0 (539 MB) | 4 | 4.5% | 5.1% | 1.7× | 21.3% | 18.0% |
| nb | nb-whisper-medium q5_0 | 8 | 4.5% | 5.1% | 2.6× | 21.3% | 14.6% |
| en | whisper small.en q5_1 (190 MB) | 4 | 8.1% | 6.9% | 4.8× | 1.7% | 0.8% |
| en | whisper small.en q5_1 | 8 | 8.1% | 7.5% | 7.0× | 1.7% | 0.8% |
| en | large-v3-turbo q5_0 (574 MB) | 4 | 5.6% | 6.9% | 0.9× | 3.4% | 0.8% |
| en | large-v3-turbo q5_0 | 8 | 5.6% | 6.9% | 1.4× | 3.4% | 0.8% |

Model load is 0.2–0.4 s (the files are memory-mapped). Raw numbers: `data/models/whispercpp/results.json` (not in git).

## What the numbers say

- **Speed decides the model on a tablet.** Live dictation transcribes each 8–25 s piece while the learner keeps talking, so it has to run faster than real time. The medium and turbo models are 0.9–2.8× here; this desktop CPU is likely several times faster than a tablet's. Owner's pick: **small for both languages** (`WHISPERCPP_MODELS` in `src/core/language.ts`); M7 re-measures on the device.
- **The vocabulary prompt helps on its job.** English technical clip: 1.7→0.8% (small) and 3.4→0.8% (turbo); "Tevinin" and "Thevenin" become "Thévenin". Norwegian is noisier: small 18.0→15.7% at 8 threads but 15.7→19.1% at 4; medium 21.3→14.6% / 21.3→18.0%. Owner's pick: **on** whenever the chat has terms.
- **Its cost on unrelated speech is about 1 point** (nb 6.3→7.4%, en turbo 5.6→6.9%); en small went the other way (8.1→6.9 / 7.5%).
- **Artefacts seen:** turbo + prompt once ended with a doubled word ("harmonics. harmonics."); turbo without a prompt appended "Thank you." (the silence-hallucination family); nb medium + prompt left a stray ". Og". The echo guard only removes a transcript that is three or more consecutive prompt words, so none of these are caught.
- **Threads:** 4→8 gave about 1.4–1.5× on this PC. Left to whisper-server's default (`min(4, cores)`); M7 sets the Android value from device measurements.
- The same model gave different Norwegian technical WER at 4 and 8 threads (15.7% vs 18.0%, no prompt): floating-point order changes a greedy decode. Another reason not to over-read one clip.
- Norwegian technical terms stay hard: "Thévenin-ekvivalenten" became "TV9-ekvivalenten" (small) and "the thevenin ekvivalent" (medium) without the prompt; "Norton-strømmen" became "Mortenstrømmen".

## To record this better next time

More than one speaker and take per language, and a script with more distinct terms, would make the prompt comparison meaningful for Norwegian. A recording on the tablet's own microphone is the M7 check.
