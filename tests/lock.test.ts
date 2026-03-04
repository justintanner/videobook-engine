import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { createFs } from '../src/index.js';

describe('lock operations', () => {
  let tmpDir: string;
  let assetDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipfirst-lock-'));
    assetDir = path.join(tmpDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const cfs = createFs({ outputDir: '/tmp/unused' });

  it('acquires a lock atomically', async () => {
    const result = await cfs.acquireLock(assetDir, '.generating.lock');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.pid).toBe(process.pid);
    expect(result.value.created_at).toBeGreaterThan(0);

    // File exists
    const content = await fs.readFile(path.join(assetDir, '.generating.lock'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.pid).toBe(process.pid);
  });

  it('rejects acquiring held lock', async () => {
    await cfs.acquireLock(assetDir, '.generating.lock');
    const result = await cfs.acquireLock(assetDir, '.generating.lock');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('LOCK_HELD');
  });

  it('releases a lock', async () => {
    await cfs.acquireLock(assetDir, '.test.lock');
    const result = await cfs.releaseLock(assetDir, '.test.lock');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);

    // Can acquire again
    const reacquire = await cfs.acquireLock(assetDir, '.test.lock');
    expect(reacquire.ok).toBe(true);
  });

  it('checks if locked', async () => {
    expect(await cfs.isLocked(assetDir, '.test.lock')).toBe(false);
    await cfs.acquireLock(assetDir, '.test.lock');
    expect(await cfs.isLocked(assetDir, '.test.lock')).toBe(true);
  });

  it('reads lock data', async () => {
    await cfs.acquireLock(assetDir, '.dl.lock', { url: 'https://example.com' });
    const data = await cfs.getLockData(assetDir, '.dl.lock');
    expect(data).toBeTruthy();
    expect(data!.url).toBe('https://example.com');
    expect(data!.pid).toBe(process.pid);
  });

  it('stores custom data in lock', async () => {
    await cfs.acquireLock(assetDir, '.gen.lock', {
      task_id: 'abc123',
      model: 'veo3',
    });
    const data = await cfs.getLockData(assetDir, '.gen.lock');
    expect(data!.task_id).toBe('abc123');
    expect(data!.model).toBe('veo3');
  });

  it('concurrency: only one process wins the lock', async () => {
    // Simulate concurrent acquires
    const results = await Promise.all([
      cfs.acquireLock(assetDir, '.race.lock'),
      cfs.acquireLock(assetDir, '.race.lock'),
      cfs.acquireLock(assetDir, '.race.lock'),
    ]);

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(2);
  });

  it('cleans stale locks from dead PIDs', async () => {
    // Write a lock with a definitely-dead PID
    const lockData = { created_at: Date.now() / 1000, pid: 999999 };
    await fs.writeFile(
      path.join(assetDir, '.stale.lock'),
      JSON.stringify(lockData),
    );

    const cleaned = await cfs.cleanStaleLocks(assetDir);
    expect(cleaned).toContain('.stale.lock');

    // Lock should be removed
    expect(await cfs.isLocked(assetDir, '.stale.lock')).toBe(false);
  });

  it('does not clean locks from live PIDs', async () => {
    await cfs.acquireLock(assetDir, '.live.lock');
    const cleaned = await cfs.cleanStaleLocks(assetDir);
    expect(cleaned).not.toContain('.live.lock');
    expect(await cfs.isLocked(assetDir, '.live.lock')).toBe(true);
  });
});
