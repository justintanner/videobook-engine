import * as fs from "node:fs/promises";
import * as path from "node:path";

import { VIDEOCITY_DIR } from "./client.js";

const REQUIRED_PATTERNS = [
  `${VIDEOCITY_DIR}/state.sqlite`,
  `${VIDEOCITY_DIR}/state.sqlite-wal`,
  `${VIDEOCITY_DIR}/state.sqlite-shm`,
  `${VIDEOCITY_DIR}/state.sqlite-journal`,
  `${VIDEOCITY_DIR}/.project.lock`,
  `${VIDEOCITY_DIR}/metadata.sqlite-journal`,
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
