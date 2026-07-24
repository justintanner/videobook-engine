import type {
  EngineConfig,
  Job,
  JobState,
  SimilarityApi,
} from "./engine-types.js";
import { createProjectsApi } from "./projects.js";
import { createArtifactsApi } from "./artifacts.js";
import {
  createFilesApi,
  createWorkspacesApi,
} from "./files.js";
import { createMetadataApi } from "./metadata.js";
import {
  createEntitiesApi,
  createNotebooksApi,
} from "./domain.js";
import {
  createMessagesApi,
  createPromptsApi,
} from "./communications.js";
import { createHistoryApi } from "./history.js";
import { createRuntimeApi, createLogsApi } from "./runtime-services.js";
import { createStatusApi } from "./status.js";
import { createResolverApi } from "./resolver.js";
import { createStorageApi } from "./storage.js";
import { EngineContext } from "./context.js";
import { JobQueue } from "./job-queue.js";
import { canonicalJson } from "./store.js";
import { createSimilarityApi } from "./similarity.js";

export class Engine {
  readonly projects;
  readonly artifacts;
  readonly files;
  readonly workspaces;
  readonly metadata;
  readonly entities;
  readonly notebooks;
  readonly prompts;
  readonly messages;
  readonly history;
  readonly status;
  readonly resolver;
  readonly storage;
  readonly logs;
  readonly settings;
  readonly jobs;
  readonly similarity: SimilarityApi;
  readonly ready: Promise<void>;

  private readonly context: EngineContext;
  private closed = false;

  constructor(config: EngineConfig) {
    this.context = new EngineContext(config);
    this.projects = createProjectsApi(this.context);
    this.artifacts = createArtifactsApi(this.context);
    this.files = createFilesApi(this.context);
    this.workspaces = createWorkspacesApi(this.context);
    this.metadata = createMetadataApi(this.context);
    this.entities = createEntitiesApi(this.context);
    this.notebooks = createNotebooksApi(this.context);
    this.prompts = createPromptsApi(this.context);
    this.messages = createMessagesApi(this.context);
    this.history = createHistoryApi(this.context);
    this.status = createStatusApi(this.context);
    this.resolver = createResolverApi(this.context);
    this.storage = createStorageApi(this.context);
    this.logs = createLogsApi(this.context);

    const runtime = createRuntimeApi(this.context);
    this.settings = runtime.settings;
    this.similarity = createSimilarityApi(this.context);
    const queue = new JobQueue(
      this.context.store,
      (reference) => this.context.projectRow(reference).project_id,
      (projectId, reference) =>
        this.context.artifactRow(projectId, reference).artifact_id,
      (job) => this.recordTerminalJob(job),
    );
    this.jobs = {
      queue,
      artifactWork: runtime.artifactWork,
      pending: runtime.pending,
      failures: runtime.failures,
      locks: runtime.locks,
      recoverArtifact: runtime.recoverArtifact,
      recoverAll: runtime.recoverAll,
      startReaper: runtime.startReaper,
      checkSchema: runtime.checkSchema,
    };
    this.ready = this.reconcileTerminalJobs();
  }

  get head(): string {
    return this.context.store.head;
  }

  async initialize(): Promise<void> {
    await this.reconcileTerminalJobs();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.context.close();
  }

  private async reconcileTerminalJobs(): Promise<void> {
    const rows = this.context.store.db
      .prepare(
        `SELECT j.id, j.project_id
         FROM runtime_jobs j
         JOIN projects p ON p.project_id=j.project_id
         LEFT JOIN job_runs r ON r.run_id=j.operation_id
         WHERE j.state IN ('done','failed','aborted')
           AND p.deleted_at IS NULL
           AND r.run_id IS NULL
         ORDER BY j.finished_at, j.id`,
      )
      .all() as unknown as Array<{
      id: number;
      project_id: string;
    }>;
    for (const row of rows) {
      const job = this.jobs.queue.get(row.project_id, row.id);
      if (job) await this.recordTerminalJob(job);
    }
  }

  private async recordTerminalJob(job: Job): Promise<void> {
    if (!isTerminal(job.state)) return;
    await this.context.store.semantic(
      {
        projectId: job.projectId,
        operation: `job_${job.state}`,
        artifactId: job.artifactId ?? undefined,
        details: {
          jobOperationId: job.operationId,
          jobId: job.id,
          jobType: job.type,
          state: job.state,
        },
        writeSet: [`job-run:${job.operationId}`],
      },
      ["job_runs"],
      (_operationId, now) => {
        this.context.store.db
          .prepare(
            `INSERT OR IGNORE INTO job_runs(
              run_id, project_id, artifact_id, job_type, state,
              payload_json, result_json, error_json,
              started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            job.operationId,
            job.projectId,
            job.artifactId,
            job.type,
            job.state,
            canonicalJson(job.payload),
            job.result === null ? null : canonicalJson(job.result),
            job.error === null ? null : canonicalJson(job.error),
            job.startedAt,
            job.finishedAt ?? now,
          );
      },
    );
  }
}

export function createEngine(config: EngineConfig): Engine {
  return new Engine(config);
}

function isTerminal(
  state: JobState,
): state is Extract<JobState, "done" | "failed" | "aborted"> {
  return state === "done" || state === "failed" || state === "aborted";
}
