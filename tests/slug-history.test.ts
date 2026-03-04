import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createSandbox, type Sandbox } from './helpers/sandbox.js';

describe('slug history and reuse prevention', () => {
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

  it('slugTaken returns false for never-used slug', async () => {
    const taken = await sandbox.fs.slugTaken('vid-nonexistent', projectSlug);
    expect(taken).toBe(false);
  });

  it('slugTaken returns true for existing asset', async () => {
    const result = await sandbox.fs.createAsset('vid', 'hello world', projectSlug);
    if (!result.ok) throw new Error('Failed to create asset');

    const taken = await sandbox.fs.slugTaken(result.value.assetId, projectSlug);
    expect(taken).toBe(true);
  });

  it('slugTaken returns true after asset is deleted', async () => {
    const result = await sandbox.fs.createAsset('vid', 'deleted clip', projectSlug);
    if (!result.ok) throw new Error('Failed to create asset');
    const assetId = result.value.assetId;

    await sandbox.fs.deleteAsset(assetId, projectSlug);

    const taken = await sandbox.fs.slugTaken(assetId, projectSlug);
    expect(taken).toBe(true);
  });

  it('slugTaken returns true for old slug after rename', async () => {
    const result = await sandbox.fs.createAsset('vid', 'original name', projectSlug);
    if (!result.ok) throw new Error('Failed to create asset');
    const oldId = result.value.assetId;

    const renameResult = await sandbox.fs.renameAsset(oldId, 'new name', projectSlug);
    if (!renameResult.ok) throw new Error('Failed to rename asset');

    const taken = await sandbox.fs.slugTaken(oldId, projectSlug);
    expect(taken).toBe(true);
  });

  it('createAsset with same name as deleted asset gets a suffixed slug', async () => {
    const result = await sandbox.fs.createAsset('vid', 'reuse me', projectSlug);
    if (!result.ok) throw new Error('Failed to create asset');
    const originalId = result.value.assetId;

    await sandbox.fs.deleteAsset(originalId, projectSlug);

    const result2 = await sandbox.fs.createAsset('vid', 'reuse me', projectSlug);
    if (!result2.ok) throw new Error('Failed to create second asset');

    expect(result2.value.assetId).not.toBe(originalId);
    expect(result2.value.assetId).toMatch(new RegExp(`^${originalId}-\\d+$`));
  });

  it('renameAsset to name matching deleted slug gets a suffixed slug', async () => {
    // Create and delete an asset to reserve its slug
    const first = await sandbox.fs.createAsset('vid', 'taken name', projectSlug);
    if (!first.ok) throw new Error('Failed to create first asset');
    const takenId = first.value.assetId;
    await sandbox.fs.deleteAsset(takenId, projectSlug);

    // Create another asset and try to rename it to the same name
    const second = await sandbox.fs.createAsset('vid', 'other clip', projectSlug);
    if (!second.ok) throw new Error('Failed to create second asset');

    const renameResult = await sandbox.fs.renameAsset(second.value.assetId, 'taken name', projectSlug);
    if (!renameResult.ok) throw new Error('Failed to rename asset');

    expect(renameResult.value.new_asset_id).not.toBe(takenId);
    expect(renameResult.value.new_asset_id).toMatch(new RegExp(`^${takenId}-\\d+$`));
  });

  it('slugTaken returns false for unknown project', async () => {
    const taken = await sandbox.fs.slugTaken('vid-anything', 'nonexistent-project');
    expect(taken).toBe(false);
  });
});
