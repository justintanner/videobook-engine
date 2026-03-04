import { gitExec } from './exec.js';
import { isGitRepo } from './init.js';

export async function rewindToCommit(
  projectDir: string,
  commitHash: string,
  gitPath?: string,
): Promise<void> {
  if (!(await isGitRepo(projectDir))) {
    throw new Error(`Not a git repository: ${projectDir}`);
  }

  await gitExec(['checkout', commitHash], { cwd: projectDir, gitPath });
}
