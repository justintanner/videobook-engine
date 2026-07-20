import { getStateDb } from "../db/client.js";

import { enqueue, getJob, findJobByExternal } from "./enqueue.js";
import { dequeue, heartbeat } from "./dequeue.js";
import { complete, fail, abort, markCompleting } from "./complete.js";
import { listJobs, countJobs, type ListOptions } from "./list.js";
import { reapStaleLeases, reapOnStartup, listLeasedRows } from "./reaper.js";
import { reconcileFromSidecars, type ReconcileOptions } from "./reconcile.js";
import { QueueRunner, type RunnerConfig } from "./runner.js";
import {
  type CompleteOptions,
  type EnqueueOptions,
  type EnqueueResult,
  type FailOptions,
  type Job,
  type JobHandler,
} from "./types.js";

export type {
  EnqueueOptions,
  EnqueueResult,
  CompleteOptions,
  FailOptions,
  Job,
  JobHandler,
  JobState,
} from "./types.js";
export type { ListOptions } from "./list.js";
export type { ReconcileOptions } from "./reconcile.js";
export type { RunnerConfig } from "./runner.js";
export { canonicalize, dedupeKey } from "./canonicalize.js";
export { QueueRunner } from "./runner.js";

export interface QueueApi {
  enqueue(projectDir: string, opts: EnqueueOptions): EnqueueResult;
  getJob(projectDir: string, id: number): Job | null;
  findByExternal(
    projectDir: string,
    type: string,
    externalTaskId: string,
  ): Job | null;
  list(projectDir: string, opts?: ListOptions): Job[];
  count(projectDir: string, opts?: ListOptions): number;
  complete(projectDir: string, id: number, opts?: CompleteOptions): void;
  fail(projectDir: string, id: number, opts: FailOptions): void;
  abort(projectDir: string, id: number, reason: string): void;
  markCompleting(projectDir: string, id: number): void;
  dequeue(projectDir: string): Job | null;
  heartbeat(projectDir: string, id: number): boolean;
  reap(projectDir: string): ReturnType<typeof reapStaleLeases>;
  reapOnStartup(projectDir: string): ReturnType<typeof reapOnStartup>;
  listLeased(projectDir: string): ReturnType<typeof listLeasedRows>;
  reconcileFromSidecars(
    projectDir: string,
    opts?: ReconcileOptions,
  ): Promise<Awaited<ReturnType<typeof reconcileFromSidecars>>>;
  createRunner(projectDir: string, config: RunnerConfig): QueueRunner;
}

export const queueApi: QueueApi = {
  enqueue: (projectDir, opts) => enqueue(getStateDb(projectDir), opts),
  getJob: (projectDir, id) => getJob(getStateDb(projectDir), id),
  findByExternal: (projectDir, type, externalTaskId) =>
    findJobByExternal(getStateDb(projectDir), type, externalTaskId),
  list: (projectDir, opts) => listJobs(getStateDb(projectDir), opts),
  count: (projectDir, opts) => countJobs(getStateDb(projectDir), opts),
  complete: (projectDir, id, opts) => complete(getStateDb(projectDir), id, opts),
  fail: (projectDir, id, opts) => fail(getStateDb(projectDir), id, opts),
  abort: (projectDir, id, reason) => abort(getStateDb(projectDir), id, reason),
  markCompleting: (projectDir, id) =>
    markCompleting(getStateDb(projectDir), id),
  dequeue: (projectDir) => dequeue(getStateDb(projectDir)),
  heartbeat: (projectDir, id) => heartbeat(getStateDb(projectDir), id),
  reap: (projectDir) => reapStaleLeases(getStateDb(projectDir)),
  reapOnStartup: (projectDir) => reapOnStartup(getStateDb(projectDir)),
  listLeased: (projectDir) => listLeasedRows(getStateDb(projectDir)),
  reconcileFromSidecars: (projectDir, opts) =>
    reconcileFromSidecars(getStateDb(projectDir), projectDir, opts),
  createRunner: (projectDir, config) =>
    new QueueRunner(getStateDb(projectDir), config),
};
