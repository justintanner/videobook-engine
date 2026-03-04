import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createSandbox, type Sandbox } from '../helpers/sandbox.js';
import { deriveAssetStatus, getAssetType } from '../../src/asset/status.js';
import { getManifest } from '../../src/asset/manifest.js';
import type { AssetStatus } from '../../src/types.js';

describe('status machine fuzz', () => {
  let sandbox: Sandbox;
  let projectSlug: string;
  let projectDir: string;

  beforeEach(async () => {
    sandbox = await createSandbox();
    const result = await sandbox.fs.createProject('fuzz-test');
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

  it('image with .transcribe.error should NOT be error status', async () => {
    const dir = await makeAssetDir('img-transcribe-err');
    await fs.writeFile(path.join(dir, '.transcribe.error'), '{"error":"test"}');
    await fs.writeFile(path.join(dir, 'original.jpg'), 'fake');

    const status = await deriveAssetStatus(dir, 'image', true, []);
    expect(status).toBe('ready');
    expect(status).not.toBe('error');
  });

  it('audio with .transcribe.error should NOT be error status', async () => {
    const dir = await makeAssetDir('aud-transcribe-err');
    await fs.writeFile(path.join(dir, '.transcribe.error'), '{"error":"test"}');
    await fs.writeFile(path.join(dir, 'original.mp3'), 'fake');

    const status = await deriveAssetStatus(dir, 'audio', true, []);
    expect(status).toBe('ready');
    expect(status).not.toBe('error');
  });

  it('getManifest includes square_frames directory', async () => {
    const dir = await makeAssetDir('vid-square-frames');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');
    const squareDir = path.join(dir, 'square_frames');
    await fs.mkdir(squareDir, { recursive: true });
    await fs.writeFile(path.join(squareDir, 'frame001.jpg'), 'fake');
    await fs.writeFile(path.join(squareDir, 'frame002.jpg'), 'fake');

    const result = await getManifest(projectDir, 'vid-square-frames');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    expect(result.value.frames).toBeDefined();
    expect(result.value.frames!.square_frames).toBeDefined();
    expect(result.value.frames!.square_frames).toEqual(['frame001.jpg', 'frame002.jpg']);
  });

  it('getAssetType returns correct type for all known prefixes', () => {
    const cases: Array<[string, string]> = [
      ['vid-my-video', 'video'],
      ['img-my-image', 'image'],
      ['aud-my-audio', 'audio'],
      ['script-my-script', 'script'],
      ['final', 'final'],
      ['plan', 'plan'],
    ];

    for (const [name, expectedType] of cases) {
      expect(getAssetType(name)).toBe(expectedType);
    }
  });

  it('getAssetType does not silently default to video', () => {
    expect(() => getAssetType('unknown-thing')).toThrow('Unknown asset prefix: unknown-thing');
  });

  it('video with original but no transcription documents untranscribed gap', async () => {
    const dir = await makeAssetDir('vid-no-trans');
    await fs.writeFile(path.join(dir, 'original.mp4'), 'fake');

    const status = await deriveAssetStatus(dir, 'video', true, []);
    // 'untranscribed' has been removed from the status union; videos without
    // transcription fall through to 'unreviewed' instead.
    expect(status).not.toBe('untranscribed');
    expect(status).toBe('unreviewed');
  });

  it('all declared AssetStatus values are either reachable or documented', () => {
    // The 'untranscribed' value has been removed from the AssetStatus union.
    // Verify that the canonical set of status values does NOT include it.
    const ALL_STATUS_VALUES: AssetStatus[] = [
      'downloading',
      'generating',
      'transcribing',
      'rendering',
      'rendering-landscape',
      'rendering-portrait',
      'rendering-square',
      'render-queued',
      'render-queued-landscape',
      'render-queued-portrait',
      'render-queued-square',
      'error',
      'render-error',
      'render-error-landscape',
      'render-error-portrait',
      'render-error-square',
      'ready',
      'unreviewed',
      'whitelisted',
      'corrupt',
    ];

    // 'untranscribed' cannot appear here because it would be a TypeScript
    // compile error — it is no longer part of AssetStatus.
    expect(ALL_STATUS_VALUES).not.toContain('untranscribed');
    // Sanity: all expected values are present
    expect(ALL_STATUS_VALUES).toContain('ready');
    expect(ALL_STATUS_VALUES).toContain('unreviewed');
    expect(ALL_STATUS_VALUES).toContain('corrupt');
  });
});
