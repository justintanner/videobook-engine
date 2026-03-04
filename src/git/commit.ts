import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { gitExecSafe } from './exec.js';
import { isGitRepo } from './init.js';

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

function isIndexLockError(stderr: string): boolean {
  return stderr.includes('index.lock') || stderr.includes('Unable to create');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function commitOperation(
  projectDir: string,
  operation: string,
  assetId?: string,
  details?: Record<string, unknown>,
  gitPath?: string,
): Promise<string | null> {
  if (!(await isGitRepo(projectDir))) {
    return null;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Stage changes scoped to asset directory when possible
    const assetDirName = assetId?.split('/')[0];
    const scopedDir = assetDirName ? path.join(projectDir, assetDirName) : null;

    let addResult;
    if (scopedDir) {
      try {
        await fs.access(scopedDir);
        addResult = await gitExecSafe(['add', '--', assetDirName!], { cwd: projectDir, gitPath });
      } catch {
        addResult = await gitExecSafe(['add', '-A'], { cwd: projectDir, gitPath });
      }
    } else {
      addResult = await gitExecSafe(['add', '-A'], { cwd: projectDir, gitPath });
    }

    if (addResult.exitCode !== 0) {
      if (isIndexLockError(addResult.stderr) && attempt < MAX_ATTEMPTS - 1) {
        await delay(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return null;
    }

    // Check for changes
    const statusResult = await gitExecSafe(['status', '--porcelain'], { cwd: projectDir, gitPath });
    if (!statusResult.stdout.trim()) {
      return null;
    }

    // Build commit message
    const subject = assetId ? `${operation}: ${assetId}` : `${operation}: project`;
    const bodyLines: string[] = [];
    if (details) {
      for (const [key, value] of Object.entries(details)) {
        if (value !== undefined && value !== null) {
          bodyLines.push(`${key}: ${value}`);
        }
      }
    }
    const message = bodyLines.length > 0
      ? `${subject}\n\n${bodyLines.join('\n')}`
      : subject;

    const commitResult = await gitExecSafe(['commit', '-m', message], { cwd: projectDir, gitPath });
    if (commitResult.exitCode !== 0) {
      if (isIndexLockError(commitResult.stderr) && attempt < MAX_ATTEMPTS - 1) {
        await delay(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return null;
    }

    // Get commit hash
    const hashResult = await gitExecSafe(['rev-parse', 'HEAD'], { cwd: projectDir, gitPath });
    return hashResult.exitCode === 0 ? hashResult.stdout.trim() : null;
  }

  return null;
}
