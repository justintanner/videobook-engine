import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

export interface GitExecOptions {
  cwd: string;
  gitPath?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export async function gitExec(
  args: string[],
  opts: GitExecOptions,
): Promise<GitExecResult> {
  const git = opts.gitPath ?? 'git';
  const { stdout, stderr } = await execFileAsync(git, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout, stderr };
}

export async function gitExecSafe(
  args: string[],
  opts: GitExecOptions,
): Promise<GitExecResult & { exitCode: number }> {
  try {
    const result = await gitExec(args, opts);
    return { ...result, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}
