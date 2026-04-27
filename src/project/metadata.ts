import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { invalidInput } from "../validation.js";
import { commitOperation } from "../git/commit.js";
import { withGitLock } from "../git/mutex.js";
import { withCleanWorktree } from "../git/stash.js";
import {
  commitAndFinalizeOperation,
  runOperation,
} from "../db/run-operation.js";
import {
  type TimelineConfig,
  exportTimeline,
  readTimeline,
  writeTimeline,
} from "../db/timeline.js";
import { getMetadataDb } from "../db/metadata-client.js";
import { exportAssetEvents } from "../db/asset-events.js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const KEY_MAX_LENGTH = 100;

function validateKey(key: string): Result<never, FsError> | null {
  if (!key || key.length > KEY_MAX_LENGTH || !KEY_PATTERN.test(key)) {
    return invalidInput(
      `Invalid metadata key: ${key} (must match ${KEY_PATTERN.source}, max ${KEY_MAX_LENGTH} chars)`,
    );
  }
  return null;
}

function metadataFilename(key: string): string {
  return `.${key}.json`;
}

const TIMELINE_KEY = "timeline";

function slotsAreValid(slots: unknown[]): boolean {
  for (const s of slots) {
    if (
      typeof s !== "object" ||
      s === null ||
      typeof (s as { slug?: unknown }).slug !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function coerceAudioClips(value: unknown): TimelineConfig["audio"] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const out: NonNullable<TimelineConfig["audio"]> = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const clip = raw as {
      id?: unknown;
      slug?: unknown;
      startFrame?: unknown;
      durationFrames?: unknown;
      volume?: unknown;
      fadeIn?: unknown;
      fadeOut?: unknown;
    };
    if (
      typeof clip.id !== "string" ||
      typeof clip.slug !== "string" ||
      typeof clip.startFrame !== "number" ||
      typeof clip.durationFrames !== "number"
    ) {
      return null;
    }
    const next: NonNullable<TimelineConfig["audio"]>[number] = {
      id: clip.id,
      slug: clip.slug,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
    };
    if (typeof clip.volume === "number") next.volume = clip.volume;
    if (typeof clip.fadeIn === "number") next.fadeIn = clip.fadeIn;
    if (typeof clip.fadeOut === "number") next.fadeOut = clip.fadeOut;
    out.push(next);
  }
  return out;
}

/**
 * Coerce both legacy shapes into a canonical TimelineConfig:
 *   - bare array of slots                → { slots: data, render: 'landscape' }
 *   - { slots, render }                  → as-is
 *   - anything else (test fixtures etc.) → null (caller falls through to
 *     the plain sidecar write path, AND we clear the SQLite row so reads
 *     do not return a stale default).
 */
function coerceTimelineConfig(value: unknown): TimelineConfig | null {
  if (Array.isArray(value)) {
    if (!slotsAreValid(value)) return null;
    return { slots: value as TimelineConfig["slots"], render: "landscape" };
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as {
    slots?: unknown;
    render?: unknown;
    currentOrientation?: unknown;
  };
  if (!Array.isArray(obj.slots)) return null;
  if (!slotsAreValid(obj.slots)) return null;
  const render =
    obj.render === "landscape" ||
    obj.render === "portrait" ||
    obj.render === "square"
      ? obj.render
      : "landscape";
  const config: TimelineConfig = {
    slots: obj.slots as TimelineConfig["slots"],
    render,
  };
  if (
    obj.currentOrientation === "landscape" ||
    obj.currentOrientation === "portrait" ||
    obj.currentOrientation === "square" ||
    obj.currentOrientation === "original"
  ) {
    config.currentOrientation = obj.currentOrientation;
  }
  const rawAudio = (obj as { audio?: unknown }).audio;
  if (rawAudio !== undefined) {
    const coercedAudio = coerceAudioClips(rawAudio);
    if (coercedAudio === null) return null;
    if (coercedAudio !== undefined && coercedAudio.length > 0) {
      config.audio = coercedAudio;
    }
  }
  return config;
}

async function writeTimelineToSqlite(
  projectDir: string,
  config: TimelineConfig,
  json: string,
  filePath: string,
  gitPath: string | undefined,
): Promise<void> {
  await withGitLock(projectDir, async () => {
    const result = await runOperation(projectDir, {
      intent: "write_project_meta",
      scope: "project",
      target: TIMELINE_KEY,
      subject: `set timeline (${config.slots.length} slot(s), ${config.render})`,
      work: (ctx) => {
        writeTimeline(ctx.metadataDb, config);
        ctx.appendEvent({
          subjectType: "timeline",
          subjectId: "timeline",
          kind: "metadata_changed",
          detail: { slotCount: config.slots.length, render: config.render },
        });
      },
      exports: [
        { path: "asset_events.json", rebuild: (db) => exportAssetEvents(db) },
        { path: "timeline.json", rebuild: (db) => exportTimeline(db) },
      ],
    });

    await fs.writeFile(filePath, json);
    const hash = await commitAndFinalizeOperation(projectDir, result, {
      operation: "write",
      details: { file: metadataFilename(TIMELINE_KEY) },
      gitPath,
      paths: [metadataFilename(TIMELINE_KEY)],
    });
    if (!hash) throw new Error("Failed to commit timeline metadata");
  });
}

export async function writeProjectMeta(
  projectDir: string,
  key: string,
  data: unknown,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  let json: string;
  try {
    json = JSON.stringify(data, null, 2);
  } catch (error: unknown) {
    return invalidInput(
      `Cannot serialize metadata: ${(error as Error).message}`,
    );
  }

  const filename = metadataFilename(key);
  const filePath = path.join(projectDir, filename);

  if (key === TIMELINE_KEY) {
    const coerced = coerceTimelineConfig(data);
    if (coerced) {
      try {
        await writeTimelineToSqlite(
          projectDir,
          coerced,
          json,
          filePath,
          gitPath,
        );
      } catch (error: unknown) {
        return err({
          code: "IO_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return ok(filePath);
    }
    // Non-conforming payload — drop any SQLite timeline row so reads fall
    // back to the sidecar, and continue to the legacy sidecar write below.
    try {
      const db = getMetadataDb(projectDir);
      db.prepare("DELETE FROM timeline").run();
      db.prepare("DELETE FROM timeline_slots").run();
      try {
        db.prepare("DELETE FROM timeline_audio").run();
      } catch {
        // table missing on legacy projects pre-migration 3
      }
    } catch {
      // ignore — DB not initialized yet
    }
  }

  await withGitLock(projectDir, async () => {
    return withCleanWorktree(
      projectDir,
      async () => {
        await fs.writeFile(filePath, json);
        await commitOperation(
          projectDir,
          "write",
          filename,
          undefined,
          gitPath,
        );
      },
      gitPath,
    );
  });

  return ok(filePath);
}

export async function readProjectMeta<T>(
  projectDir: string,
  key: string,
): Promise<Result<T, FsError>> {
  const keyErr = validateKey(key);
  if (keyErr) return keyErr;

  // Timeline reads from SQLite when present; falls back to sidecar otherwise
  // so unmigrated projects keep working. We check that .clipfirst/ exists
  // on disk first to avoid resurrecting a stale cached connection for a
  // project whose metadata DB was deleted (legacy fallback or rollback).
  if (key === TIMELINE_KEY) {
    try {
      const probe = await fs.stat(
        path.join(projectDir, ".clipfirst", "metadata.sqlite"),
      );
      if (probe.isFile()) {
        const db = getMetadataDb(projectDir);
        const timeline = readTimeline(db);
        if (timeline) return ok(timeline as unknown as T);
      }
    } catch {
      // fall through to sidecar
    }
  }

  const filePath = path.join(projectDir, metadataFilename(key));

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (error: unknown) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return err({
        code: "NOT_FOUND",
        message: `Project metadata not found: ${key}`,
      });
    }
    return err({ code: "IO_ERROR", message: e.message });
  }

  try {
    const parsed = JSON.parse(data.toString()) as T;
    return ok(parsed);
  } catch {
    return err({
      code: "IO_ERROR",
      message: `Invalid JSON in project metadata: ${key}`,
    });
  }
}
