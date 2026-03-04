import * as path from 'node:path';

const locks = new Map<string, Promise<void>>();

export async function withGitLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(projectDir);
  const prev = locks.get(key) ?? Promise.resolve();

  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  locks.set(key, next);

  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
    // Clean up if we're the tail of the chain
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}
