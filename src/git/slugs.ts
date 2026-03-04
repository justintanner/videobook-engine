import { gitExecSafe } from './exec.js';
import { isGitRepo } from './init.js';

const SLUG_RE = /^\[([^\]]+)\]/;

export async function getHistoricalSlugs(
  projectDir: string,
  gitPath?: string,
): Promise<Set<string>> {
  if (!(await isGitRepo(projectDir))) {
    return new Set();
  }

  const result = await gitExecSafe(
    ['log', '--all', '--format=%s'],
    { cwd: projectDir, gitPath },
  );

  if (result.exitCode !== 0) {
    return new Set();
  }

  const slugs = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = SLUG_RE.exec(line);
    if (match) {
      slugs.add(match[1]!);
    }
  }
  return slugs;
}
