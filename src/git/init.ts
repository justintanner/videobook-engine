import * as fs from "node:fs/promises";
import * as path from "node:path";

import { gitExec, gitExecSafe } from "./exec.js";
import { CREATED_AT_FILE } from "../constants.js";
import { VIDEOCITY_DIR, getStateDb } from "../db/client.js";
import {
  ensureGitattributesPatterns,
  ensureMergeOursDriver,
} from "../db/gitattributes.js";
import { ensureGitignorePatterns } from "../db/gitignore.js";

const LEGACY_SIDECAR_DIR = ".clipfirst";

const LFS_PATTERNS: string[] = [
  "*.mp4",
  "*.mov",
  "*.webm",
  "*.avi",
  "*.mkv",
  "*.m4v",
  "*.flv",
  "*.mp3",
  "*.wav",
  "*.m4a",
  "*.aac",
  "*.jpg",
  "*.jpeg",
  "*.png",
  "*.webp",
  "*.gif",
  "*.bmp",
  "*.tiff",
];

const PROJECT_GITIGNORE = `*.lock
.DS_Store
Thumbs.db
.logs/
logs/
${VIDEOCITY_DIR}/state.sqlite
${VIDEOCITY_DIR}/state.sqlite-wal
${VIDEOCITY_DIR}/state.sqlite-shm
${VIDEOCITY_DIR}/state.sqlite-journal
${VIDEOCITY_DIR}/.project.lock
${VIDEOCITY_DIR}/metadata.sqlite-journal
`;

export async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectDir, ".git"));
    return true;
  } catch {
    return false;
  }
}

// `git lfs track <pattern>` only appends a line to .gitattributes; we can do
// the same with one write instead of 17 sequential subprocess spawns. The
// `git lfs install --local` is still needed (when git-lfs is present) to
// install the clean/smudge filter hooks, but we run it in parallel with the
// .gitattributes write — and a single failed spawn when git-lfs isn't
// installed beats failing 18 times in a row.
async function setupLfs(projectDir: string, gitPath?: string): Promise<void> {
  const gitattributes =
    LFS_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`).join("\n") +
    "\n";
  await Promise.all([
    fs.writeFile(path.join(projectDir, ".gitattributes"), gitattributes),
    gitExecSafe(["lfs", "install", "--local"], { cwd: projectDir, gitPath }),
  ]);
}

async function createGitignore(projectDir: string): Promise<void> {
  await fs.writeFile(path.join(projectDir, ".gitignore"), PROJECT_GITIGNORE);
}

// One-shot migration: rename a legacy `.clipfirst/` sidecar to `.videocity/`,
// and rewrite any `.clipfirst/*` patterns in `.gitignore`. Idempotent — once
// `.videocity/` exists this is a no-op. The rename + gitignore update are
// committed together so the change appears atomically in project history.
export async function migrateLegacySidecar(
  projectDir: string,
  gitPath?: string,
): Promise<void> {
  const legacy = path.join(projectDir, LEGACY_SIDECAR_DIR);
  const current = path.join(projectDir, VIDEOCITY_DIR);
  let legacyExists = false;
  try {
    await fs.access(legacy);
    legacyExists = true;
  } catch {}
  if (!legacyExists) return;

  let currentExists = false;
  try {
    await fs.access(current);
    currentExists = true;
  } catch {}

  if (!currentExists) {
    await fs.rename(legacy, current);
  } else {
    // Defensive: both dirs exist. Copy any files from legacy that are missing
    // in current, then remove the legacy dir.
    const entries = await fs.readdir(legacy);
    for (const entry of entries) {
      const src = path.join(legacy, entry);
      const dst = path.join(current, entry);
      try {
        await fs.access(dst);
        continue;
      } catch {}
      await fs.rename(src, dst);
    }
    await fs.rm(legacy, { recursive: true, force: true });
  }

  // Rewrite .gitignore entries referencing the legacy dir.
  const gitignorePath = path.join(projectDir, ".gitignore");
  try {
    const existing = await fs.readFile(gitignorePath, "utf-8");
    if (existing.includes(`${LEGACY_SIDECAR_DIR}/`)) {
      const rewritten = existing.replaceAll(
        `${LEGACY_SIDECAR_DIR}/`,
        `${VIDEOCITY_DIR}/`,
      );
      await fs.writeFile(gitignorePath, rewritten);
    }
  } catch {
    // .gitignore may not exist yet; nothing to rewrite.
  }

  // Commit the migration atomically.
  if (await isGitRepo(projectDir)) {
    await gitExecSafe(["add", "-A"], { cwd: projectDir, gitPath });
    await gitExecSafe(
      ["commit", "-m", "chore: migrate sidecar .clipfirst -> .videocity"],
      { cwd: projectDir, gitPath },
    );
  }
}

async function ensureVideocityState(
  projectDir: string,
  gitPath?: string,
): Promise<void> {
  await migrateLegacySidecar(projectDir, gitPath);
  // Lazy bootstrap: opening the state DB creates .videocity/ and runs migrations.
  getStateDb(projectDir);
  await ensureGitignorePatterns(projectDir);
  await ensureGitattributesPatterns(projectDir);
  await ensureMergeOursDriver(projectDir, gitPath);
}

export async function initProjectRepo(
  projectDir: string,
  gitPath?: string,
): Promise<boolean> {
  if (await isGitRepo(projectDir)) {
    await ensureVideocityState(projectDir, gitPath);
    return false;
  }

  await gitExec(["init"], { cwd: projectDir, gitPath });
  await setupLfs(projectDir, gitPath);
  await createGitignore(projectDir);
  await fs.writeFile(
    path.join(projectDir, CREATED_AT_FILE),
    String(Math.floor(Date.now() / 1000)),
  );
  await ensureVideocityState(projectDir, gitPath);
  await gitExecSafe(["add", "-A"], { cwd: projectDir, gitPath });
  await gitExecSafe(["commit", "-m", "Initialize project"], {
    cwd: projectDir,
    gitPath,
  });

  return true;
}
