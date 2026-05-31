/**
 * Persona materials extractor · the one-time seed pipeline for
 * New-Agent v2. The composer uploads a handful of files (notes, PDFs,
 * Word docs, images, audio / video clips); this module reads each one
 * into a consolidated text context that grounds the persona LLM, plus
 * a set of image content-block descriptors for the (optional)
 * multimodal path.
 *
 * Design · mirrors the best-effort / isolated-error posture of the
 * persona-builder's Phase 5 voice clone:
 *   · every per-file extraction is wrapped in its own try/catch;
 *   · a failed pdf / docx / image / transcript degrades to a
 *     "filename noted" entry and NEVER fails the whole build;
 *   · the consolidated `materialsContext` is capped (~8000 chars) so a
 *     dump of large PDFs can't blow past the persona prompt budget.
 *
 * Materials are a one-time seed · nothing here is persisted beyond the
 * build. The route stashes the uploads in tmp (mirroring
 * /api/voice-clone/upload); the OS tmp reaper cleans them up.
 */
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { transcribeAudio } from "../ai/skills/minimax-asr.js";
import { normalizeAudio } from "../skills/ffmpeg.js";
import { getActiveVoiceProvider } from "../storage/voice-credentials.js";

/** Material kinds inferred from mime / extension at upload time. */
export type MaterialKind = "text" | "doc" | "image" | "audio" | "video";

/** A material descriptor · produced by the upload route, threaded back
 *  into `extractMaterials` at build time. `filePath` points at the tmp
 *  stash; `mime` / `name` / `size` are echoed from the upload. */
export interface MaterialDescriptor {
  id: string;
  kind: MaterialKind;
  filePath: string;
  name: string;
  mime: string;
  size: number;
}

/** Per-file extraction outcome · surfaced so the composer can render a
 *  status chip (extracting / transcribing / done / noted) and so the
 *  build report can show what each material contributed. */
export interface MaterialFileResult {
  name: string;
  kind: MaterialKind;
  /** `extracted` · text was read and folded into the context.
   *  `transcribed` · audio / video was transcribed into the context.
   *  `image` · an image content block was produced for the LLM.
   *  `noted` · extraction failed or was unavailable; the filename was
   *  recorded as a textual note but no content was extracted. */
  status: "extracted" | "transcribed" | "image" | "noted";
  /** Characters of text this file contributed to `materialsContext`
   *  (omitted for image / noted entries that contributed none). */
  chars?: number;
}

/** An image content block for the persona LLM's multimodal path. The
 *  persona builder threads body context as plain strings today, so the
 *  builder degrades images to textual notes; this descriptor is
 *  returned for callers that DO wire a vision-capable model. */
export interface MaterialImageBlock {
  name: string;
  mime: string;
  /** `data:<mime>;base64,...` — ready to drop into a vision content
   *  block without re-reading the tmp file. */
  dataUrl: string;
}

export interface ExtractMaterialsResult {
  /** Consolidated extracted text, each chunk labelled by source name,
   *  truncated to `MATERIALS_CONTEXT_CAP` chars. */
  materialsContext: string;
  /** Image content-block descriptors for the optional multimodal path. */
  imageBlocks: MaterialImageBlock[];
  /** Per-file extraction outcomes (order matches the input). */
  perFile: MaterialFileResult[];
}

export interface ExtractMaterialsOpts {
  /** Cancellation · piped into the ffmpeg / ASR calls so a build abort
   *  kills in-flight transcription too. */
  signal?: AbortSignal;
  /** Scratch directory for transcoded audio (defaults to the OS tmp
   *  dir alongside the upload). */
  workDir?: string;
}

/** Consolidated-context budget · keeps a dump of large PDFs from
 *  blowing past the persona prompt budget. The persona builder feeds
 *  this as one more grounding block alongside the description. */
export const MATERIALS_CONTEXT_CAP = 8_000;
/** Per-file text budget · a single huge file can't crowd out the
 *  others. The consolidated cap above is the hard ceiling; this keeps
 *  the mix balanced before truncation. */
export const PER_FILE_TEXT_CAP = 4_000;
/** Image data-URL guard · skip producing a base64 block for absurdly
 *  large images (they'd bloat the prompt and most vision models reject
 *  them anyway). Degrades to a "noted" entry instead. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Read a plain-text / markdown file. Throws on read failure (caller
 *  catches and degrades). */
async function extractText(filePath: string): Promise<string> {
  const raw = await readFile(filePath, "utf8");
  // Strip NUL bytes (misencoded uploads) + a leading UTF-8 BOM, then
  // trim. Interior whitespace is preserved — it carries structure.
  return raw.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
}

/** Extract text from a PDF (pdf-parse v2) or DOCX (mammoth). Heavy deps
 *  are loaded lazily so a build with no documents never pays the import
 *  cost. Throws on failure (caller degrades to "noted"). */
async function extractDoc(filePath: string, name: string): Promise<string> {
  const ext = extname(name || filePath).toLowerCase();
  const buf = await readFile(filePath);
  if (ext === ".pdf" || isPdfMagic(buf)) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const res = await parser.getText();
      return (res.text || "").trim();
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  // docx (and other Office Open XML word docs) → mammoth raw text.
  const mammoth = (await import("mammoth")).default;
  const res = await mammoth.extractRawText({ buffer: buf });
  return (res.value || "").trim();
}

/** PDFs start with "%PDF-". Used as a secondary signal when the
 *  extension is missing / wrong so a mislabelled upload still routes to
 *  the PDF parser instead of mammoth. */
