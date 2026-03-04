import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createSandbox, type Sandbox } from './helpers/sandbox.js';

describe('asset operations', () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject('test-project');
    if (!result.ok) throw new Error('Failed to create project');
    projectSlug = result.value.slug;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('creates an asset with prefix and name', async () => {
    const result = await sandbox.fs.createAsset('vid', 'dancing cats', projectSlug);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.assetId).toMatch(/^vid-dancing-cats/);

    // .created_at exists
    const createdAt = await fs.readFile(
      path.join(result.value.path, '.created_at'),
      'utf-8',
    );
    expect(parseFloat(createdAt)).toBeGreaterThan(0);
  });

  it('lists assets including video with status', async () => {
    const projectDir = path.join(sandbox.outputDir, projectSlug);
    const assetDir = path.join(projectDir, 'vid-test-video');
    await fs.mkdir(assetDir, { recursive: true });
    await fs.writeFile(path.join(assetDir, '.created_at'), String(Date.now() / 1000));
    await fs.writeFile(path.join(assetDir, 'original.mp4'), 'fake-video-data');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const vid = assets.find((a) => a.id === 'vid-test-video');
    expect(vid).toBeDefined();
    expect(vid!.type).toBe('video');
    // Has original but no subtitles/thumbnail = unreviewed
    expect(vid!.status).toBe('unreviewed');
  });

  it('deletes an asset', async () => {
    const createResult = await sandbox.fs.createAsset('img', 'sunset photo', projectSlug);
    if (!createResult.ok) throw new Error('Failed to create asset');

    const deleteResult = await sandbox.fs.deleteAsset(createResult.value.assetId, projectSlug);
    expect(deleteResult.ok).toBe(true);

    // Directory is gone
    await expect(fs.access(createResult.value.path)).rejects.toThrow();
  });

  it('rejects deleting plan singleton', async () => {
    const result = await sandbox.fs.deleteAsset('plan', projectSlug);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('renames an asset with git mv', async () => {
    const createResult = await sandbox.fs.createAsset('vid', 'old name', projectSlug);
    if (!createResult.ok) throw new Error('Failed to create asset');

    const renameResult = await sandbox.fs.renameAsset(
      createResult.value.assetId,
      'new name',
      projectSlug,
    );
    expect(renameResult.ok).toBe(true);
    if (!renameResult.ok) return;

    expect(renameResult.value.new_asset_id).toMatch(/^vid-new-name/);
    expect(renameResult.value.old_asset_id).toBe(createResult.value.assetId);
  });

  it('gets asset manifest', async () => {
    const createResult = await sandbox.fs.createAsset('vid', 'manifest test', projectSlug);
    if (!createResult.ok) throw new Error('Failed to create asset');

    // Write a file
    await sandbox.fs.writeFile(
      createResult.value.assetId,
      'original.mp4',
      Buffer.from('fake-data'),
      projectSlug,
    );

    const manifestResult = await sandbox.fs.getManifest(createResult.value.assetId, projectSlug);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    expect(manifestResult.value.file_count).toBeGreaterThanOrEqual(2); // .created_at + original.mp4
    const mp4 = manifestResult.value.files.find((f) => f.name === 'original.mp4');
    expect(mp4).toBeDefined();
    expect(mp4!.extension).toBe('mp4');
  });
});
