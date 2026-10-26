# Dictation speed on the Pixel 7 Pro: what was slow and what fixes it (2026-10-26)

Why: after the first M7 lesson the owner waited 30-60 s after finishing speaking before the dictated text appeared. All numbers are from the phone (Tensor G2), with Termux in the background and the wake lock held, the situation during a lesson (Chrome in front). Whisper.cpp `231638a`, nb-whisper-small q5_0 unless stated, 4 threads, `temperature=0`, no vocabulary prompt.

## What was going wrong

1. **Termux gets cores 0-5 only.** Android puts a background Termux in the `foreground` cpuset (`Cpus_allowed_list: 0-5`): the four A55 and the two A78, **not the two X1 cores**. The M0 numbers were taken with Termux in front (all 8 cores) and were too optimistic for a lesson.
2. **Whisper always encodes a 30 s window.** A 5 s piece costs as much encoder time as a 30 s one. `whisper-server -ac 640` (about 12.8 s of audio context) cuts this; it is the biggest single lever.
3. **The app's pieces are 8-25 s and run one after another** (`components/dictation-live.ts`). At 0.4-0.8x real time a 25 s piece takes 30-60 s, and pieces queue behind each other.
4. **Long pieces lose text.** With 8-25 s pieces the small model sometimes stops early and silently drops a sentence or two; 3-8 s pieces keep them. A tiny trailing piece (under 1 s) produced the junk text "Hva?-A.".
5. **Decoder runaways.** Without `-ac`, single short pieces took 13-50 s (a decode that does not stop); with `-ac 640` the slowest piece was 1-5 s.

## Measured (speed = audio seconds / wall seconds; WER = word error rate)

Piece sets are the app's own segmenter run on the owner's "tech" recording (nb, 50 s, 89 words) and on 8 FLEURS Norwegian utterances (99 s, 176 words), at 8-25 s ("app"), 4-12 s ("mid") and 3-8 s ("short").

| Setup (nb, short pieces) | Speed (CPU) | Speed (GPU, Vulkan) | WER tech | WER FLEURS |
|---|---|---|---|---|
| small, default (today's server flags) | 0.20-0.69x | n/a | 24.7-43.8% (by piece set) | n/a |
| small, `-nf` | 0.37-0.50x | 0.66-0.80x | 24.7% | 12.5% CPU / 14.8% GPU |
| small, `-nf -ac 640` | 1.3-1.7x | 1.9-2.3x | 34.8% CPU / 29.2% GPU | 8.5% CPU / 9.7% GPU |
| base q5_0, `-nf -ac 640` | 5.0-5.9x | 5.1-5.5x | 24.7% | 17.0% |
| tiny q5_0, `-ac 640` | 12x | n/a | 44.9% | n/a |

- `-nf` (no temperature fallback) does not change the text and removes much of the worst-case time.
- 6 threads is no faster than 4; two threads on the A78 cores alone are slower (0.66-0.71x).
- Run-to-run speed swings by up to 40% (thermal throttling: the same baseline gave 1.16x and then 0.69x). Accuracy is deterministic. One 89-word clip is 1.1% per word, so differences under about 5 points on it are noise; the FLEURS set is the steadier of the two.
- GPU: whisper.cpp's Vulkan backend finds the Mali-G710 and works, about 1.4-1.6x faster than the CPU for small, no gain for base. It needs build deps (`vulkan-headers vulkan-loader-android shaderc spirv-headers glslang`) and a one-line patch to `ggml-vulkan-buffers.cpp` (`std::aligned_alloc` does not exist in Termux's libc; `posix_memalign` does).
- NPU/TPU: not reachable by third-party code for Whisper on this phone.
- Chrome's on-device Web Speech API: `available()` says `unavailable` for nb-NO and en-US (Chrome 156 on Android), `install()` returns false, starting with `processLocally` fails with `language-not-supported`, no phrase biasing. Not usable from a web page here. A native app (M8) could still use Android's own on-device recognizer; not tested.

## Left to decide

See the session notes: which model, whether to take the GPU, shorter pieces, and whether to pursue the Android recognizer in the M8 shell.
