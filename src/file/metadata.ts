import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { OriginalMetadata, ToolParams, FsError } from '../types.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import {
  ORIGINAL_METADATA_FILE,
  TOOL_PARAMS_FILE,
  CREATED_AT_FILE,
} from '../constants.js';

export async function writeMetadata(
  projectDir: string,
  assetId: string,
  metadata: OriginalMetadata,
): Promise<Result<OriginalMetadata, FsError>> {
  const assetDir = path.join(projectDir, assetId);
  try {
    await fs.access(assetDir);
  } catch {
    return err({ code: 'NOT_FOUND', message: `Asset not found: ${assetId}` });
  }

  const metadataPath = path.join(assetDir, ORIGINAL_METADATA_FILE);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  // Also write .created_at if not exists
  const createdAtPath = path.join(assetDir, CREATED_AT_FILE);
  try {
    await fs.access(createdAtPath);
  } catch {
    await fs.writeFile(createdAtPath, String(Date.now() / 1000));
  }

  return ok(metadata);
}

export async function readMetadata(
  projectDir: string,
  assetId: string,
): Promise<Result<OriginalMetadata, FsError>> {
  const metadataPath = path.join(projectDir, assetId, ORIGINAL_METADATA_FILE);
  try {
    const content = await fs.readFile(metadataPath, 'utf-8');
    return ok(JSON.parse(content) as OriginalMetadata);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return ok({}); // No metadata file — return empty
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
