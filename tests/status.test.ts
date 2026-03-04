import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createSandbox, type Sandbox } from './helpers/sandbox.js';

describe('asset status derivation', () => {
  let sandbox: Sandbox;
  let projectSlug: string;
  let projectDir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject('status-test');
    if (!result.ok) throw new Error('Failed to create project');
    projectSlug = result.value.slug;
    projectDir = result.value.path;
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function makeAssetDir(name: string): Promise<string> {
    const dir = path.join(projectDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.created_at'), String(Date.now() / 1000));
    return dir;
  }

  it('video with lock → downloading', async () => {
    const dir = await makeAssetDir('vid-dl');
    await fs.writeFile(path.join(dir, '.downloading.lock'), String(Date.now() / 1000));

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-dl');
    expect(asset!.status).toBe('downloading');
  });

  it('video with generating lock → generating', async () => {
    const dir = await makeAssetDir('vid-gen');
    await fs.writeFile(
      path.join(dir, '.generating.lock'),
      JSON.stringify({ created_at: Date.now() / 1000, task_id: 'abc' }),
    );

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-gen');
    expect(asset!.status).toBe('generating');
  });

  it('video with transcribing lock → transcribing', async () => {
    const dir = await makeAssetDir('vid-trans');
    await fs.writeFile(path.join(dir, '.transcribing.lock'), String(Date.now() / 1000));

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-trans');
    expect(asset!.status).toBe('transcribing');
  });

  it('video with rendering lock → rendering-landscape', async () => {
    const dir = await makeAssetDir('vid-render');
    await fs.writeFile(path.join(dir, '.rendering-landscape.lock'), String(Date.now() / 1000));

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-render');
    expect(asset!.status).toBe('rendering-landscape');
  });

  it('video with error file → error', async () => {
    const dir = await makeAssetDir('vid-err');
    await fs.writeFile(path.join(dir, '.generating.error'), '{"error": "test"}');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-err');
    expect(asset!.status).toBe('error');
  });

  it('video with original but no subs → unreviewed', async () => {
    const dir = await makeAssetDir('vid-unrev');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-unrev');
    expect(asset!.status).toBe('unreviewed');
  });

  it('video with original + whitelisted → whitelisted', async () => {
    const dir = await makeAssetDir('vid-wl');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');
    await fs.writeFile(path.join(dir, '.whitelisted_at'), String(Date.now() / 1000));

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-wl');
    expect(asset!.status).toBe('whitelisted');
  });

  it('video with original + subs + thumbnail + export → ready', async () => {
    const dir = await makeAssetDir('vid-ready');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');
    await fs.writeFile(path.join(dir, 'elevenlabs.json'), '{}');
    await fs.writeFile(path.join(dir, 'thumbnail.jpg'), 'fake');
    // Need landscape export so it's not render-queued
    await fs.writeFile(path.join(dir, '1920x1080_landscape.mp4'), 'fake');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-ready');
    expect(asset!.status).toBe('ready');
  });

  it('video with subs but no export → render-queued-landscape', async () => {
    const dir = await makeAssetDir('vid-queued');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');
    await fs.writeFile(path.join(dir, 'elevenlabs.json'), '{}');
    await fs.writeFile(path.join(dir, 'thumbnail.jpg'), 'fake');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-queued');
    expect(asset!.status).toBe('render-queued-landscape');
  });

  it('video with no original → corrupt', async () => {
    await makeAssetDir('vid-corrupt');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'vid-corrupt');
    expect(asset!.status).toBe('corrupt');
  });

  it('image generating → generating', async () => {
    const dir = await makeAssetDir('img-gen');
    await fs.writeFile(
      path.join(dir, '.generating.lock'),
      JSON.stringify({ created_at: Date.now() / 1000 }),
    );

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'img-gen');
    expect(asset!.status).toBe('generating');
  });

  it('image with original → ready', async () => {
    const dir = await makeAssetDir('img-ready');
    await fs.writeFile(path.join(dir, 'original.jpg'), 'fake');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'img-ready');
    expect(asset!.status).toBe('ready');
  });

  it('audio with original → ready', async () => {
    const dir = await makeAssetDir('aud-test');
    await fs.writeFile(path.join(dir, 'original.mp3'), 'fake');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'aud-test');
    expect(asset!.status).toBe('ready');
  });

  it('script with index.md → ready', async () => {
    const dir = await makeAssetDir('script-test');
    await fs.writeFile(path.join(dir, 'index.md'), '# My Script');

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'script-test');
    expect(asset!.status).toBe('ready');
    expect(asset!.prompt).toBe('# My Script');
  });

  it('final with timeline lock → rendering', async () => {
    const dir = await makeAssetDir('final');
    await fs.writeFile(path.join(dir, '.timeline.lock'), String(Date.now() / 1000));

    const assets = await sandbox.fs.listAssets(projectSlug);
    const asset = assets.find((a) => a.id === 'final');
    expect(asset!.status).toBe('rendering');
  });
});
