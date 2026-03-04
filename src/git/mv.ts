import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { gitExecSafe } from './exec.js';
import { isGitRepo } from './init.js';

export async function gitMv(
  projectDir: string,
  oldPath: string,
  newPath: string,
  gitPath?: string,
): Promise<boolean> {
  if (await isGitRepo(projectDir)) {
    // Ensure source is tracked
    await gitExecSafe(['add', '--', oldPath], { cwd: projectDir, gitPath });
    const result = await gitExecSafe(['mv', oldPath, newPath], { cwd: projectDir, gitPath });
    if (result.exitCode === 0) {
      return true;
    }
  }

  // Fallback: filesystem rename — fs.rename fails atomically if dst exists or src missing
  const src = path.join(projectDir, oldPath);
  const dst = path.join(projectDir, newPath);

  try {
    await fs.rename(src, dst);
    return true;
  } catch {
    return false;
  }
}
