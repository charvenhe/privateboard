/**
 * Confined upload root for New-Agent v2 materials + local voice source.
 *
 * Every file the composer uploads (POST /api/agents/materials/upload and
 * the voice-source upload) is written UNDER a single canonical directory
 * tree. At build time (/generate-persona) the client echoes back the
 * server `filePath` it was handed. Those paths are CLIENT-SUPPLIED and
 * must never be trusted as-is: a caller could send
 * `{"filePath":"/etc/passwd"}` and have it read into LLM context / fed
 * to the voice clone.
 *
 * `resolveUploadedFile()` confines an arbitrary candidate path to this
 * root: it `realpathSync`es both the candidate and the root, then admits
 * the candidate ONLY when it resolves to a regular file genuinely inside
 * the resolved root (defeating `..` traversal and symlink escape). Any
 * path outside the root is rejected (returns null).
 *
 * The root lives under the OS tmp dir (matching the prior stash location
 * + the test harness) but as ONE private, mode-0700 directory so its
 * realpath is a stable prefix to check membership against and so other
 * local users can't read a user's uploaded materials. A boot-time / TTL
 * sweep removes per-batch dirs older than the TTL.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Single canonical upload tree · all per-batch dirs nest under here. */
const UPLOAD_ROOT_NAME = "pb-agent-uploads";
/** Private to the running user · keeps other local accounts out of the
 *  uploaded materials. Per-file writes use 0o600 (see route). */
export const UPLOAD_ROOT_MODE = 0o700;
/** Per-file write mode · owner read/write only. */
export const UPLOAD_FILE_MODE = 0o600;
/** TTL for a per-batch upload dir · the build consumes uploads within
 *  seconds; anything older than this is an abandoned / leaked batch and
 *  is swept at boot. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000; // 1h

/** Absolute path of the canonical upload root (NOT realpath'd · use
 *  {@link resolvedUploadRoot} for membership checks). */
export function uploadRoot(): string {
  return join(tmpdir(), UPLOAD_ROOT_NAME);
}

/** Ensure the canonical upload root exists with private perms, then
 *  return its REALPATH (symlinks in the tmp dir resolved) so callers can
 *  use it as a stable membership prefix. */
export function ensureUploadRoot(): string {
  const root = uploadRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: UPLOAD_ROOT_MODE });
  return realpathSync(root);
}

/** Create a fresh per-batch dir inside the confined root and return its
 *  absolute path. Caller writes files into it with {@link UPLOAD_FILE_MODE}. */
export function createUploadBatchDir(suffix: string): string {
  ensureUploadRoot();
  const dir = join(uploadRoot(), suffix);
  mkdirSync(dir, { recursive: true, mode: UPLOAD_ROOT_MODE });
  return dir;
}

/**
 * Confine a client-supplied path to the upload root.
 *
 * Returns the candidate's realpath ONLY when it resolves to a regular
 * file genuinely inside the resolved upload root. Returns null for:
 *   · a path that doesn't exist / can't be realpath'd
 *   · a path outside the root (traversal / absolute escape / symlink out)
 *   · a non-regular-file (dir, fifo, device, …)
 */
export function resolveUploadedFile(filePath: string): string | null {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  let resolvedRoot: string;
  try {
    resolvedRoot = ensureUploadRoot();
  } catch {
    return null;
  }
  let resolved: string;
  try {
    resolved = realpathSync(filePath);
  } catch {
    // Missing file / broken symlink / permission error → reject.
    return null;
  }
  // Membership check · `relative(root, candidate)` must stay inside the
  // root: not climbing out via `..` and not an absolute path (different
  // root on Windows / a resolved symlink that landed elsewhere).
  const rel = relative(resolvedRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  try {
    if (!statSync(resolved).isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/**
 * Best-effort recursive removal of a consumed / abandoned batch dir.
 * Only removes paths that are genuinely inside the upload root (defends
 * against a stray caller passing an out-of-root path). Never throws.
 */
export function removeUploadBatchDir(dir: string): void {
  if (typeof dir !== "string" || !dir.trim()) return;
  let resolvedRoot: string;
  try {
    resolvedRoot = ensureUploadRoot();
  } catch {
    return;
  }
  let resolved: string;
  try {
    resolved = realpathSync(dir);
  } catch {
    return; // already gone
  }
  const rel = relative(resolvedRoot, resolved);
  // Must be a direct/indirect child of the root — never the root itself
  // and never outside it.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Boot-time / TTL sweep · remove per-batch upload dirs older than
 * {@link UPLOAD_TTL_MS}. Returns the number of dirs removed. Never
 * throws. Mirrors the boot recovery sweeps in boot.ts.
 */
export function sweepStaleUploads(maxAgeMs: number = UPLOAD_TTL_MS): number {
  const root = uploadRoot();
  if (!existsSync(root)) return 0;
  let removed = 0;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const info = statSync(dir);
      if (now - info.mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return removed;
}
