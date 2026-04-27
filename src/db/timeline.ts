import type { Database as DatabaseType } from "better-sqlite3";

import { canonicalJson } from "./canonical-json.js";

export type Orientation = "landscape" | "portrait" | "square";
export type ViewerOrientation = Orientation | "original";

export interface TimelineSlot {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
}

export interface TimelineAudioClip {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface TimelineConfig {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerOrientation;
}

const DEFAULT_RENDER: Orientation = "landscape";

interface TimelineRow {
  render: Orientation;
  current_orientation: ViewerOrientation | null;
}

interface SlotRow {
  position: number;
  asset_id: string;
  volume: number | null;
  audio_fade_in: number | null;
  audio_fade_out: number | null;
}

interface AudioRow {
  id: string;
  asset_id: string;
  start_frame: number;
  duration_frames: number;
  volume: number | null;
  fade_in: number | null;
  fade_out: number | null;
  ordinal: number;
}

function isOrientation(value: unknown): value is Orientation {
  return value === "landscape" || value === "portrait" || value === "square";
}

function isViewerOrientation(value: unknown): value is ViewerOrientation {
  return isOrientation(value) || value === "original";
}

function timelineAudioTableExists(db: DatabaseType): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='timeline_audio'",
      )
      .get(),
  );
}

export function readTimeline(db: DatabaseType): TimelineConfig | null {
  const row = db
    .prepare(`SELECT render, current_orientation FROM timeline WHERE id = 1`)
    .get() as TimelineRow | undefined;
  if (!row) return null;
  const slots = (db
    .prepare(
      `SELECT position, asset_id, volume, audio_fade_in, audio_fade_out
       FROM timeline_slots ORDER BY position`,
    )
    .all() as SlotRow[]).map(slotRowToObject);

  const audio = timelineAudioTableExists(db)
    ? (db
        .prepare(
          `SELECT id, asset_id, start_frame, duration_frames, volume, fade_in, fade_out, ordinal
           FROM timeline_audio ORDER BY ordinal`,
        )
        .all() as AudioRow[]).map(audioRowToObject)
    : [];

  return {
    render: row.render,
    ...(row.current_orientation
      ? { currentOrientation: row.current_orientation }
      : {}),
    slots,
    ...(audio.length > 0 ? { audio } : {}),
  };
}

function slotRowToObject(row: SlotRow): TimelineSlot {
  const out: TimelineSlot = { slug: row.asset_id };
  if (row.volume != null) out.volume = row.volume;
  if (row.audio_fade_in != null) out.audioFadeIn = row.audio_fade_in;
  if (row.audio_fade_out != null) out.audioFadeOut = row.audio_fade_out;
  return out;
}

function audioRowToObject(row: AudioRow): TimelineAudioClip {
  const out: TimelineAudioClip = {
    id: row.id,
    slug: row.asset_id,
    startFrame: row.start_frame,
    durationFrames: row.duration_frames,
  };
  if (row.volume != null) out.volume = row.volume;
  if (row.fade_in != null) out.fadeIn = row.fade_in;
  if (row.fade_out != null) out.fadeOut = row.fade_out;
  return out;
}

export function writeTimeline(db: DatabaseType, config: TimelineConfig): void {
  const render = isOrientation(config.render) ? config.render : DEFAULT_RENDER;
  const currentOrientation = isViewerOrientation(config.currentOrientation)
    ? config.currentOrientation
    : null;

  db.prepare(
    `INSERT INTO timeline (id, render, current_orientation)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       render = excluded.render,
       current_orientation = excluded.current_orientation`,
  ).run(render, currentOrientation);

  db.prepare("DELETE FROM timeline_slots").run();
  const insert = db.prepare(
    `INSERT INTO timeline_slots
     (position, asset_id, volume, audio_fade_in, audio_fade_out)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < config.slots.length; i++) {
    const slot = config.slots[i]!;
    insert.run(
      i,
      slot.slug,
      typeof slot.volume === "number" ? slot.volume : null,
      typeof slot.audioFadeIn === "number" ? slot.audioFadeIn : null,
      typeof slot.audioFadeOut === "number" ? slot.audioFadeOut : null,
    );
  }

  if (timelineAudioTableExists(db)) {
    db.prepare("DELETE FROM timeline_audio").run();
    const insertAudio = db.prepare(
      `INSERT INTO timeline_audio
       (id, asset_id, start_frame, duration_frames, volume, fade_in, fade_out, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const clips = config.audio ?? [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!;
      insertAudio.run(
        clip.id,
        clip.slug,
        clip.startFrame,
        clip.durationFrames,
        typeof clip.volume === "number" ? clip.volume : null,
        typeof clip.fadeIn === "number" ? clip.fadeIn : null,
        typeof clip.fadeOut === "number" ? clip.fadeOut : null,
        i,
      );
    }
  }
}

export function exportTimeline(db: DatabaseType): string {
  const t = readTimeline(db) ?? {
    render: DEFAULT_RENDER,
    slots: [],
  };
  return canonicalJson(t);
}
