import type { GitCommit } from '../types.js';
import { gitExecSafe } from './exec.js';
import { isGitRepo } from './init.js';

export async function getHistory(
  projectDir: string,
  limit: number = 20,
  gitPath?: string,
): Promise<GitCommit[]> {
  if (!(await isGitRepo(projectDir))) {
    return [];
  }

  const result = await gitExecSafe(
    ['log', `--max-count=${limit}`, '--format=%H\x1f%s\x1f%ai\x1f%an'],
    { cwd: projectDir, gitPath },
  );

  if (result.exitCode !== 0) {
    return [];
  }

  return parseHistoryLines(result.stdout, true);
}

export async function getAssetHistory(
  projectDir: string,
  assetId: string,
  limit: number = 20,
  gitPath?: string,
): Promise<GitCommit[]> {
  if (!(await isGitRepo(projectDir))) {
    return [];
  }

  const result = await gitExecSafe(
    ['log', `--max-count=${limit}`, '--format=%H\x1f%s\x1f%ai', '--', assetId],
    { cwd: projectDir, gitPath },
  );

  if (result.exitCode !== 0) {
    return [];
  }

  return parseHistoryLines(result.stdout, false);
}

function parseHistoryLines(stdout: string, includeAuthor: boolean): GitCommit[] {
  const history: GitCommit[] = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\x1f');
    const minParts = includeAuthor ? 4 : 3;
    if (parts.length < minParts) continue;

    const commit: GitCommit = {
      hash: parts[0]!,
      message: parts[1]!,
      date: parts[2]!,
    };
    if (includeAuthor && parts[3]) {
      commit.author = parts[3];
    }
    history.push(commit);
  }
  return history;
}
