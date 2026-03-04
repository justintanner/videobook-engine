import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createFs, type ClipfirstFs } from '../../src/index.js';

const execFileAsync = promisify(execFile);

export interface Sandbox {
  dir: string;
  outputDir: string;
  fs: ClipfirstFs;
  cleanup: () => Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipfirst-fs-test-'));
  const outputDir = path.join(dir, 'output');
  await fs.mkdir(outputDir, { recursive: true });

  // Configure git for test environment
  await execFileAsync('git', ['config', '--global', 'user.email', 'test@clipfirst.test'], {
    env: { ...process.env, HOME: dir },
  }).catch(() => {});
  await execFileAsync('git', ['config', '--global', 'user.name', 'Test User'], {
    env: { ...process.env, HOME: dir },
  }).catch(() => {});

  const instance = createFs({ outputDir });

  return {
    dir,
    outputDir,
    fs: instance,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
