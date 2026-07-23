import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createSandbox, type Sandbox } from './helpers/sandbox.js';

describe('revision operations', () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject('git-test');
    if (!result.ok) throw new Error('Failed to create project');
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('commit creates a git commit with structured message', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'data');

    const hash = await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);
    expect(hash).toBeTruthy();
    expect(hash!.length).toBeGreaterThanOrEqual(7);
  });

  it('getHistory returns commit log', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'data1');
    await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);

    await fs.writeFile(path.join(assetDir, 'thumbnail.jpg'), 'thumb');
    await sandbox.fs.commitOperation('thumbnail', 'vid-test', undefined, projectSlug);

    const history = await sandbox.fs.getHistory(projectSlug);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]!.message).toContain('thumbnail');
  });

  it('getAssetHistory scopes to single asset', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);

    // Create two assets
    const dir1 = path.join(projectDir, 'vid-a');
    const dir2 = path.join(projectDir, 'vid-b');
    await fs.mkdir(dir1, { recursive: true });
    await fs.mkdir(dir2, { recursive: true });

    await fs.writeFile(path.join(dir1, 'original.mp4'), 'a');
    await sandbox.fs.commitOperation('upload', 'vid-a', undefined, projectSlug);

    await fs.writeFile(path.join(dir2, 'original.mp4'), 'b');
    await sandbox.fs.commitOperation('upload', 'vid-b', undefined, projectSlug);

    const history = await sandbox.fs.getAssetHistory('vid-a', projectSlug);
    expect(history.length).toBe(1);
    expect(history[0]!.message).toContain('vid-a');
  });

  it('getAssetHistory includes file change statuses', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });

    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-1');
    await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);

    await fs.unlink(path.join(assetDir, 'original.mp4'));
    await sandbox.fs.commitOperation('delete-file', 'vid-test', undefined, projectSlug);

    const history = await sandbox.fs.getAssetHistory('vid-test', projectSlug);
    expect(history[0]!.fileChanges).toEqual([
      { status: 'D', file: 'original.mp4' },
    ]);
    expect(history[1]!.fileChanges).toEqual([
      { status: 'A', file: 'original.mp4' },
    ]);
  });

  it('restoreAsset restores files from a previous commit', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });

    // Write v1
    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-1');
    const hash1 = await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);
    expect(hash1).toBeTruthy();

    // Write v2
    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-2');
    await sandbox.fs.commitOperation('edit', 'vid-test', undefined, projectSlug);

    // Restore to v1
    const restoreHash = await sandbox.fs.restoreAsset('vid-test', hash1!, projectSlug);
    expect(restoreHash).toBeTruthy();

    // Verify content
    const content = await fs.readFile(path.join(assetDir, 'original.mp4'), 'utf-8');
    expect(content).toBe('version-1');
  });

  it('restoreAsset always records a new forward revision', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });

    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-1');
    const hash1 = await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);
    expect(hash1).toBeTruthy();

    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-2');
    await sandbox.fs.commitOperation('edit', 'vid-test', undefined, projectSlug);

    const firstRestoreHash = await sandbox.fs.restoreAsset('vid-test', hash1!, projectSlug);
    expect(firstRestoreHash).toBeTruthy();

    const secondRestoreHash = await sandbox.fs.restoreAsset('vid-test', hash1!, projectSlug);
    expect(secondRestoreHash).not.toBe(firstRestoreHash);

    const content = await fs.readFile(path.join(assetDir, 'original.mp4'), 'utf-8');
    expect(content).toBe('version-1');
  });

  it('restoreAsset removes files added after the target commit', async () => {
    const projectDir = path.join(sandbox.projectsDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test');
    await fs.mkdir(assetDir, { recursive: true });

    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'version-1');
    const hash1 = await sandbox.fs.commitOperation('upload', 'vid-test', undefined, projectSlug);
    expect(hash1).toBeTruthy();

    await fs.writeFile(path.join(assetDir, 'analysis.json'), 'later-only');
    await sandbox.fs.commitOperation('write', 'vid-test', undefined, projectSlug);

    const restoreHash = await sandbox.fs.restoreAsset('vid-test', hash1!, projectSlug);
    expect(restoreHash).toBeTruthy();

    const content = await fs.readFile(path.join(assetDir, 'original.mp4'), 'utf-8');
    expect(content).toBe('version-1');
    await expect(fs.access(path.join(assetDir, 'analysis.json'))).rejects.toThrow();
  });
});
