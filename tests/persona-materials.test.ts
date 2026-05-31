/**
 * persona-materials tests · the New-Agent v2 one-time seed extractor.
 *
 * Covers the text + degraded paths (the minimum the spec asks for) plus
 * doc / audio / image with their heavy deps mocked. The real pdf-parse /
 * mammoth / MiniMax-ASR / ffmpeg surfaces involve binaries + HTTP, so we
 * stub them and assert the consolidation + per-file bookkeeping the
 * persona builder relies on.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks · stub the heavy / external surfaces. Each test overrides the
//    return value via the mocked fn handles below. ────────────────────
vi.mock("../src/storage/voice-credentials.js", () => ({
  getActiveVoiceProvider: vi.fn(() => "minimax" as const),
}));
vi.mock("../src/ai/skills/minimax-asr.js", () => ({
  transcribeAudio: vi.fn(),
}));
vi.mock("../src/skills/ffmpeg.js", () => ({
  normalizeAudio: vi.fn(async () => undefined),
}));

import {
  extractMaterials,
  MATERIALS_CONTEXT_CAP,
  MAX_TEXT_BYTES,
  type MaterialDescriptor,
} from "../src/orchestrator/persona-materials.js";
import { getActiveVoiceProvider } from "../src/storage/voice-credentials.js";
import { transcribeAudio } from "../src/ai/skills/minimax-asr.js";
import { normalizeAudio } from "../src/skills/ffmpeg.js";

const provider = vi.mocked(getActiveVoiceProvider);
const asr = vi.mocked(transcribeAudio);
const normalize = vi.mocked(normalizeAudio);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pb-materials-test-"));
  provider.mockReturnValue("minimax");
  asr.mockReset();
  normalize.mockReset();
  normalize.mockResolvedValue(undefined);
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  vi.clearAllMocks();
});

/** Write a temp file and return a descriptor for it. */
function material(
  name: string,
  kind: MaterialDescriptor["kind"],
  content: string | Buffer,
  mime = "",
): MaterialDescriptor {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  return { id: `m-${name}`, kind, filePath, name, mime, size };
}

describe("extractMaterials · text", () => {
  it("reads a text file into the consolidated context, labelled by name", async () => {
    const m = material("notes.txt", "text", "First principles. Always ask why.");
    const res = await extractMaterials([m], { workDir: dir });

    expect(res.materialsContext).toContain("MATERIAL · notes.txt");
    expect(res.materialsContext).toContain("First principles");
    expect(res.perFile).toEqual([
      { name: "notes.txt", kind: "text", status: "extracted", chars: "First principles. Always ask why.".length },
    ]);
    expect(res.imageBlocks).toEqual([]);
  });

  it("degrades an empty text file to a noted entry with no context", async () => {
    const m = material("blank.md", "text", "   \n  ");
    const res = await extractMaterials([m], { workDir: dir });

    expect(res.materialsContext).toBe("");
    expect(res.perFile[0]).toMatchObject({ name: "blank.md", status: "noted" });
  });

  it("degrades a missing/unreadable file to a noted entry without throwing", async () => {
    const m: MaterialDescriptor = {
      id: "gone", kind: "text", filePath: join(dir, "does-not-exist.txt"),
      name: "does-not-exist.txt", mime: "", size: 10,
    };
    const res = await extractMaterials([m], { workDir: dir });
    expect(res.perFile[0]).toMatchObject({ status: "noted" });
    expect(res.materialsContext).toContain("could not be read");
  });

  it("degrades an oversized text file to a noted entry (raw-size ceiling)", async () => {
    // A file above MAX_TEXT_BYTES must be rejected BEFORE being read
    // whole — it degrades to a noted entry, never folded into context.
    const huge = "y".repeat(MAX_TEXT_BYTES + 1024);
    const m = material("huge.txt", "text", huge);
    const res = await extractMaterials([m], { workDir: dir });
    expect(res.perFile[0]).toMatchObject({ name: "huge.txt", status: "noted" });
    expect(res.materialsContext).toContain("could not be read");
    expect(res.materialsContext).not.toContain("yyyy");
  });

  it("caps the consolidated context at MATERIALS_CONTEXT_CAP", async () => {
    // Three big text files · each clipped at PER_FILE_TEXT_CAP, joined,
    // then truncated at the consolidated cap.
    const big = "x".repeat(20_000);
    const mats = [
      material("a.txt", "text", big),
      material("b.txt", "text", big),
      material("c.txt", "text", big),
    ];
    const res = await extractMaterials(mats, { workDir: dir });
    expect(res.materialsContext.length).toBeLessThanOrEqual(MATERIALS_CONTEXT_CAP + "\n\n[materials truncated]".length);
    expect(res.materialsContext).toContain("[materials truncated]");
  });
});

