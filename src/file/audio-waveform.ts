import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type FsError, type Result, ok, err } from "../types.js";
import { invalidInput, isValidAssetId } from "../validation.js";
import { resolveAssetDir } from "./resolve.js";
import {
  audioWaveformExportPath,
  exportAudioWaveform,
  readAudioWaveform,
  writeAudioWaveformRow,
  type AudioWaveformRecord,
} from "../db/audio-waveforms.js";
import { exportAssetEvents } from "../db/asset-events.js";
import {
  commitAndFinalizeOperation,
  runOperation,
} from "../db/run-operation.js";
import { withGitLock } from "../git/mutex.js";
import { getMetadataDb } from "../db/metadata-client.js";
import { VIDEOCITY_DIR } from "../db/client.js";

async function metadataDbExists(projectDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(
      path.join(projectDir, VIDEOCITY_DIR, "metadata.sqlite"),
    );
    return stat.isFile();
  } catch {
    return false;
  }
}

function validatePeaks(peaks: unknown): Result<never, FsError> | null {
  if (!Array.isArray(peaks)) {
    return invalidInput("Waveform peaks must be a number[]");
  }
  for (const p of peaks) {
    if (typeof p !== "number" || !Number.isFinite(p)) {
      return invalidInput("Waveform peaks must be finite numbers");
    }
  }
  return null;
}

export async function writeAudioWaveform(
  projectDir: string,
  assetId: string,
  peaks: number[],
  gitPath?: string,
): Promise<Result<string, FsError>> {
  if (!isValidAssetId(assetId)) {
    return invalidInput(`Invalid asset id: ${assetId}`);
  }
  const peaksErr = validatePeaks(peaks);
  if (peaksErr) return peaksErr;

  const assetDirResult = await resolveAssetDir(projectDir, assetId);
  if (!assetDirResult.ok) return assetDirResult;

  const exportRel = audioWaveformExportPath(assetId);
  const generatedAt = Date.now();

  try {
    await withGitLock(projectDir, async () => {
      const result = await runOperation(projectDir, {
        intent: "write_audio_waveform",
        scope: "asset",
        target: assetId,
        subject: `update audio waveform ${assetId}`,
        work: (ctx) => {
          writeAudioWaveformRow(ctx.metadataDb, assetId, peaks, generatedAt);
          ctx.appendEvent({
            subjectType: "asset",
            subjectId: assetId,
            kind: "audio_waveform_changed",
            detail: { bar_count: peaks.length },
          });
        },
        exports: [
          { path: "asset_events.json", rebuild: (db) => exportAssetEvents(db) },
          { path: exportRel, rebuild: (db) => exportAudioWaveform(db, assetId) },
        ],
      });
      // commitAndFinalizeOperation returns null when git status is clean —
      // i.e. the waveform sqlite row + export file produced no on-disk diff
      // (already at HEAD). The data is still persisted via runOperation's
      // sqlite write + export write, so a no-op commit is benign, not fatal.
      await commitAndFinalizeOperation(projectDir, result, {
        operation: "write_audio_waveform",
        assetId,
        details: { bar_count: peaks.length },
        gitPath,
      });
    });
  } catch (error: unknown) {
    return err({
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return ok(exportRel);
}

export async function readAudioWaveformRecord(
  projectDir: string,
  assetId: string,
): Promise<Result<AudioWaveformRecord, FsError>> {
  if (!isValidAssetId(assetId)) {
    return invalidInput(`Invalid asset id: ${assetId}`);
  }
  const assetDirResult = await resolveAssetDir(projectDir, assetId);
  if (!assetDirResult.ok) return assetDirResult;

  if (!(await metadataDbExists(projectDir))) {
    return err({
      code: "NOT_FOUND",
      message: `No audio waveform for asset: ${assetId}`,
    });
  }
  const db = getMetadataDb(projectDir);
  const record = readAudioWaveform(db, assetId);
  if (!record) {
    return err({
      code: "NOT_FOUND",
      message: `No audio waveform for asset: ${assetId}`,
    });
  }
  return ok(record);
}
