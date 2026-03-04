import { gitExec } from './exec.js';
import { isGitRepo } from './init.js';
import { commitOperation } from './commit.js';

export async function restoreAsset(
  projectDir: string,
  assetId: string,
  commitHash: string,
  gitPath?: string,
): Promise<string | null> {
  if (!(await isGitRepo(projectDir))) {
    return null;
  }

  try {
    await gitExec(
      ['checkout', commitHash, '--', assetId],
      { cwd: projectDir, gitPath },
    );
  } catch {
    return null;
  }

  return commitOperation(
    projectDir,
    'restore',
    assetId,
    { from_commit: commitHash.slice(0, 8) },
    gitPath,
  );
}
