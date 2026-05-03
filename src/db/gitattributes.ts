import * as fs from "node:fs/promises";
import * as path from "node:path";

import { gitExecSafe } from "../git/exec.js";
import { CLIPFIRST_DIR } from "./client.js";

const METADATA_PATH = `${CLIPFIRST_DIR}/metadata.sqlite`;

const REQUIRED_PATTERNS = [`${METADATA_PATH} merge=ours -text`];

/**
 * Ensure .gitattributes contains rules that prevent git from attempting a
 * 3-way text merge of metadata.sqlite. The file is binary, so any merge
 * (including the implicit one inside `git stash pop`) leaves conflict
 * markers that wedge the worktree and cause subsequent operations to pile
 * up auto-stashes. `merge=ours` resolves automatically to the worktree
 * copy, which is what callers want — the post-operation snapshot, not the
 * stashed pre-operation one. Idempotent.
 */
export async function ensureGitattributesPatterns(
  projectDir: string,
): Promise<void> {
  const gitattributesPath = path.join(projectDir, ".gitattributes");
  let existing = "";
  try {
    existing = await fs.readFile(gitattributesPath, "utf-8");
  } catch {
    // file doesn't exist yet — will be created
  }
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((l) => l.trim()));
  const missing = REQUIRED_PATTERNS.filter((p) => !present.has(p));
  if (missing.length === 0) return;
  const trailing = existing.endsWith("\n") || existing === "" ? "" : "\n";
  const append = trailing + missing.join("\n") + "\n";
  await fs.writeFile(gitattributesPath, existing + append);
}

/**
 * `merge=ours` in .gitattributes references a custom driver that git won't
 * invoke unless it's registered in the repo's local config. The driver is
 * literally the `true` shell command — it succeeds, leaving the worktree
 * copy in place. Idempotent: `git config` overwrites the same key on each
 * call.
 */
export async function ensureMergeOursDriver(
  projectDir: string,
  gitPath?: string,
): Promise<void> {
  await gitExecSafe(["config", "merge.ours.driver", "true"], {
    cwd: projectDir,
    gitPath,
  });
}
