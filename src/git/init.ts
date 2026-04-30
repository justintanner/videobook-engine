import * as fs from "node:fs/promises";
import * as path from "node:path";

import { gitExec, gitExecSafe } from "./exec.js";
import { CREATED_AT_FILE } from "../constants.js";
import { CLIPFIRST_DIR, getStateDb } from "../db/client.js";
import { ensureGitignorePatterns } from "../db/gitignore.js";

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
${CLIPFIRST_DIR}/state.sqlite
${CLIPFIRST_DIR}/state.sqlite-wal
${CLIPFIRST_DIR}/state.sqlite-shm
${CLIPFIRST_DIR}/state.sqlite-journal
${CLIPFIRST_DIR}/.project.lock
${CLIPFIRST_DIR}/metadata.sqlite-journal
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

async function ensureClipfirstState(projectDir: string): Promise<void> {
  // Lazy bootstrap: opening the state DB creates .clipfirst/ and runs migrations.
  getStateDb(projectDir);
  await ensureGitignorePatterns(projectDir);
}

export async function initProjectRepo(
  projectDir: string,
  gitPath?: string,
): Promise<boolean> {
  if (await isGitRepo(projectDir)) {
    await ensureClipfirstState(projectDir);
    return false;
  }

  await gitExec(["init"], { cwd: projectDir, gitPath });
  await setupLfs(projectDir, gitPath);
  await createGitignore(projectDir);
  await fs.writeFile(
    path.join(projectDir, CREATED_AT_FILE),
    String(Math.floor(Date.now() / 1000)),
  );
  await ensureClipfirstState(projectDir);
  await gitExecSafe(["add", "-A"], { cwd: projectDir, gitPath });
  await gitExecSafe(["commit", "-m", "Initialize project"], {
    cwd: projectDir,
    gitPath,
  });

  return true;
}
