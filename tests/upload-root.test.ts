/**
 * upload-root tests · the path-confinement guard for New-Agent v2
 * materials + local voice source.
 *
 * The security-critical assertion: a client-supplied path OUTSIDE the
 * confined upload root (traversal, absolute escape, symlink-out) is
 * rejected (resolveUploadedFile → null), while a legit file written into
 * a batch dir under the root is admitted. This blocks the path-traversal
 * / arbitrary-server-file-read finding (e.g. {"filePath":"/etc/passwd"}).
 */
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createUploadBatchDir,
  removeUploadBatchDir,
  resolveUploadedFile,
  sweepStaleUploads,
  uploadRoot,
} from "../src/utils/upload-root.js";

let outsideDir: string;

beforeEach(() => {
  outsideDir = mkdtempSync(join(tmpdir(), "pb-outside-"));
});

afterEach(() => {
  try { rmSync(outsideDir, { recursive: true, force: true }); } catch { /* */ }
  // Clean the shared upload root so batches don't leak across tests.
  try { rmSync(uploadRoot(), { recursive: true, force: true }); } catch { /* */ }
});

describe("resolveUploadedFile · confinement", () => {
  it("admits a regular file written inside a batch dir under the root", () => {
    const dir = createUploadBatchDir("batch-admit");
    const path = join(dir, "notes.txt");
    writeFileSync(path, "first principles");
    const resolved = resolveUploadedFile(path);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain("notes.txt");
  });

  it("REJECTS an absolute path outside the root (arbitrary server file)", () => {
    // The headline finding · /etc/passwd-style read must be blocked.
    expect(resolveUploadedFile("/etc/passwd")).toBeNull();
    expect(resolveUploadedFile("/etc/hosts")).toBeNull();
  });

  it("REJECTS a file in a sibling tmp dir outside the root", () => {
    const path = join(outsideDir, "secret.txt");
    writeFileSync(path, "should not be readable");
    expect(resolveUploadedFile(path)).toBeNull();
  });

  it("REJECTS a traversal path that climbs out of a batch dir", () => {
    const dir = createUploadBatchDir("batch-traverse");
    const outside = join(outsideDir, "target.txt");
    writeFileSync(outside, "outside the root");
    // dir/../../<outsideDir>/target.txt — resolves outside the root.
    const traversal = join(dir, "..", "..", "..", outsideDir.split("/").pop()!, "target.txt");
    expect(resolveUploadedFile(traversal)).toBeNull();
  });

  it("REJECTS a symlink inside the root that points outside it", () => {
    const dir = createUploadBatchDir("batch-symlink");
    const outside = join(outsideDir, "target.txt");
    writeFileSync(outside, "outside the root");
    const link = join(dir, "escape.txt");
    symlinkSync(outside, link);
    // realpathSync resolves the symlink to its target, which is outside.
    expect(resolveUploadedFile(link)).toBeNull();
  });

  it("REJECTS a non-regular-file (a directory) inside the root", () => {
    const dir = createUploadBatchDir("batch-dir");
    const sub = join(dir, "subdir");
    mkdirSync(sub);
    expect(resolveUploadedFile(sub)).toBeNull();
  });

  it("REJECTS a missing file and empty/garbage input", () => {
    const dir = createUploadBatchDir("batch-missing");
    expect(resolveUploadedFile(join(dir, "nope.txt"))).toBeNull();
    expect(resolveUploadedFile("")).toBeNull();
    expect(resolveUploadedFile("   ")).toBeNull();
  });
});

describe("removeUploadBatchDir + sweepStaleUploads", () => {
  it("removes a batch dir inside the root but refuses an outside path", () => {
    const dir = createUploadBatchDir("batch-remove");
    writeFileSync(join(dir, "f.txt"), "x");
    removeUploadBatchDir(dir);
    // After removal the file no longer resolves.
    expect(resolveUploadedFile(join(dir, "f.txt"))).toBeNull();

    // An out-of-root path is never touched.
    const outside = join(outsideDir, "keep.txt");
    writeFileSync(outside, "keep me");
    removeUploadBatchDir(outsideDir);
    // Still readable directly (we only assert it wasn't deleted).
    expect(() => writeFileSync(outside, "still here")).not.toThrow();
  });

  it("sweeps batch dirs older than the max age", () => {
    const dir = createUploadBatchDir("batch-stale");
    writeFileSync(join(dir, "f.txt"), "x");
    // maxAge of -1 makes every existing dir 'stale'.
    const removed = sweepStaleUploads(-1);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(resolveUploadedFile(join(dir, "f.txt"))).toBeNull();
  });

  it("does not sweep fresh batch dirs", () => {
    const dir = createUploadBatchDir("batch-fresh");
    const path = join(dir, "f.txt");
    writeFileSync(path, "x");
    const removed = sweepStaleUploads(60 * 60 * 1000);
    expect(removed).toBe(0);
    expect(resolveUploadedFile(path)).not.toBeNull();
  });
});
