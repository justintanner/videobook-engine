import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createFs, type ClipfirstFs } from '../../src/index.js';
import { closeAllStateDbs } from '../../src/db/client.js';

const execFileAsync = promisify(execFile);

export interface Sandbox {
  dir: string;
  projectsDir: string;
  fs: ClipfirstFs;
  cleanup: () => Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipfirst-fs-test-'));
  const projectsDir = path.join(dir, 'projects');
  await fs.mkdir(projectsDir, { recursive: true });

  // Configure git for test environment
  await execFileAsync('git', ['config', '--global', 'user.email', 'test@clipfirst.test'], {
    env: { ...process.env, HOME: dir },
  }).catch(() => {});
  await execFileAsync('git', ['config', '--global', 'user.name', 'Test User'], {
    env: { ...process.env, HOME: dir },
  }).catch(() => {});

  const instance = createFs({ projectsDir });

  return {
    dir,
    projectsDir,
    fs: instance,
    cleanup: async () => {
      closeAllStateDbs();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
