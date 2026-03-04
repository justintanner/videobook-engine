import * as fs from "node:fs/promises";
import * as path from "node:path";

import { gitExec, gitExecSafe } from "./exec.js";

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

export async function initProjectRepo(
  projectDir: string,
  gitPath?: string,
): Promise<boolean> {
  if (await isGitRepo(projectDir)) {
    return false;
  }

  await gitExec(["init"], { cwd: projectDir, gitPath });
  await setupLfs(projectDir, gitPath);
  await createGitignore(projectDir);
  await gitExecSafe(["add", "-A"], { cwd: projectDir, gitPath });
  await gitExecSafe(["commit", "-m", "Initialize project"], {
    cwd: projectDir,
    gitPath,
  });

  return true;
}
