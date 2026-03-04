import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { OriginalMetadata, ToolParams, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { commitOperation } from '../git/commit.js';
import { withGitLock } from '../git/mutex.js';
import {
  ORIGINAL_METADATA_FILE,
  TOOL_PARAMS_FILE,
  CREATED_AT_FILE,
} from '../constants.js';
import { isSafePath, invalidInput } from '../validation.js';

export async function writeMetadata(
  projectDir: string,
  assetId: string,
  metadata: OriginalMetadata,
  gitPath?: string,
): Promise<Result<OriginalMetadata, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  const assetDir = path.join(projectDir, assetId);
  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  // Write + commit together under mutex so each metadata write gets its own scoped commit
  await withGitLock(projectDir, async () => {
    const metadataPath = path.join(assetDir, ORIGINAL_METADATA_FILE);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Atomically write .created_at if not exists — O_EXCL prevents TOCTOU
    const createdAtPath = path.join(assetDir, CREATED_AT_FILE);
    try {
      await fs.writeFile(createdAtPath, String(Date.now() / 1000), { flag: 'wx' });
    } catch {
      // Already exists — fine
    }

    await commitOperation(projectDir, 'metadata', assetId, undefined, gitPath);
  });

  return ok(metadata);
}

export async function readMetadata(
  projectDir: string,
  assetId: string,
): Promise<Result<OriginalMetadata, FsError>> {
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  const metadataPath = path.join(projectDir, assetId, ORIGINAL_METADATA_FILE);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    return ok(JSON.parse(content) as OriginalMetadata);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return err({ code: 'NOT_FOUND', message: `Metadata not found for asset: ${assetId}` });
    }
    return err({ code: 'IO_ERROR', message: e.message });
  }
}

export async function writeToolParams(
  projectDir: string,
  assetId: string,
  params: ToolParams,
): Promise<Result<ToolParams, FsError>> {
  const assetDir = path.join(projectDir, assetId);
  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  const paramsPath = path.join(assetDir, TOOL_PARAMS_FILE);
  await fs.writeFile(paramsPath, JSON.stringify(params, null, 2));
  return ok(params);
}

export async function readToolParams(
  projectDir: string,
  assetId: string,
): Promise<Result<ToolParams, FsError>> {
  const paramsPath = path.join(projectDir, assetId, TOOL_PARAMS_FILE);
  try {
    const content = await fs.readFile(paramsPath, 'utf-8');
    return ok(JSON.parse(content) as ToolParams);
  } catch {
    return ok({});
  }
}
