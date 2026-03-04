import type { FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { gitExecSafe } from './exec.js';
import { isGitRepo } from './init.js';
import { withGitLock } from './mutex.js';

export async function rewindToCommit(
  projectDir: string,
  commitHash: string,
  gitPath?: string,
): Promise<Result<void, FsError>> {
  if (!(await isGitRepo(projectDir))) {
    return err({ code: 'GIT_ERROR', message: `Not a git repository: ${projectDir}` });
  }

  return withGitLock(projectDir, async () => {
    const result = await gitExecSafe(['checkout', commitHash], { cwd: projectDir, gitPath });
    if (result.exitCode !== 0) {
      return err({ code: 'GIT_ERROR', message: result.stderr || `Failed to rewind to ${commitHash}` });
    }
    return ok(undefined);
  });
}
