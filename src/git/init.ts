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

async function setupLfs(projectDir: string, gitPath?: string): Promise<void> {
  await gitExecSafe(["lfs", "install", "--local"], {
    cwd: projectDir,
    gitPath,
  });
  for (const pattern of LFS_PATTERNS) {
    await gitExecSafe(["lfs", "track", pattern], { cwd: projectDir, gitPath });
  }
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
