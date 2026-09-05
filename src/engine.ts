import type {
  CatalogGcReport,
  CatalogIntegritySnapshot,
  EngineConfig,
  Job,
  JobState,
  SimilarityApi,
} from "./engine-types.js";
import { createBookApi } from "./books.js";
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
import { createGenerationsApi } from "./generations.js";
import { createHistoryApi } from "./history.js";
import { createRuntimeApi, createLogsApi } from "./runtime-services.js";
import { createStatusApi } from "./status.js";
import { createStorageApi } from "./storage.js";
import { EngineContext } from "./context.js";
import { JobQueue } from "./job-queue.js";
import { canonicalJson } from "./store.js";
import { createSimilarityApi } from "./similarity.js";
import { createStreamsApi } from "./streams.js";
import { createTranscriptsApi } from "./transcripts.js";
import { createSequencesApi } from "./sequences.js";
import { createEditsApi } from "./edits.js";
import { clearTemporalSearchCache, createTemporalSearchApi } from "./temporal-search.js";

export class Engine {
  readonly book;
  readonly artifacts;
  readonly files;
  readonly workspaces;
  readonly metadata;
  readonly streams;
  readonly transcripts;
  readonly sequences;
  readonly edits;
  readonly temporalSearch;
  readonly entities;
  readonly notebooks;
  readonly prompts;
  readonly messages;
  readonly generations;
  readonly history;
  readonly status;
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
    this.book = createBookApi(this.context);
    this.artifacts = createArtifactsApi(this.context);
    this.files = createFilesApi(this.context);
    this.workspaces = createWorkspacesApi(this.context);
    this.metadata = createMetadataApi(this.context);
    this.streams = createStreamsApi(this.context);
    this.transcripts = createTranscriptsApi(this.context);
    this.sequences = createSequencesApi(this.context);
    this.edits = createEditsApi(this.context);
    this.temporalSearch = createTemporalSearchApi(this.context);
    this.entities = createEntitiesApi(this.context);
    this.notebooks = createNotebooksApi(this.context);
    this.prompts = createPromptsApi(this.context);
    this.messages = createMessagesApi(this.context);
    this.generations = createGenerationsApi(this.context);
    this.history = createHistoryApi(this.context);
    this.status = createStatusApi(this.context);
    this.storage = createStorageApi(this.context);
    this.logs = createLogsApi(this.context);

    const runtime = createRuntimeApi(this.context);
    this.settings = runtime.settings;
    this.similarity = createSimilarityApi(this.context);
    const queue = new JobQueue(
      this.context.store,
      (reference) => this.context.artifactRow(reference).artifact_id,
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

  get lastCatalogGc(): CatalogGcReport | undefined {
    return this.context.store.lastCatalogGc;
  }

  gcCatalog(): CatalogGcReport {
    return this.context.store.gcCatalog("manual");
  }

  catalogIntegrity(): CatalogIntegritySnapshot {
    const store = this.context.store;
    const artifacts = store.db
      .prepare(
        `SELECT artifact_id, kind, label FROM artifacts ORDER BY artifact_id`,
      )
      .all() as unknown as Array<{
      artifact_id: string;
      kind: CatalogIntegritySnapshot["artifacts"][number]["kind"];
      label: string | null;
    }>;
    const notebooks = store.db
      .prepare(
        `SELECT notebook_id, name FROM notebooks ORDER BY notebook_id`,
      )
      .all() as unknown as Array<{ notebook_id: string; name: string }>;
    return {
      head: store.head,
      logCount: store.db.doltLog().length,
      book: this.book.get(),
      artifacts: artifacts.map((row) => ({
        artifactId: row.artifact_id,
        kind: row.kind,
        label: row.label,
      })),
      notebooks: notebooks.map((row) => ({
        notebookId: row.notebook_id,
        name: row.name,
      })),
      doltStatus: store.status
        .map((entry) => ({
          table_name: entry.table_name,
          staged: entry.staged,
          status: entry.status,
        }))
        .sort((left, right) => left.table_name.localeCompare(right.table_name)),
      tableRowCounts: store.tableRowCounts(),
    };
  }

  async initialize(): Promise<void> {
    await this.reconcileTerminalJobs();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTemporalSearchCache(this.context);
    this.context.close();
  }

  private async reconcileTerminalJobs(): Promise<void> {
    const rows = this.context.store.db
      .prepare(
        `SELECT j.id
         FROM runtime_jobs j
         LEFT JOIN job_runs r ON r.run_id=j.operation_id
         WHERE j.state IN ('done','failed','aborted')
           AND r.run_id IS NULL
         ORDER BY j.finished_at, j.id`,
      )
      .all() as unknown as Array<{
      id: number;
    }>;
    for (const row of rows) {
      const job = this.jobs.queue.get(row.id);
      if (job) await this.recordTerminalJob(job);
    }
  }

  private async recordTerminalJob(job: Job): Promise<void> {
    if (!isTerminal(job.state)) return;
    // job_runs rows are ignored runtime bookkeeping, not semantic history,
    // so recording a terminal job must never mint a commit. In particular,
    // reconciling terminal jobs when a catalog is opened keeps open
    // read-only: a freshly cloned fork no longer diverges just by opening.
    this.context.store.runtime((now) => {
      this.context.store.db
        .prepare(
          `INSERT OR IGNORE INTO job_runs(
            run_id, artifact_id, job_type, state,
            payload_json, result_json, error_json,
            started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.operationId,
          job.artifactId,
          job.type,
          job.state,
          canonicalJson(job.payload),
          job.result === null ? null : canonicalJson(job.result),
          job.error === null ? null : canonicalJson(job.error),
          job.startedAt,
          job.finishedAt ?? now,
        );
    });
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
