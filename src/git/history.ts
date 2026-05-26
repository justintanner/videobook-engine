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
    ['log', `--max-count=${limit}`, '--format=%H\x1f%s\x1f%ai', '--name-status', '--', assetId],
    { cwd: projectDir, gitPath },
  );

  if (result.exitCode !== 0) {
    return [];
  }

  return parseAssetHistoryOutput(result.stdout, assetId);
}

function parseAssetHistoryOutput(stdout: string, assetId: string): GitCommit[] {
  const history: GitCommit[] = [];
  const prefix = assetId + '/';
  let current: GitCommit | null = null;
  const stripPrefix = (file: string): string =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file;

  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    if (line.includes('\x1f')) {
      const parts = line.split('\x1f');
      if (parts.length < 3) continue;
      current = { hash: parts[0]!, message: parts[1]!, date: parts[2]!, files: [], fileChanges: [] };
      history.push(current);
    } else if (current) {
      const fields = line.split('\t');
      const status = fields[0] ?? '';
      const rawFile = fields.length >= 3 && /^[RC]/.test(status)
        ? fields[2]!
        : fields[1] ?? line;
      const file = stripPrefix(rawFile);
      current.files!.push(file);
      current.fileChanges!.push({
        status: status[0] ?? '',
        file,
        ...(fields.length >= 3 && /^[RC]/.test(status) ? { oldFile: stripPrefix(fields[1]!) } : {}),
      });
    }
  }
  return history;
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
