import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createSandbox, type Sandbox } from '../helpers/sandbox.js';
import {
  dangerousFilenameArb,
  dangerousSlugArb,
  dangerousPrefixArb,
  dangerousAssetIdArb,
  validPrefixArb,
  safeAssetNameArb,
} from '../helpers/arbitraries.js';
import { isProjectSlug } from '../../src/project/slug.js';
import { isValidAssetId } from '../../src/validation.js';

describe('path traversal fuzz tests', () => {
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

  it('writeFile rejects filenames with ../', async () => {
    // Create a real asset to write into
    const asset = await sandbox.fs.createAsset('vid', 'test', projectSlug);
    if (!asset.ok) throw new Error('Failed to create asset');
    const assetId = asset.value.assetId;

    await fc.assert(
      fc.asyncProperty(dangerousFilenameArb, async (filename) => {
        const result = await sandbox.fs.writeFile(assetId, filename, 'evil', projectSlug);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_INPUT');
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  it('readFile rejects filenames with ../', async () => {
    // Create a real asset to read from
    const asset = await sandbox.fs.createAsset('vid', 'test', projectSlug);
    if (!asset.ok) throw new Error('Failed to create asset');
    const assetId = asset.value.assetId;

    await fc.assert(
      fc.asyncProperty(dangerousFilenameArb, async (filename) => {
        const result = await sandbox.fs.readFile(assetId, filename, projectSlug);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_INPUT');
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  it('createAsset rejects invalid prefixes', async () => {
    await fc.assert(
      fc.asyncProperty(dangerousPrefixArb, async (prefix) => {
        // Skip actually valid prefixes
        if (['vid', 'img', 'aud', 'script'].includes(prefix)) return;

        const result = await sandbox.fs.createAsset(prefix, '../../etc', projectSlug);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_INPUT');
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  it('deleteAsset rejects assetIds with ../', async () => {
    await fc.assert(
      fc.asyncProperty(
        dangerousAssetIdArb.filter((id) => id !== 'plan' && !isValidAssetId(id)),
        async (assetId) => {
          const result = await sandbox.fs.deleteAsset(assetId, projectSlug);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe('INVALID_INPUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);

  it('deleteAsset cannot escape project directory', async () => {
    const projectDir = path.join(sandbox.outputDir, projectSlug);
    const siblingDir = path.join(sandbox.outputDir, 'sibling');
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(siblingDir, 'secret.txt'), 'do not delete');

    const result = await sandbox.fs.deleteAsset('../sibling', projectSlug);
    expect(result.ok).toBe(false);

    // Verify sibling dir still exists
    const siblingExists = await fs.access(siblingDir).then(() => true, () => false);
    expect(siblingExists).toBe(true);

    const secretExists = await fs.access(path.join(siblingDir, 'secret.txt')).then(() => true, () => false);
    expect(secretExists).toBe(true);
  }, 30_000);

  it('createProject rejects ../escape as slug', async () => {
    const result = await sandbox.fs.createProject('../escape');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT');
    }
  }, 30_000);

  it('createProject rejects all invalid slugs (property test)', async () => {
    await fc.assert(
      fc.asyncProperty(
        dangerousSlugArb.filter((s) => !isProjectSlug(s)),
        async (slug) => {
          const result = await sandbox.fs.createProject(slug);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe('INVALID_INPUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);

  it('switchProject rejects traversal slugs', async () => {
    await fc.assert(
      fc.asyncProperty(dangerousSlugArb, async (slug) => {
        const result = await sandbox.fs.switchProject(slug);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['NOT_FOUND', 'INVALID_INPUT']).toContain(result.error.code);
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);

  it('getManifest rejects assetIds with traversal', async () => {
    await fc.assert(
      fc.asyncProperty(
        dangerousAssetIdArb.filter((id) => !isValidAssetId(id)),
        async (assetId) => {
          const result = await sandbox.fs.getManifest(assetId, projectSlug);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(['INVALID_INPUT', 'NOT_FOUND']).toContain(result.error.code);
          }
        },
      ),
      { numRuns: 20 },
    );
  }, 30_000);

  it('writeFile result path always within project dir', async () => {
    const asset = await sandbox.fs.createAsset('img', 'safe-asset', projectSlug);
    if (!asset.ok) throw new Error('Failed to create asset');
    const assetId = asset.value.assetId;
    const projectDir = path.join(sandbox.outputDir, projectSlug);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('test.txt', 'data.json', 'image.png', 'notes.md'),
        async (filename) => {
          const result = await sandbox.fs.writeFile(assetId, filename, 'safe content', projectSlug);
          expect(result.ok).toBe(true);
          if (result.ok) {
            const resolved = path.resolve(result.value);
            const resolvedProject = path.resolve(projectDir) + path.sep;
            expect(resolved.startsWith(resolvedProject)).toBe(true);
          }
        },
      ),
      { numRuns: 10 },
    );
  }, 30_000);
});