function isPdfMagic(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Transcribe an audio / video file. For video we first ffmpeg-extract
 *  + normalize the audio track (normalizeAudio accepts any container
 *  ffmpeg can demux). Returns the joined transcript text, or null when
 *  transcription is unavailable (no MiniMax credential / ASR failed) so
 *  the caller can degrade to "audio attached, not transcribed". */
async function extractTranscript(
  filePath: string,
  workDir: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // ASR runs through MiniMax · without an active MiniMax voice
  // credential there's no transcription path. Degrade gracefully
  // rather than throwing.
  if (getActiveVoiceProvider() !== "minimax") return null;

  // Normalize / extract the audio track to a clean mono mp3 the ASR
  // endpoint accepts. normalizeAudio demuxes video containers too, so
  // the same call covers both audio and video inputs.
  const normPath = `${workDir}/material-audio-${Date.now()}.mp3`;
  await normalizeAudio({ inputPath: filePath, outputPath: normPath, signal });

  const segments = await transcribeAudio({ filePath: normPath, signal });
  if (!segments || segments.length === 0) return null;
  const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/** Build a base64 `data:` URL for an image so callers with a vision-
 *  capable model can attach it without re-reading the tmp file.
 *  Returns null when the file is missing or above MAX_IMAGE_BYTES. */
async function buildImageBlock(
  filePath: string,
  name: string,
  mime: string,
): Promise<MaterialImageBlock | null> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
  const buf = await readFile(filePath);
  const effectiveMime = mime && mime.startsWith("image/") ? mime : "image/png";
  return {
    name,
    mime: effectiveMime,
    dataUrl: `data:${effectiveMime};base64,${buf.toString("base64")}`,
  };
}

/** Extract a batch of materials into a consolidated text context +
 *  image blocks + per-file outcomes. Best-effort and isolated · a
 *  single failing material degrades to a "noted" entry and the rest
 *  proceed. Never throws on a per-file failure; only argument-shape
 *  problems would surface, and those are guarded too. */
export async function extractMaterials(
  materials: readonly MaterialDescriptor[],
  opts: ExtractMaterialsOpts = {},
): Promise<ExtractMaterialsResult> {
  const perFile: MaterialFileResult[] = [];
  const imageBlocks: MaterialImageBlock[] = [];
  const chunks: string[] = [];
  const workDir = opts.workDir || tmpScratchDir();

  for (const m of materials) {
    if (opts.signal?.aborted) {
      perFile.push({ name: m.name, kind: m.kind, status: "noted" });
      continue;
    }
    try {
      if (m.kind === "text") {
        const text = await extractText(m.filePath);
        const clipped = text.slice(0, PER_FILE_TEXT_CAP);
        if (clipped) {
          chunks.push(labelChunk(m.name, clipped));
          perFile.push({ name: m.name, kind: m.kind, status: "extracted", chars: clipped.length });
        } else {
          perFile.push({ name: m.name, kind: m.kind, status: "noted" });
        }
      } else if (m.kind === "doc") {
        const text = await extractDoc(m.filePath, m.name);
        const clipped = text.slice(0, PER_FILE_TEXT_CAP);
        if (clipped) {
          chunks.push(labelChunk(m.name, clipped));
          perFile.push({ name: m.name, kind: m.kind, status: "extracted", chars: clipped.length });
        } else {
          perFile.push({ name: m.name, kind: m.kind, status: "noted" });
        }
      } else if (m.kind === "image") {
        const block = await buildImageBlock(m.filePath, m.name, m.mime);
        if (block) {
          imageBlocks.push(block);
          // ALSO record a textual note so a non-vision builder still
          // knows an image was attached (the builder threads context
          // as strings; the image block is for the optional vision
          // path). Don't count chars — the note is metadata, not body.
          chunks.push(`[image attached: ${m.name}]`);
          perFile.push({ name: m.name, kind: m.kind, status: "image" });
        } else {
          chunks.push(`[image attached: ${m.name}]`);
          perFile.push({ name: m.name, kind: m.kind, status: "noted" });
        }
      } else {
        // audio / video → transcribe (best-effort).
        const transcript = await extractTranscript(m.filePath, workDir, opts.signal);
        if (transcript) {
          const clipped = transcript.slice(0, PER_FILE_TEXT_CAP);
          chunks.push(labelChunk(`${m.name} (transcript)`, clipped));
          perFile.push({ name: m.name, kind: m.kind, status: "transcribed", chars: clipped.length });
        } else {
          chunks.push(`[${m.kind} attached: ${m.name} · not transcribed]`);
          perFile.push({ name: m.name, kind: m.kind, status: "noted" });
        }
      }
    } catch (e) {
      process.stderr.write(
        `[persona-materials] ${m.kind} "${m.name}" failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      chunks.push(`[${m.kind} attached: ${m.name} · could not be read]`);
      perFile.push({ name: m.name, kind: m.kind, status: "noted" });
    }
  }

  const materialsContext = consolidate(chunks);
  return { materialsContext, imageBlocks, perFile };
}

/** Scratch dir for transcoded material audio · created lazily so the
 *  text-only path never touches the filesystem beyond the uploads. */
function tmpScratchDir(): string {
  return mkdtempSync(join(tmpdir(), "pb-persona-materials-"));
}

/** Label a source chunk so the persona LLM can attribute material to a
 *  filename when it grounds the spec. */
function labelChunk(name: string, body: string): string {
  return `─── MATERIAL · ${name}\n${body}`;
}

/** Join the labelled chunks and truncate to the consolidated cap. The
 *  truncation is the final safety net — per-file caps keep the mix
 *  balanced before we get here. */
function consolidate(chunks: string[]): string {
  if (chunks.length === 0) return "";
  const joined = chunks.join("\n\n").trim();
  if (joined.length <= MATERIALS_CONTEXT_CAP) return joined;
  return joined.slice(0, MATERIALS_CONTEXT_CAP).trim() + "\n\n[materials truncated]";
}
