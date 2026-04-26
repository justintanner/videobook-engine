import type { Database as DatabaseType } from "better-sqlite3";

import { rowToJob } from "./row.js";
import { type Job, type JobRow, type JobState } from "./types.js";

export interface ListOptions {
  states?: ReadonlyArray<JobState>;
  type?: string;
  assetId?: string;
  limit?: number;
}

export function listJobs(db: DatabaseType, opts: ListOptions = {}): Job[] {
  const wheres: string[] = [];
  const params: unknown[] = [];

  if (opts.states && opts.states.length > 0) {
    wheres.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    params.push(...opts.states);
  }
  if (opts.type) {
    wheres.push(`type = ?`);
    params.push(opts.type);
  }
  if (opts.assetId) {
    wheres.push(`asset_id = ?`);
    params.push(opts.assetId);
  }

  const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof opts.limit === "number" ? `LIMIT ${opts.limit}` : "";
  const sql = `SELECT * FROM pending_jobs ${where} ORDER BY enqueued_at, id ${limit}`;
  const rows = db.prepare(sql).all(...params) as JobRow[];
  return rows.map(rowToJob);
}

export function countJobs(db: DatabaseType, opts: ListOptions = {}): number {
  const wheres: string[] = [];
  const params: unknown[] = [];
  if (opts.states && opts.states.length > 0) {
    wheres.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    params.push(...opts.states);
  }
  if (opts.type) {
    wheres.push(`type = ?`);
    params.push(opts.type);
  }
  if (opts.assetId) {
    wheres.push(`asset_id = ?`);
    params.push(opts.assetId);
  }
  const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const sql = `SELECT COUNT(*) AS n FROM pending_jobs ${where}`;
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}
