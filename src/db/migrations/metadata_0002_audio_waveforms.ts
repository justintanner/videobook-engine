import type { Database } from "better-sqlite3";

export const version = 2;
export const name = "metadata_audio_waveforms";

/**
 * Promotes audio waveform peaks from a per-asset waveform.json sidecar into
 * SQLite + a per-asset canonical export.
 *
 * peaks_json: JSON-encoded number[] (already-normalized peak bins from ffmpeg).
 * bar_count:  number of bins (== peaks.length); kept as a column for cheap
 *             "do we have data?" checks without parsing JSON.
 * No sample_rate: the extractor returns normalized peaks, not raw samples,
 *                 so a sample_rate field would be misleading.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_waveforms (
      asset_id     TEXT PRIMARY KEY,
      peaks_json   TEXT NOT NULL,
      bar_count    INTEGER NOT NULL,
      generated_at INTEGER NOT NULL
    );
  `);
}
