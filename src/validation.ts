import * as path from "node:path";

import type { FsError } from "./types.js";
import type { Result } from "./result.js";
import { err } from "./result.js";

export const VALID_PREFIXES = ["img-", "vid-", "aud-", "script-"] as const;
export const SINGLETON_ASSETS = ["final"] as const;

/** Reject empty, null bytes, `..` segments, absolute paths */
export function isSafePath(segment: string): boolean {
  if (!segment || segment.length === 0) return false;
  if (segment.includes("\0")) return false;
  if (path.isAbsolute(segment)) return false;

  const parts = segment.split(/[/\\]/);
  for (const part of parts) {
    if (part === "..") return false;
    if (part === ".") return false;
  }
  return true;
}

/** Resolved path containment check — child must be strictly inside parent */
export function isWithinDir(parentDir: string, childPath: string): boolean {
  const resolvedParent = path.resolve(parentDir) + path.sep;
  const resolvedChild = path.resolve(childPath);
  return resolvedChild.startsWith(resolvedParent);
}

/** Reject filenames with path separators, `..`, null bytes, control chars, or >255 chars */
export function isSafeFilename(filename: string): boolean {
  if (!filename || filename.length === 0) return false;
  if (filename.length > 255) return false;
  if (filename.includes("\0")) return false;
  if (filename.includes("/")) return false;
  if (filename.includes("\\")) return false;
  if (filename === "." || filename === "..") return false;
  // Reject control characters (newlines, carriage returns, tabs, etc.)
  if (/[\x00-\x1f\x7f]/.test(filename)) return false;
  return true;
}

/** Must be one of the known asset prefixes */
export function isValidAssetPrefix(prefix: string): boolean {
  return (VALID_PREFIXES as readonly string[]).includes(`${prefix}-`);
}

/** Safe path + valid prefix or known singleton */
export function isValidAssetId(assetId: string): boolean {
  if (!isSafePath(assetId)) return false;
  const isSingleton = (SINGLETON_ASSETS as readonly string[]).includes(assetId);
  const hasValidPrefix = (VALID_PREFIXES as readonly string[]).some((p) =>
    assetId.startsWith(p),
  );
  return isSingleton || hasValidPrefix;
}

/** Helper returning err({ code: 'INVALID_INPUT', message }) */
export function invalidInput(message: string): Result<never, FsError> {
  return err({ code: "INVALID_INPUT", message });
}