describe("extractMaterials · doc", () => {
  it("extracts text from a docx via mammoth", async () => {
    vi.doMock("mammoth", () => ({
      default: { extractRawText: vi.fn(async () => ({ value: "Quarterly board memo body.", messages: [] })) },
    }));
    vi.resetModules();
    const { extractMaterials: fresh } = await import("../src/orchestrator/persona-materials.js");
    const m = material(
      "memo.docx",
      "doc",
      Buffer.from("PK fake docx zip header"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const res = await fresh([m], { workDir: dir });
    expect(res.materialsContext).toContain("Quarterly board memo body.");
    expect(res.perFile[0]).toMatchObject({ kind: "doc", status: "extracted" });
    vi.doUnmock("mammoth");
  });

  it("extracts text from a pdf via pdf-parse (by %PDF- magic)", async () => {
    const getText = vi.fn(async () => ({ text: "Page one. Page two." }));
    const destroy = vi.fn(async () => undefined);
    vi.doMock("pdf-parse", () => ({
      PDFParse: class { getText = getText; destroy = destroy; constructor(_: unknown) { void _; } },
    }));
    vi.resetModules();
    const { extractMaterials: fresh } = await import("../src/orchestrator/persona-materials.js");
    const m = material("report.pdf", "doc", Buffer.from("%PDF-1.7 binary pdf bytes"), "application/pdf");
    const res = await fresh([m], { workDir: dir });
    expect(res.materialsContext).toContain("Page one. Page two.");
    expect(res.perFile[0]).toMatchObject({ kind: "doc", status: "extracted" });
    expect(destroy).toHaveBeenCalled();
    vi.doUnmock("pdf-parse");
  });
});

describe("extractMaterials · audio / video", () => {
  it("transcribes audio into the context when ASR returns segments", async () => {
    asr.mockResolvedValue([
      { text: "We should ship the smaller cut.", startSec: 0, endSec: 3 },
      { text: "Defer the rest.", startSec: 3, endSec: 5 },
    ]);
    const m = material("clip.mp3", "audio", Buffer.from("fake audio"), "audio/mpeg");
    const res = await extractMaterials([m], { workDir: dir });

    expect(normalize).toHaveBeenCalledTimes(1);
    expect(res.materialsContext).toContain("clip.mp3 (transcript)");
    expect(res.materialsContext).toContain("We should ship the smaller cut. Defer the rest.");
    expect(res.perFile[0]).toMatchObject({ kind: "audio", status: "transcribed" });
  });

  it("degrades to 'not transcribed' when no MiniMax credential is active", async () => {
    provider.mockReturnValue(null);
    const m = material("talk.mp4", "video", Buffer.from("fake video"), "video/mp4");
    const res = await extractMaterials([m], { workDir: dir });

    expect(normalize).not.toHaveBeenCalled();
    expect(asr).not.toHaveBeenCalled();
    expect(res.materialsContext).toContain("video attached: talk.mp4 · not transcribed");
    expect(res.perFile[0]).toMatchObject({ kind: "video", status: "noted" });
  });

  it("degrades to noted when ASR returns nothing", async () => {
    asr.mockResolvedValue(null);
    const m = material("quiet.wav", "audio", Buffer.from("fake"), "audio/wav");
    const res = await extractMaterials([m], { workDir: dir });
    expect(res.perFile[0]).toMatchObject({ status: "noted" });
    expect(res.materialsContext).toContain("not transcribed");
  });

  it("degrades to noted (not a crash) when ffmpeg normalize throws", async () => {
    normalize.mockRejectedValue(new Error("ffmpeg not found"));
    const m = material("bad.mov", "video", Buffer.from("fake"), "video/quicktime");
    const res = await extractMaterials([m], { workDir: dir });
    expect(res.perFile[0]).toMatchObject({ status: "noted" });
    expect(res.materialsContext).toContain("could not be read");
  });
});

describe("extractMaterials · image", () => {
  it("produces an image block + a textual attached-note", async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const m = material("diagram.png", "image", png, "image/png");
    const res = await extractMaterials([m], { workDir: dir });

    expect(res.imageBlocks).toHaveLength(1);
    expect(res.imageBlocks[0]).toMatchObject({ name: "diagram.png", mime: "image/png" });
    expect(res.imageBlocks[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(res.materialsContext).toContain("[image attached: diagram.png]");
    expect(res.perFile[0]).toMatchObject({ kind: "image", status: "image" });
  });
});

describe("extractMaterials · empty / batch", () => {
  it("returns empty results for no materials", async () => {
    const res = await extractMaterials([], { workDir: dir });
    expect(res).toEqual({ materialsContext: "", imageBlocks: [], perFile: [] });
  });

  it("processes a mixed batch in order, isolating per-file outcomes", async () => {
    asr.mockResolvedValue([{ text: "spoken", startSec: 0, endSec: 1 }]);
    const mats = [
      material("a.txt", "text", "alpha"),
      material("b.mp3", "audio", Buffer.from("x"), "audio/mpeg"),
      material("c.txt", "text", ""),
    ];
    const res = await extractMaterials(mats, { workDir: dir });
    expect(res.perFile.map((p) => p.status)).toEqual(["extracted", "transcribed", "noted"]);
  });
});
