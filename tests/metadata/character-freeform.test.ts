import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createSandbox, type Sandbox } from '../helpers/sandbox.js';

describe('character free-form assets', () => {
  let sandbox: Sandbox;
  let projectSlug: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject('test-project');
    if (!result.ok) throw new Error('Failed to create project');
    projectSlug = result.value.slug;
  }, 15_000);

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('can create a char asset, write arbitrary files, and is ready', async () => {
    const asset = await sandbox.fs.createAsset('char', 'hero', projectSlug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;
    
    const assetId = asset.value.assetId;

    // Check status when empty
    let status = await sandbox.fs.getAssetStatus(assetId, projectSlug);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toBe('ready');
    }

    // Write arbitrary files
    await sandbox.fs.writeFile(assetId, 'face.jpg', Buffer.from('fake image'), projectSlug);
    await sandbox.fs.writeFile(assetId, 'voice.mp3', Buffer.from('fake audio'), projectSlug);

    // Check status again
    status = await sandbox.fs.getAssetStatus(assetId, projectSlug);
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toBe('ready');
    }
  }, 30_000);

  it('can read and write arbitrary free-form metadata', async () => {
    const asset = await sandbox.fs.createAsset('char', 'villain', projectSlug);
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;
    
    const assetId = asset.value.assetId;

    const payload = { any: 'json', val: 42 };
    
    const writeResult = await sandbox.fs.writeMetadata(assetId, 'character', payload, projectSlug);
    expect(writeResult.ok).toBe(true);

    const readResult = await sandbox.fs.readMetadata<typeof payload>(assetId, 'character', projectSlug);
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value).toEqual(payload);
    }
  }, 30_000);
});
