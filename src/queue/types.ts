import type { AssetWorkKind } from "../asset/work.js";

export type JobState =
  | "queued"
  | "running"
  | "completing"
  | "done"
  | "failed"
  | "aborted";

export interface JobError {
  message: string;
  code?: string;
}

export interface JobRow {
  id: number;
  operation_id: string;
  type: string;
  asset_id: string | null;
  external_task_id: string | null;
  state: JobState;
  payload: string;
  result: string | null;
  dedupe_key: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  pid: number | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  error: string | null;
}

export interface Job {
  id: number;
  operationId: string;
  type: string;
  assetId: string | null;
  externalTaskId: string | null;
  state: JobState;
  payload: Record<string, unknown>;
  result: unknown;
  attempts: number;
  maxAttempts: number;
  error: JobError | null;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface EnqueueOptions {
  type: string;
  assetId?: string | null;
  externalTaskId?: string | null;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  /** When provided, overrides the auto-derived dedupe key. Pass null to disable dedupe. */
  dedupeKey?: string | null;
  /** When `external_task_id` is set, the job starts in 'running' state ready for the next poll. */
  initialState?: "queued" | "running";
  /** Clean AssetWorkKind to write into assets.meta.kind at enqueue time so
   *  computeAssetStatus can derive the right in-progress UI state during the
   *  window between enqueue and worker pickup. Server callers populate this
   *  from a job-type→kind classifier; null leaves meta.kind unset. */
  assetWorkKind?: AssetWorkKind | null;
  /** Optional orientation for render jobs — drives render-queued-{landscape,portrait,square}. */
  assetWorkOrientation?: "portrait" | "landscape" | "square" | null;
}

export interface EnqueueResult {
  /** True for fresh inserts; false when an existing row matched dedupe/external constraint. */
  inserted: boolean;
  job: Job;
}

export interface CompleteOptions {
  result?: unknown;
}

export interface FailOptions {
  error: JobError;
  /** If true (default), retry until attempts >= maxAttempts; otherwise fail terminally. */
  allowRetry?: boolean;
}

export type JobHandler = (job: Job) => Promise<unknown>;
