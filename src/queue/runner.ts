import { dequeue, heartbeat, DEFAULT_LEASE_DURATION_MS } from "./dequeue.js";
import { complete, fail } from "./complete.js";
import { reapStaleLeases } from "./reaper.js";
import { type Job, type JobError, type JobHandler } from "./types.js";

import type { Database as DatabaseType } from "better-sqlite3";

export interface RunnerConfig {
  /** Concurrent in-flight jobs across this runner. */
  concurrency: number;
  /** How long a leased job has to heartbeat before the reaper considers it stale. */
  leaseMs?: number;
  /** Polling interval for the queued state (ms) when the queue is empty. */
  pollIntervalMs?: number;
  /** Reaper sweep interval. */
  reapIntervalMs?: number;
  /** Resolve handler for a job; return null to mark as failed-with-no-handler. */
  resolveHandler: (type: string) => JobHandler | null;
}

interface ActiveJob {
  job: Job;
  heartbeatTimer: NodeJS.Timeout;
}

/**
 * One worker pulls jobs from `pending_jobs` and dispatches them to registered
 * handlers. Multiple workers (across processes) coordinate via the SQLite-backed
 * lease — the runner does not assume single-process ownership of the queue.
 */
export class QueueRunner {
  private readonly db: DatabaseType;
  private readonly config: Required<Omit<RunnerConfig, "resolveHandler">> & {
    resolveHandler: (type: string) => JobHandler | null;
  };
  private active = new Set<ActiveJob>();
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(db: DatabaseType, config: RunnerConfig) {
    this.db = db;
    this.config = {
      concurrency: config.concurrency,
      leaseMs: config.leaseMs ?? DEFAULT_LEASE_DURATION_MS,
      pollIntervalMs: config.pollIntervalMs ?? 250,
      reapIntervalMs: config.reapIntervalMs ?? 5_000,
      resolveHandler: config.resolveHandler,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll(0);
    this.reapTimer = setInterval(() => {
      try {
        reapStaleLeases(this.db);
      } catch {
        // Tolerate transient db errors; the next sweep retries.
      }
    }, this.config.reapIntervalMs);
    this.reapTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    // Await all active jobs
    while (this.active.size > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Block until job `id` reaches a terminal state. Throws on failure. */
  async waitFor(id: number, timeoutMs = 300_000): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = this.db
        .prepare(`SELECT state, result, error FROM pending_jobs WHERE id = ?`)
        .get(id) as
        | { state: string; result: string | null; error: string | null }
        | undefined;
      if (!row) throw new Error(`Job ${id} not found`);
      if (row.state === "done") {
        if (row.result == null) return null;
        try {
          return JSON.parse(row.result);
        } catch {
          throw new Error(`Job ${id} done but result column is corrupt JSON`);
        }
      }
      if (row.state === "failed" || row.state === "aborted") {
        let error: JobError = { message: "unknown error" };
        if (row.error) {
          try {
            error = JSON.parse(row.error) as JobError;
          } catch {
            error = { message: row.error };
          }
        }
        throw new Error(`Job ${id} ${row.state}: ${error.message}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Job ${id} timed out after ${timeoutMs}ms`);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pump();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private pump(): void {
    if (!this.running) return;
    while (this.active.size < this.config.concurrency) {
      const job = dequeue(this.db, process.pid, this.config.leaseMs);
      if (!job) break;
      this.run(job);
    }
    this.scheduleNextPoll(this.config.pollIntervalMs);
  }

  private run(job: Job): void {
    const heartbeatTimer = setInterval(
      () => {
        try {
          heartbeat(this.db, job.id, this.config.leaseMs);
        } catch {
          // Tolerate transient db errors; a missed beat is covered by the lease.
        }
      },
      Math.max(1_000, Math.floor(this.config.leaseMs / 3)),
    );
    heartbeatTimer.unref?.();

    const active: ActiveJob = { job, heartbeatTimer };
    this.active.add(active);

    void this.dispatch(job)
      .then((result) => {
        complete(this.db, job.id, { result });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error ? error.name : undefined;
        try {
          fail(this.db, job.id, {
            error: { message, ...(code ? { code } : {}) },
          });
        } catch {
          // Terminal-state write failed (e.g. db closed during stop) — the
          // lease reaper will reclaim the job. Swallow so the rejection never
          // escapes this void chain as an unhandledRejection.
        }
      })
      .finally(() => {
        clearInterval(heartbeatTimer);
        this.active.delete(active);
        // Wake the loop in case capacity opened
        this.scheduleNextPoll(0);
      });
  }

  private async dispatch(job: Job): Promise<unknown> {
    const handler = this.config.resolveHandler(job.type);
    if (!handler) {
      throw new Error(`No handler for job type: ${job.type}`);
    }
    return handler(job);
  }
}
