# New-Agent v2 — custom voice + materials-driven persona creation

**Date:** 2026-05-31
**Status:** approved (user set build goal)

## Goal

Extend new-agent creation so a user can (1) clone a voice from a **local
audio/video upload**, and (2) attach **materials** (text/md, pdf/docx, images,
audio/video) that seed a custom persona. Materials are a **one-time seed** for
`/generate-persona` — not a persisted knowledge base. PC + mobile, shared
backend.

## What already exists (reuse, don't rebuild)

- `/api/voice-clone/upload` (multipart) + `/start` (`{kind:'file',filePath}`) →
  MiniMax/ElevenLabs clone with progress. Browser trims + WAV-encodes audio
  pre-upload. `public/voice-clone.js` is the reusable clone-modal singleton
  (currently only mounted in agent-profile).
- `/generate-persona` takes `{description, locale, voiceSourceUrl}`; persona-builder
  Phase 5 clones from a URL or YouTube auto-search and stamps `clonedVoice.voiceId`.
- `src/skills/ffmpeg.js` — audio normalize/slice (video→audio extraction).
- `src/ai/skills/minimax-asr.ts` — speech-to-text (audio→transcript).
- Registry models (Claude / GPT-5.x / Gemini) are multimodal → images can be
  sent as content blocks.

## Architecture

Structured **new-agent v2 form** (PC `app.js`, mobile `m/index.html`; shared
helpers in `agent-runtime.js`): Description / Voice source (local audio·video →
clone) / Materials (multi-file) / Name (auto from persona). On submit the server
extracts materials → consolidated text context, clones the voice from the audio
source, and feeds everything into `/generate-persona` as a one-time seed.

### Backend

- `POST /api/agents/materials/upload` — multipart multi-file; stash to tmp,
  return `[{id, kind, filePath, name, mime, size}]`. Mirrors voice-clone/upload.
- `src/orchestrator/persona-materials.ts` — per-file extraction (best-effort,
  isolated):
  - text/md → read
  - pdf → `pdf-parse`; docx → `mammoth` (new deps)
  - audio/video → `skills/ffmpeg` extract → `minimax-asr` transcribe
  - image → multimodal content block (passed to persona LLM); degrade to
    "image attached, not analyzed" if no vision-capable model/key
  - Output: capped `materialsContext` string + image blocks + per-file summary.
- `startVoiceDistill` extended to accept a local `{filePath}` source (currently
  `videoUrl` only) so the persona voice step can clone from the uploaded file.
- `/generate-persona` accepts `materials` (descriptors) + `voiceSource` and
  threads `materialsContext`/images into the builder.

### Frontend

- New-agent v2 form on PC + mobile: description textarea, voice upload (reuse
  `voice-clone.js`, show clone progress), materials multi-file picker with
  per-file chips (kind icon + extracting/transcribing/done status), submit →
  existing persona stream viewer → review → save with `clonedVoice.voiceId`.

## Data flow

upload → tmp + descriptors → submit → (parallel) extract materials +
clone voice from audio source → `/generate-persona({description,
materialsContext, images, voiceSource})` → persona stream → save agent.

## Error handling (best-effort + isolated, matches existing persona-builder)

- A failed pdf/docx/image/transcript degrades to "filename noted"; never fails
  the whole build.
- Voice-clone failure → agent still created, no custom voice.
- No vision model/key → image degraded to attached-not-analyzed.
- ffmpeg/asr failure → skip transcript, audio still used for clone.
- File size/count/type caps with clear errors.

## Testing

- Unit: per-type extraction, context consolidation + cap, degraded paths.
- Integration: `/api/agents/materials/upload`, `/generate-persona` with materials
  (mock providers).
- Browser e2e (PC + mobile Playwright): render the v2 form, upload a file,
  submit; verify **layout is clean with no overlapping elements** via
  screenshots at 390 (mobile) and desktop widths.
- Existing 399 unit tests stay green.

## New dependencies

`pdf-parse`, `mammoth`. Image vision via existing multimodal models (AI client
gains image content-block support).
