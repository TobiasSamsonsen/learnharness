# M17: camera photos as source material and as answers

Status: **M17a BUILT and verified on the Pixel 2026-10-29 (goal "implement the camera feature"); M17b built 2026-10-29 (tests only, see the M17b result below).** Branch `feat/m17-camera` (from `feat/m16-sketch-notes`). Request (owner, 2026-10-29): "open the camera from the app: pressing Sources, then Camera, and take a photo of a sketch (or other stuff) to use in the lessons/practice." Source: two read-only surveys of the Sources menu, the image-material pipeline, the Android shell and the sketch pipeline (code reading only, nothing run on a device).

## Owner decisions (2026-10-29)

| Question | Answer |
| --- | --- |
| How the camera opens | **Phone camera app on Android, a webcam dialog on desktop** |
| What the photo is for | **Both: source material, and an answer to a practice problem or question** |
| How a photo answer is read | **The same read-first flow as a sketch** (the model transcribes it with `read_sketch`, doubts are raised before grading) |

## What exists today (from the surveys)

- The Sources menu has "Add files…" (a hidden file input, `accept` = pdf, text, png, jpg, webp, gif) and a link field. A File goes through `uploadFiles` (one POST per file) or, on the new-lesson screen, the draft store.
- An image material is read by the vision model (`pdfReader` role) into a transcription and a profile; the chat model sees only that text. Nothing resizes or fixes EXIF orientation on this path, and HEIC is rejected (415).
- The Android shell has a file chooser (`onShowFileChooser`) but no camera permission, no FileProvider and no `capture` handling. The desktop app already allows camera access for the page. The web app never uses a camera.
- The only image answer today is the sketch canvas. A sketch is strokes: the server renders pages, the model must call `read_sketch`, and a gate holds grading until the reading is clean. Several places assume strokes (validation, glyph floor, kept page, new-ink bracket, thaw).

## M17a: Camera in Sources

