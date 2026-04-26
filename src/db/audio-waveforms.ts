import type { Database as DatabaseType } from "better-sqlite3";

import { canonicalJson } from "./canonical-json.js";

export interface AudioWaveformRecord {
  peaks: number[];
  bar_count: number;
  generated_at: number;
}

interface WaveformRow {
  asset_id: string;
  peaks_json: string;
  bar_count: number;
  generated_at: number;
}

export function readAudioWaveform(
  db: DatabaseType,
  assetId: string,
): AudioWaveformRecord | null {
  const row = db
    .prepare(
      `SELECT asset_id, peaks_json, bar_count, generated_at
       FROM audio_waveforms WHERE asset_id = ?`,
    )
    .get(assetId) as WaveformRow | undefined;
  if (!row) return null;
  let peaks: number[];
  try {
    const parsed = JSON.parse(row.peaks_json) as unknown;
    if (!Array.isArray(parsed)) return null;
    peaks = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    return null;
  }
  return {
    peaks,
    bar_count: row.bar_count,
    generated_at: row.generated_at,
  };
}

export function writeAudioWaveformRow(
  db: DatabaseType,
  assetId: string,
  peaks: number[],
  generatedAt: number,
): void {
  db.prepare(
    `INSERT INTO audio_waveforms (asset_id, peaks_json, bar_count, generated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET
       peaks_json   = excluded.peaks_json,
       bar_count    = excluded.bar_count,
       generated_at = excluded.generated_at`,
  ).run(assetId, JSON.stringify(peaks), peaks.length, generatedAt);
}

export function deleteAudioWaveformRow(
  db: DatabaseType,
  assetId: string,
): void {
  db.prepare("DELETE FROM audio_waveforms WHERE asset_id = ?").run(assetId);
}

export function listAudioWaveformAssetIds(db: DatabaseType): string[] {
  const rows = db
    .prepare("SELECT asset_id FROM audio_waveforms ORDER BY asset_id")
    .all() as Array<{ asset_id: string }>;
  return rows.map((r) => r.asset_id);
}

export function exportAudioWaveform(
  db: DatabaseType,
  assetId: string,
): string {
  const record = readAudioWaveform(db, assetId);
  if (!record) return canonicalJson({ asset_id: assetId, peaks: [], bar_count: 0, generated_at: 0 });
  return canonicalJson({
    asset_id: assetId,
    peaks: record.peaks,
    bar_count: record.bar_count,
    generated_at: record.generated_at,
  });
}

export function audioWaveformExportPath(assetId: string): string {
  return `audio_waveforms/${assetId}.json`;
}
