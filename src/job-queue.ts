import { v7 as uuidv7 } from "uuid";

import type {
  CompleteOptions,
  EnqueueOptions,
  EnqueueResult,
  FailOptions,
  Job,
  JobError,
  JobHandler,
  JobState,
  ListJobsOptions,
  RunnerConfig,
} from "./engine-types.js";
import type { DoltStore } from "./store.js";
import { canonicalJson, parseJson } from "./store.js";

interface JobRow {
  id: number;
  operation_id: string;
  project_id: string;
  type: string;
  artifact_id: string | null;
  external_task_id: string | null;
  state: JobState;
  payload_json: string;
  result_json: string | null;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  error_json: string | null;
  fence: number;
}

export class JobQueue {
  constructor(
    private readonly store: DoltStore,
    private readonly resolveProjectId: (reference: string) => string,
    private readonly resolveArtifactId: (
      projectId: string,
      reference: string,
    ) => string,
    private readonly recordTerminal: (job: Job) => Promise<void>,
  ) {}

  enqueue(project: string, options: EnqueueOptions): EnqueueResult {
    const projectId = this.resolveProjectId(project);
    const resolvedArtifactId = options.artifactId
      ? this.resolveArtifactId(projectId, options.artifactId)
      : null;
    const operationId = uuidv7();
    const now = Date.now();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    const state = options.initialState ?? "queued";
    const runtimeOptions = options as unknown as Record<
      string,
      unknown
    >;
    const queuedKind =
      typeof runtimeOptions.artifactWorkKind === "string"
        ? runtimeOptions.artifactWorkKind
        : null;
    const queuedOrientation =
      typeof runtimeOptions.artifactWorkOrientation === "string"
        ? runtimeOptions.artifactWorkOrientation
        : null;
    const dedupeKey =
      options.dedupeKey === undefined
        ? canonicalJson({
            projectId,
            type: options.type,
            artifactId: resolvedArtifactId,
            externalTaskId: options.externalTaskId ?? null,
            payload: options.payload,
          })
        : options.dedupeKey;

    return this.store.runtime(() => {
      const inserted = this.store.db
        .prepare(
          `INSERT OR IGNORE INTO runtime_jobs(
            operation_id, project_id, type, artifact_id, external_task_id,
            state, payload_json, dedupe_key, enqueued_at, started_at,
            attempts, max_attempts
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          projectId,
          options.type,
          resolvedArtifactId,
          options.externalTaskId ?? null,
          state,
          canonicalJson(options.payload),
          dedupeKey,
          now,
          state === "running" ? now : null,
          state === "running" ? 1 : 0,
          maxAttempts,
        ).changes;
      const row =
        inserted > 0
          ? this.requiredRowByOperation(operationId)
          : this.findDuplicateRow(
              projectId,
              options.type,
              options.externalTaskId ?? null,
              dedupeKey,
            );
      if (resolvedArtifactId && queuedKind) {
        this.upsertQueuedArtifactView(
          projectId,
          resolvedArtifactId,
          queuedKind,
          queuedOrientation,
          now,
        );
      }
      return { inserted: inserted > 0, job: rowToJob(row) };
    });
  }

  get(project: string, id: number): Job | null {
    const projectId = this.resolveProjectId(project);
    const row = this.store.db
      .prepare(`${JOB_SELECT} WHERE project_id = ? AND id = ?`)
      .get(projectId, id) as unknown as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  findByExternal(
    project: string,
    type: string,
    externalTaskId: string,
  ): Job | null {
    const projectId = this.resolveProjectId(project);
    const row = this.store.db
      .prepare(
        `${JOB_SELECT}
         WHERE project_id = ? AND type = ? AND external_task_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(projectId, type, externalTaskId) as unknown as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  list(project: string, options: ListJobsOptions = {}): Job[] {
    const projectId = this.resolveProjectId(project);
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (options.states && options.states.length > 0) {
      clauses.push(
        `state IN (${options.states.map(() => "?").join(", ")})`,
      );
      params.push(...options.states);
    }
    if (options.type) {
      clauses.push("type = ?");
      params.push(options.type);
    }
    if (options.artifactId) {
      clauses.push("artifact_id = ?");
      params.push(
        this.resolveArtifactId(projectId, options.artifactId),
      );
    }
    params.push(Math.max(1, options.limit ?? 10_000));
    const rows = this.store.db
      .prepare(
        `${JOB_SELECT}
         WHERE ${clauses.join(" AND ")}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params) as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  count(project: string, options: ListJobsOptions = {}): number {
    return this.list(project, options).length;
  }

  dequeue(project: string, pid: number, leaseMs: number): Job | null {
    const projectId = this.resolveProjectId(project);
    return this.store.runtime((now) => {
      const candidate = this.store.db
        .prepare(
          `SELECT id
           FROM runtime_jobs
           WHERE project_id = ? AND state = 'queued'
           ORDER BY enqueued_at, id
           LIMIT 1`,
        )
        .get(projectId) as unknown as { id: number } | undefined;
      if (!candidate) return null;
      const changed = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET state='running',
               started_at=COALESCE(started_at, ?),
               pid=?,
               lease_expires_at=?,
               attempts=attempts+1,
               fence=fence+1
           WHERE id=? AND state='queued'`,
        )
        .run(now, pid, now + leaseMs, candidate.id).changes;
      if (changed === 0) return null;
      return rowToJob(this.requiredRow(candidate.id));
    });
  }

  heartbeat(id: number, fence: number, leaseMs: number): boolean {
    return this.store.runtime((now) => {
      return (
        this.store.db
          .prepare(
            `UPDATE runtime_jobs
             SET lease_expires_at=?
             WHERE id=? AND state='running' AND fence=?`,
          )
          .run(now + leaseMs, id, fence).changes > 0
      );
    });
  }

  async complete(
    project: string,
    id: number,
    options: CompleteOptions = {},
    expectedFence?: number,
  ): Promise<boolean> {
    const projectId = this.resolveProjectId(project);
    const job = this.store.runtime((now) => {
      const current = this.requiredRow(id);
      if (current.project_id !== projectId) return null;
      const fence = expectedFence ?? current.fence;
      const changed = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET state='done', result_json=?, error_json=NULL,
               finished_at=?, lease_expires_at=NULL, pid=NULL
           WHERE id=? AND state IN ('running','completing') AND fence=?`,
        )
        .run(
          options.result === undefined
            ? null
            : canonicalJson(options.result),
          now,
          id,
          fence,
        ).changes;
      if (changed === 0) return null;
      if (current.artifact_id) {
        this.store.db
          .prepare(
            `UPDATE runtime_artifact_views
             SET status='ready', meta_json='{}', owner_id=NULL,
                 owner_kind=NULL, pid=NULL, deadline_at=NULL,
                 updated_at=?
             WHERE artifact_id=?`,
          )
          .run(now, current.artifact_id);
      }
      return rowToJob(this.requiredRow(id));
    });
    if (!job) return false;
    await this.recordTerminal(job);
    return true;
  }

  async fail(
    project: string,
    id: number,
    options: FailOptions,
    expectedFence?: number,
  ): Promise<boolean> {
    const projectId = this.resolveProjectId(project);
    const job = this.store.runtime((now) => {
      const current = this.requiredRow(id);
      if (current.project_id !== projectId) return null;
      const fence = expectedFence ?? current.fence;
      const retry =
        options.allowRetry !== false &&
        current.attempts < current.max_attempts;
      const nextState = retry ? "queued" : "failed";
      const changed = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET state=?, error_json=?, finished_at=?,
               lease_expires_at=NULL, pid=NULL
           WHERE id=? AND state IN ('running','completing') AND fence=?`,
        )
        .run(
          nextState,
          canonicalJson(options.error),
          retry ? null : now,
          id,
          fence,
        ).changes;
      if (changed === 0) return null;
      if (
        !retry &&
        current.artifact_id &&
        options.preserveArtifactState !== true
      ) {
        this.store.db
          .prepare(
            `UPDATE runtime_artifact_views
             SET status='error', meta_json=?, owner_id=NULL,
                 owner_kind=NULL, pid=NULL, deadline_at=NULL,
                 updated_at=?
             WHERE artifact_id=?`,
          )
          .run(
            canonicalJson({ error: options.error }),
            now,
            current.artifact_id,
          );
      }
      return retry ? null : rowToJob(this.requiredRow(id));
    });
    if (!job) return false;
    await this.recordTerminal(job);
    return true;
  }

  async abort(project: string, id: number, reason: string): Promise<boolean> {
    const projectId = this.resolveProjectId(project);
    const job = this.store.runtime((now) => {
      const changed = this.store.db
        .prepare(
          `UPDATE runtime_jobs
           SET state='aborted', error_json=?, finished_at=?,
               lease_expires_at=NULL, pid=NULL, fence=fence+1
           WHERE id=? AND project_id=?
             AND state IN ('queued','running','completing')`,
        )
        .run(canonicalJson({ message: reason }), now, id, projectId).changes;
      return changed > 0 ? rowToJob(this.requiredRow(id)) : null;
    });
    if (!job) return false;
    await this.recordTerminal(job);
    return true;
  }

  markCompleting(project: string, id: number): boolean {
    const projectId = this.resolveProjectId(project);
    return this.store.runtime(() => {
      return (
        this.store.db
          .prepare(
            `UPDATE runtime_jobs
             SET state='completing'
             WHERE id=? AND project_id=? AND state='running'`,
          )
          .run(id, projectId).changes > 0
      );
    });
  }

  async abortArtifact(artifactId: string, reason: string): Promise<Job[]> {
    const ids = (
      this.store.db
        .prepare(
          `SELECT id FROM runtime_jobs
           WHERE artifact_id=?
             AND state IN ('queued','running','completing')`,
        )
        .all(artifactId) as unknown as Array<{ id: number }>
    ).map((row) => row.id);
    const terminal: Job[] = [];
    for (const id of ids) {
      const current = this.requiredRow(id);
      const project = current.project_id;
      const changed = this.store.runtime((now) => {
        const updated = this.store.db
          .prepare(
            `UPDATE runtime_jobs
             SET state='aborted', error_json=?, finished_at=?,
                 lease_expires_at=NULL, pid=NULL, fence=fence+1
             WHERE id=? AND state IN ('queued','running','completing')`,
          )
          .run(canonicalJson({ message: reason }), now, id).changes;
        return updated > 0 ? rowToJob(this.requiredRow(id)) : null;
      });
      if (changed) {
        terminal.push(changed);
        await this.recordTerminal(changed);
      }
      void project;
    }
    return terminal;
  }

  async reap(
    project: string,
  ): Promise<{ requeued: number; failed: number }> {
    const projectId = this.resolveProjectId(project);
    const result = this.store.runtime((now) => {
      const rows = this.store.db
        .prepare(
          `${JOB_SELECT}
           WHERE project_id=?
             AND state IN ('running','completing')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`,
        )
        .all(projectId, now) as unknown as JobRow[];
      let requeued = 0;
      let failed = 0;
      const terminal: Job[] = [];
      for (const row of rows) {
        if (row.attempts < row.max_attempts) {
          this.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET state='queued', pid=NULL, lease_expires_at=NULL,
                   fence=fence+1
               WHERE id=?`,
            )
            .run(row.id);
          requeued += 1;
        } else {
          this.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET state='failed', pid=NULL, lease_expires_at=NULL,
                   finished_at=?, error_json=?, fence=fence+1
               WHERE id=?`,
            )
            .run(
              now,
              canonicalJson({ message: "Job lease expired" }),
              row.id,
            );
          failed += 1;
          terminal.push(rowToJob(this.requiredRow(row.id)));
        }
      }
      return { requeued, failed, terminal };
    });
    for (const job of result.terminal) {
      await this.recordTerminal(job);
    }
    return { requeued: result.requeued, failed: result.failed };
  }

