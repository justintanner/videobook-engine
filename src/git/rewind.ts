import { gitExec } from './exec.js';
import { isGitRepo } from './init.js';
import { withGitLock } from './mutex.js';

export async function rewindProject(
  projectDir: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  if (!(await isGitRepo(projectDir))) {
    return null;
  }

  return withGitLock(projectDir, async () => {
    try {
      await gitExec(
        ['checkout', commitHash],
        { cwd: projectDir, gitPath },
      );
      return commitHash;
    } catch {
      return null;
    }
  });
}
