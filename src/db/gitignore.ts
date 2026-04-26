import * as fs from "node:fs/promises";
import * as path from "node:path";

import { CLIPFIRST_DIR } from "./client.js";

const REQUIRED_PATTERNS = [
  `${CLIPFIRST_DIR}/state.sqlite`,
  `${CLIPFIRST_DIR}/state.sqlite-wal`,
  `${CLIPFIRST_DIR}/state.sqlite-shm`,
  `${CLIPFIRST_DIR}/state.sqlite-journal`,
  `${CLIPFIRST_DIR}/.project.lock`,
  `${CLIPFIRST_DIR}/metadata.sqlite-journal`,
];

/**
 * Ensure .gitignore in projectDir contains the patterns required to keep
 * state.sqlite (and its WAL/SHM/journal sidecars) out of version control.
 * Idempotent: existing patterns are not duplicated.
 */
export async function ensureGitignorePatterns(
  projectDir: string,
): Promise<void> {
  const gitignorePath = path.join(projectDir, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // file doesn't exist yet — will be created
  }
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((l) => l.trim()));
  const missing = REQUIRED_PATTERNS.filter((p) => !present.has(p));
  if (missing.length === 0) return;
  const trailing = existing.endsWith("\n") || existing === "" ? "" : "\n";
  const append = trailing + missing.join("\n") + "\n";
  await fs.writeFile(gitignorePath, existing + append);
}