  listLeased(project: string): Job[] {
    return this.list(project, {
      states: ["running", "completing"],
    });
  }

  createRunner(project: string, config: RunnerConfig): QueueRunner {
    this.resolveProjectId(project);
    return new QueueRunner(this, project, config);
  }

  private requiredRow(id: number): JobRow {
    const row = this.store.db
      .prepare(`${JOB_SELECT} WHERE id = ?`)
      .get(id) as unknown as JobRow | undefined;
    if (!row) throw new Error(`Job ${id} not found`);
    return row;
  }

  private requiredRowByOperation(operationId: string): JobRow {
    const row = this.store.db
      .prepare(`${JOB_SELECT} WHERE operation_id = ?`)
      .get(operationId) as unknown as JobRow | undefined;
    if (!row) throw new Error(`Job operation ${operationId} not found`);
    return row;
  }

  private findDuplicateRow(
    projectId: string,
    type: string,
    externalTaskId: string | null,
    dedupeKey: string | null,
  ): JobRow {
    const row = externalTaskId
      ? (this.store.db
          .prepare(
            `${JOB_SELECT}
             WHERE project_id=? AND type=? AND external_task_id=?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(projectId, type, externalTaskId) as unknown as
          | JobRow
          | undefined)
      : (this.store.db
          .prepare(
            `${JOB_SELECT}
             WHERE project_id=? AND dedupe_key=?
               AND state IN ('queued','running','completing')
             ORDER BY id DESC LIMIT 1`,
          )
          .get(projectId, dedupeKey) as unknown as JobRow | undefined);
    if (!row) throw new Error("Queue insert was ignored without a duplicate");
    return row;
  }

  private upsertQueuedArtifactView(
    projectId: string,
    artifactId: string,
    kind: string,
    orientation: string | null,
    now: number,
  ): void {
    this.store.db
      .prepare(
        `INSERT INTO runtime_artifact_views(
          artifact_id, project_id, status, meta_json, updated_at
        ) VALUES (?, ?, 'pending', ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          status='pending',
          meta_json=excluded.meta_json,
          owner_id=NULL,
          owner_kind=NULL,
          pid=NULL,
          deadline_at=NULL,
          updated_at=excluded.updated_at`,
      )
      .run(
        artifactId,
        projectId,
        canonicalJson({ kind, orientation, queued: true }),
        now,
      );
  }
}

export class QueueRunner {
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private reapTimer: NodeJS.Timeout | null = null;
  private active = new Map<number, Promise<void>>();
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly reapIntervalMs: number;

  constructor(
    private readonly queue: JobQueue,
    private readonly project: string,
    private readonly config: RunnerConfig,
  ) {
    this.leaseMs = config.leaseMs ?? 30_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 250;
    this.reapIntervalMs = config.reapIntervalMs ?? 5_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    this.reapTimer = setInterval(
      () => {
        void this.queue.reap(this.project);
      },
      this.reapIntervalMs,
    );
    this.reapTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reapTimer) clearInterval(this.reapTimer);
    this.pollTimer = null;
    this.reapTimer = null;
    await Promise.allSettled(this.active.values());
  }

  async waitFor(id: number, timeoutMs = 300_000): Promise<unknown> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const job = this.queue.get(this.project, id);
      if (!job) throw new Error(`Job ${id} not found`);
      if (job.state === "done") return job.result;
      if (job.state === "failed" || job.state === "aborted") {
        throw new Error(
          `Job ${id} ${job.state}: ${job.error?.message ?? "unknown error"}`,
        );
      }
      await delay(50);
    }
    throw new Error(`Job ${id} timed out after ${timeoutMs}ms`);
  }

  private schedule(delayMs: number): void {
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
      const job = this.queue.dequeue(
        this.project,
        process.pid,
        this.leaseMs,
      );
      if (!job) break;
      const task = this.run(job);
      this.active.set(job.id, task);
      void task.finally(() => {
        this.active.delete(job.id);
        this.schedule(0);
      });
    }
    this.schedule(this.pollIntervalMs);
  }

  private async run(job: Job): Promise<void> {
    const heartbeat = setInterval(
      () => this.queue.heartbeat(job.id, job.fence, this.leaseMs),
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref?.();
    try {
      const handler: JobHandler | null = this.config.resolveHandler(job.type);
      if (!handler) throw new Error(`No handler for job type: ${job.type}`);
      const result = await handler(job);
      await this.queue.complete(
        this.project,
        job.id,
        { result },
        job.fence,
      );
    } catch (error) {
      const jobError: JobError = {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.name
          ? { code: error.name }
          : {}),
      };
      await this.queue.fail(
        this.project,
        job.id,
        {
          error: jobError,
          preserveArtifactState:
            typeof error === "object" &&
            error !== null &&
            "preserveArtifactState" in error &&
            error.preserveArtifactState === true,
        },
        job.fence,
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
}

const JOB_SELECT = `
  SELECT id, operation_id, project_id, type, artifact_id, external_task_id,
         state, payload_json, result_json, enqueued_at, started_at,
         finished_at, lease_expires_at, attempts, max_attempts,
         error_json, fence
  FROM runtime_jobs
`;

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    operationId: row.operation_id,
    projectId: row.project_id,
    type: row.type,
    artifactId: row.artifact_id,
    externalTaskId: row.external_task_id,
    state: row.state,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    result:
      row.result_json === null
        ? null
        : parseJson<unknown>(row.result_json, null),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error:
      row.error_json === null
        ? null
        : parseJson<JobError>(row.error_json, {
            message: row.error_json,
          }),
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    leaseExpiresAt: row.lease_expires_at,
    fence: row.fence,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