- **Android:** a "Camera" button next to "Add files…" opens an `<input type=file accept="image/*" capture="environment">`. The shell's file chooser sees `isCaptureEnabled` and launches the phone's camera app (`ACTION_IMAGE_CAPTURE`) with an output URI from a new FileProvider, and hands the photo back to the page. The shell asks for no CAMERA permission (the camera app takes the picture); this needs a FileProvider entry in the manifest and its paths file.
- **Desktop and browser:** a small `CameraCapture` dialog: live webcam preview (getUserMedia, the app's own permission already allows it), Capture, then Use photo or Retake. The result is a `File`.
- **Both:** the photo is a `File` and goes through the existing `addFiles` (chat, course or draft), so Sources, drafts and course materials work unchanged.
- **Server:** image materials are normalised first (EXIF rotation applied, long edge at most 2000 px, re-encoded), using the image library the app already ships (photon), so a 12 MP phone photo no longer goes to the vision model at full size. HEIC is out of scope (Android cameras write JPEG).

## M17b: Photo answers (same read-first flow as a sketch)

- **Contract:** `SketchPayload` gets producer `"photo"` with a normalised image (`photo: {width, height, data}`), and `strokes` stays empty for it. `parseSketchPayload` and `planSketch` branch on the producer: no stroke, point or glyph-floor rules, no new-ink bracket, one page. `sketchRefOf` gives `strokeCount 0`. `keptSketchOf` skips photos (otherwise a photo as the newest sketch would make a later text submit send a bad kept id and get "Unknown sketch").
- **Server:** a normalising step before parsing (magic bytes, EXIF, fit to 2000 px, re-encode PNG, refuse a long edge under about 800 px); the store writes the page PNG for the model and a one-image SVG wrapper for the UI, so the transcript thumbnail and the full-size view work unchanged. Limits: 10 MB raw, about 4 MB normalised.
- **Docks:** an "Add photo" button beside "Open in sketch" in the practice dock and the question dock (text mode; choice mode rides as thinking, as sketches do), the camera route of M17a, a "Photo attached" chip with a remove button, and the confidence and "I don't know" marks work as for a sketch. **One photo per submission; a photo and ink do not combine (the photo wins, the ink stays unsent).**
- **Prompt:** a paragraph in `18-sketches.md` for photos (skew, shadow, crop; anything unreadable goes in `uncertain`; the new-ink bracket paragraph does not apply).
- **Unchanged:** `read_sketch`, the gate, elision, the transcript cards (they read the `SketchRef`).

## Checks

Unit tests (contract: photo accept and refuse cases, planSketch photo is one page, keptSketchOf skips photos, the store writes PNG and wrapper SVG, parseChatInput photo answer and thinking; materials normalisation; the shell's capture routing as far as it is pure; the `CameraCapture` dialog logic). On the Pixel: the camera opens from Camera and returns a photo into Sources, and a photo answer reaches the model (this uses the phone's camera and a few subscription calls; I will ask before taking a photo).

## Unverified until built

HEIC (unsupported, by decision); whether a 2000 px phone photo of handwriting is legible enough to the model (we will see in the first test); the exact intent Android's WebView offers for `capture` (the shell launches the camera itself instead); Next's request body limit for a multi-MB base64 JSON (the photo answer rides in the chat POST; to be measured, with a fallback of uploading the image first).

## Decided by default (owner may change)

One photo per submission; Android uses the camera app and needs no camera permission; image caps (10 MB in, 2000 px long edge, 800 px minimum); photon, not sharp.

## M17a result (2026-10-29)

- Sources has a **Camera** button next to Add files. Android shell (and any touch browser): a hidden `<input type=file accept="image/*" capture="environment">`; the shell's file chooser sees `isCaptureEnabled` (`PhotoCapture.wantsCamera`, Kotlin tests) and opens the phone's camera app itself with a FileProvider URI in the app's cache (photos older than a day are deleted the next time). No CAMERA permission; the manifest got the provider, the camera-app query and an optional camera feature. Desktop: `CameraDialog` (webcam preview, Capture, Retake, Use photo). `cameraRoute` picks the way (tests).
- Image materials are normalised before the vision model reads them (`src/agent/image-processing/normalize.ts`: EXIF orientation applied, long edge at most 2000 px, under 4 MB; tests build a real JPEG with an orientation tag).
- **Verified on the Pixel 7 Pro:** Sources, Camera opened the Google Camera in capture mode; the photo came back and shows as a draft source (`photo_<time>.jpg`, "Sources · 1"). The webcam dialog is built but not tried (no desktop browser session here).

## M17b result (2026-10-29)

- **Built as planned** (tsc, eslint, tests clean): producer `"photo"` in the contract (`SketchPhoto`, no strokes, one page; `planSketch` wraps the image in an SVG, `keptSketchOf` skips photos); the server normalises a photo before parsing (`normalizePhotoSketch` in `src/server/sketches.ts`, 400 on a bad image) and stores the normalised bytes as the page (`sniffImageMime` picks the type for the model and the page route); the prompt has a paragraph for photos. The photo reuses the sketch cards through its `SketchRef`.
- **Docks:** a **Photo** button next to Open in sketch in the practice dock and the question dock (shown when the model reads images and a camera route exists), a "Photo attached" chip with a remove button, and a photo alone is enough to submit (empty text allowed). One photo per submission; the photo wins over unsent ink (the ink stays). In the question dock the photo goes through the sketch submit path, so confidence and "I don't know" work as for a sketch. Client helpers: `components/photo-answer.ts` (decode, fit to 2000 px, refuse under 600 px) and `components/use-camera.tsx` (shared with the Sources Camera button).
- **Not verified:** a photo answer end to end on a device or against a real model (it uses the phone camera and subscription calls; ask the owner first), the webcam dialog on a desktop, and Next's request body size for a multi-MB photo in the chat POST. A thinking input that references a photo sketch by id would answer "Unknown sketch"; this should be unreachable because a photo is never a kept page.
