import type { Database as DatabaseType } from "better-sqlite3";

import { canonicalJson } from "./canonical-json.js";

const PIN_SLOTS = ["wardrobe", "poses", "outfits", "backdrop"] as const;
type PinSlot = (typeof PIN_SLOTS)[number];

const STORED_PIN_SLOTS = ["wardrobe", "poses", "outfits"] as const;
type StoredPinSlot = (typeof STORED_PIN_SLOTS)[number];

function isStoredSlot(slot: string): slot is StoredPinSlot {
  return slot === "wardrobe" || slot === "poses" || slot === "outfits";
}

function isPinSlot(slot: string): slot is PinSlot {
  return PIN_SLOTS.includes(slot as PinSlot);
}

interface CharacterRow {
  asset_id: string;
  raw_json: string | null;
}

interface PinRow {
  character_id: string;
  slot: StoredPinSlot;
  position: number;
  asset_id: string;
}

export interface CharacterRecord {
  // Free-form metadata blob plus pin slots. Pin arrays are sourced from the
  // canonical `character_pins` table on read; there is no separate pin-read
  // API. Writes strip pins from raw_json before storing so the table is the
  // single source of truth.
  [key: string]: unknown;
  wardrobe?: string[];
  poses?: string[];
  outfits?: string[];
  backdrop?: string[];
}

function pinsForSlot(record: CharacterRecord, slot: PinSlot): string[] {
  const value = record[slot];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export function writeCharacter(
  db: DatabaseType,
  charAssetId: string,
  record: CharacterRecord,
): void {
  // Strip embedded pin arrays from the row blob — the canonical source for
  // those is character_pins. Keeping them in raw_json would let a stale
  // mirror drift from the table.
  const blob: Record<string, unknown> = { ...record };
  for (const slot of STORED_PIN_SLOTS) delete blob[slot];

  db.prepare(
    `INSERT INTO characters (asset_id, raw_json)
     VALUES (?, ?)
     ON CONFLICT(asset_id) DO UPDATE SET raw_json = excluded.raw_json`,
  ).run(charAssetId, JSON.stringify(blob));

  // Backdrop is a separate concept (single-asset, non-array); skip it from
  // the pin table for now (its constraint excludes it). Phase 4 may promote
  // backdrop into its own column.
  db.prepare("DELETE FROM character_pins WHERE character_id = ?").run(
    charAssetId,
  );
  const insert = db.prepare(
    `INSERT INTO character_pins (character_id, slot, position, asset_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const slot of STORED_PIN_SLOTS) {
    const pins = pinsForSlot(record, slot);
    for (let i = 0; i < pins.length; i++) {
      insert.run(charAssetId, slot, i, pins[i]);
    }
  }
}

export function readCharacter(
  db: DatabaseType,
  charAssetId: string,
): CharacterRecord | null {
  const row = db
    .prepare(`SELECT asset_id, raw_json FROM characters WHERE asset_id = ?`)
    .get(charAssetId) as CharacterRow | undefined;
  if (!row) return null;
  let base: CharacterRecord = {};
  if (row.raw_json) {
    try {
      base = JSON.parse(row.raw_json) as CharacterRecord;
    } catch {
      base = {};
    }
  }
  const pins = db
    .prepare(
      `SELECT character_id, slot, position, asset_id
       FROM character_pins WHERE character_id = ? ORDER BY slot, position`,
    )
    .all(charAssetId) as PinRow[];
  const groups: Record<StoredPinSlot, string[]> = {
    wardrobe: [],
    poses: [],
    outfits: [],
  };
  for (const p of pins) {
    if (isStoredSlot(p.slot)) groups[p.slot].push(p.asset_id);
  }
  const out: CharacterRecord = { ...base };
  for (const slot of STORED_PIN_SLOTS) out[slot] = groups[slot];
  return out;
}

export function deleteCharacter(db: DatabaseType, charAssetId: string): void {
  db.prepare("DELETE FROM character_pins WHERE character_id = ?").run(
    charAssetId,
  );
  db.prepare("DELETE FROM characters WHERE asset_id = ?").run(charAssetId);
}

interface ExportedCharacter {
  asset_id: string;
  raw: unknown;
}

interface ExportedPin {
  character_id: string;
  slot: StoredPinSlot;
  position: number;
  asset_id: string;
}

export function exportCharacters(db: DatabaseType): string {
  const rows = db
    .prepare(`SELECT asset_id, raw_json FROM characters ORDER BY asset_id`)
    .all() as CharacterRow[];
  const out: ExportedCharacter[] = rows.map((r) => ({
    asset_id: r.asset_id,
    raw: r.raw_json ? safeParse(r.raw_json) : null,
  }));
  return canonicalJson(out);
}

export function exportCharacterPins(db: DatabaseType): string {
  const rows = db
    .prepare(
      `SELECT character_id, slot, position, asset_id
       FROM character_pins ORDER BY character_id, slot, position`,
    )
    .all() as PinRow[];
  const out: ExportedPin[] = rows.map((r) => ({
    character_id: r.character_id,
    slot: r.slot,
    position: r.position,
    asset_id: r.asset_id,
  }));
  return canonicalJson(out);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export { isPinSlot };
