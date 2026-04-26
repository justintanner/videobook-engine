import * as fs from "node:fs";
import * as path from "node:path";

import Database, { type Database as DatabaseType } from "better-sqlite3";

import { migrateState } from "./migrate.js";
import { closeAllMetadataDbs, closeMetadataDb } from "./metadata-client.js";

export const CLIPFIRST_DIR = ".clipfirst";
export const STATE_DB_FILENAME = "state.sqlite";

const cache = new Map<string, DatabaseType>();

function clipfirstDir(projectDir: string): string {
  return path.join(projectDir, CLIPFIRST_DIR);
}

export function stateDbPath(projectDir: string): string {
  return path.join(clipfirstDir(projectDir), STATE_DB_FILENAME);
}

function ensureClipfirstDir(projectDir: string): void {
  fs.mkdirSync(clipfirstDir(projectDir), { recursive: true });
}

function configurePragmas(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function openState(projectDir: string): DatabaseType {
  ensureClipfirstDir(projectDir);
  const db = new Database(stateDbPath(projectDir));
  configurePragmas(db);
  migrateState(db);
  return db;
}

export function getStateDb(projectDir: string): DatabaseType {
  const key = path.resolve(projectDir);
  const cached = cache.get(key);
  if (cached && cached.open) return cached;
  const db = openState(key);
  cache.set(key, db);
  return db;
}

export function closeStateDb(projectDir: string): void {
  const key = path.resolve(projectDir);
  const db = cache.get(key);
  if (db && db.open) db.close();
  cache.delete(key);
  closeMetadataDb(key);
}

export function closeAllStateDbs(): void {
  for (const [, db] of cache) {
    if (db.open) db.close();
  }
  cache.clear();
  closeAllMetadataDbs();
}

export function purgeStateCacheForTesting(): void {
  closeAllStateDbs();
}
