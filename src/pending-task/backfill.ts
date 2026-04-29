import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getStateDb } from "../db/client.js";
import { listAssets } from "../asset/list.js";
import { writePendingTask } from "./write.js";
import { writeGenerationError } from "./errors.js";
import type { TaskType } from "./types.js";

export interface BackfillReport {
  pendingTasksMigrated: number;
  generationErrorsMigrated: number;
}

interface LegacyKieTask {
  taskId?: unknown;
  taskType?: unknown;
  assetId?: unknown;
  assetDir?: unknown;
  meta?: unknown;
  completing?: unknown;
}

interface LegacyGenerationError {
  message?: unknown;
  failCode?: unknown;
  prompt?: unknown;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(buf) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return null;
  } catch {
    return null;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw error;
  }
}

function alreadyHasPendingTask(
  projectDir: string,
  assetId: string,
): boolean {
  const db = getStateDb(projectDir);
  const row = db
    .prepare("SELECT 1 FROM pending_tasks WHERE asset_id = ?")
    .get(assetId);
  return Boolean(row);
}

function alreadyHasGenerationError(
  projectDir: string,
  assetId: string,
): boolean {
  const db = getStateDb(projectDir);
  const row = db
    .prepare("SELECT 1 FROM generation_errors WHERE asset_id = ?")
    .get(assetId);
  return Boolean(row);
}

async function backfillKieTask(
  projectDir: string,
  assetId: string,
  assetDir: string,
): Promise<boolean> {
  const sidecarPath = path.join(assetDir, ".kie-task.json");
  const legacy = await readJson<LegacyKieTask>(sidecarPath);
  if (!legacy) return false;
  if (alreadyHasPendingTask(projectDir, assetId)) {
    await unlinkIfExists(sidecarPath);
    return false;
  }
  const taskId = typeof legacy.taskId === "string" ? legacy.taskId : null;
  const taskType =
    typeof legacy.taskType === "string" ? (legacy.taskType as TaskType) : null;
  const dirFromLegacy =
    typeof legacy.assetDir === "string" ? legacy.assetDir : null;
  if (!taskId || !taskType) {
    return false;
  }
  const meta =
    legacy.meta && typeof legacy.meta === "object" && !Array.isArray(legacy.meta)
      ? (legacy.meta as Record<string, unknown>)
      : {};
  const completing = legacy.completing === true;

  const result = writePendingTask(projectDir, {
    assetId,
    taskId,
    taskType,
    assetDir: dirFromLegacy ?? assetDir,
    meta,
    completing,
  });
  if (!result.ok) return false;
  await unlinkIfExists(sidecarPath);
  return true;
}

async function backfillGenerationError(
  projectDir: string,
  assetId: string,
  assetDir: string,
): Promise<boolean> {
  const sidecarPath = path.join(assetDir, ".generation-error.json");
  const legacy = await readJson<LegacyGenerationError>(sidecarPath);
  if (!legacy) return false;
  if (alreadyHasGenerationError(projectDir, assetId)) {
    await unlinkIfExists(sidecarPath);
    return false;
  }
  const message =
    typeof legacy.message === "string" ? legacy.message : null;
  if (!message) return false;
  const failCode =
    typeof legacy.failCode === "string" ? legacy.failCode : undefined;
  const prompt =
    typeof legacy.prompt === "string" ? legacy.prompt : undefined;

  const result = writeGenerationError(projectDir, assetId, {
    message,
    ...(failCode !== undefined ? { failCode } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  });
  if (!result.ok) return false;
  await unlinkIfExists(sidecarPath);
  return true;
}

/**
 * Idempotently migrate any leftover `.kie-task.json` and `.generation-error.json`
 * sidecars in this project into the `pending_tasks` and `generation_errors`
 * tables. Safe to run on every boot — only acts on sidecars that don't already
 * have a corresponding row.
 */
export async function backfillPendingTaskSidecars(
  projectDir: string,
  gitPath?: string,
): Promise<BackfillReport> {
  const assets = await listAssets(projectDir, gitPath);
  let pendingTasksMigrated = 0;
  let generationErrorsMigrated = 0;
  for (const asset of assets) {
    if (await backfillKieTask(projectDir, asset.id, asset.path)) {
      pendingTasksMigrated++;
    }
    if (await backfillGenerationError(projectDir, asset.id, asset.path)) {
      generationErrorsMigrated++;
    }
  }
  return { pendingTasksMigrated, generationErrorsMigrated };
}
