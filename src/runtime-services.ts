import { v7 as uuidv7 } from "uuid";

import type {
  ArtifactView,
  BeginArtifactWorkInput,
  EngineError,
  FailureInfo,
  GenerationError,
  LockData,
  LockOptions,
  PendingTask,
  Result,
  VersionCheckResult,
  WritePendingTaskInput,
  WritePendingTaskResult,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, syncResultOf } from "./context.js";
import { SCHEMA_VERSION } from "./schema.js";
import { canonicalJson, parseJson } from "./store.js";

interface ArtifactViewRow {
  artifact_id: string;
  project_id: string;
  status: "pending" | "working" | "ready" | "error";
  meta_json: string;
  owner_id: string | null;
  owner_kind: "job" | "provider" | null;
  pid: number | null;
  deadline_at: number | null;
  updated_at: number;
  seen_at: number | null;
}

interface PendingRow {
  artifact_id: string;
  project_id: string;
  task_id: string;
  task_type: string;
  created_at: number;
  meta_json: string;
  completing: number;
  owner_id: string | null;
}

interface FailureRow {
  artifact_id: string;
  project_id: string;
  message: string;
  fail_code: string | null;
  prompt: string | null;
  failed_at: number;
}

interface LeaseRow {
  lease_id: string;
  project_id: string | null;
  artifact_id: string | null;
  resource_key: string;
  owner_id: string;
  pid: number | null;
  state: string | null;
  data_json: string;
  fence: number;
  acquired_at: number;
  expires_at: number;
}

export function createRuntimeApi(context: EngineContext) {
  const artifactWork = createArtifactWorkApi(context);
  const pending = createPendingApi(context);
  const failures = createFailuresApi(context);
  const locks = createLocksApi(context);
  const settings = createSettingsApi(context);
  return {
    artifactWork,
    pending,
    failures,
    locks,
    settings,
    recoverArtifact: (
      project: string,
      artifact: string,
    ): Result<void, EngineError> =>
      recoverArtifact(context, project, artifact),
    recoverAll: (
      project: string,
    ): Result<{ recovered: number }, EngineError> =>
      recoverAll(context, project),
    startReaper: (
      project: string,
      options: { intervalMs: number },
    ): { stop: () => void } => startReaper(context, project, options),
    checkSchema: (): VersionCheckResult => ({
      ok: true,
      currentVersion: SCHEMA_VERSION,
      supportedVersion: SCHEMA_VERSION,
    }),
  };
}

function createSettingsApi(context: EngineContext) {
  return {
    get: <T>(key: string): T | null => {
      const normalized = settingKey(key);
      const row = context.store.db
        .prepare(
          "SELECT value_json FROM runtime_settings WHERE key=?",
        )
        .get(normalized) as unknown as
        | { value_json: string }
        | undefined;
      return row ? parseJson<T | null>(row.value_json, null) : null;
    },
    set: <T>(
      key: string,
      value: T,
    ): Result<T, EngineError> =>
      syncResultOf(() => {
        const normalized = settingKey(key);
        context.store.runtime((now) => {
          context.store.db
            .prepare(
              `INSERT INTO runtime_settings(key, value_json, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET
                 value_json=excluded.value_json,
                 updated_at=excluded.updated_at`,
            )
            .run(normalized, canonicalJson(value), now);
        });
        return value;
      }),
    delete: (key: string): Result<boolean, EngineError> =>
      syncResultOf(() => {
        const normalized = settingKey(key);
        return context.store.runtime(() =>
          context.store.db
            .prepare("DELETE FROM runtime_settings WHERE key=?")
            .run(normalized).changes > 0,
        );
      }),
  };
}

export function createLogsApi(context: EngineContext) {
  return {
    append: (
      name: string,
      line: Record<string, unknown>,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      resultOf(async () => {
        const projectId = context.projectRow(project).project_id;
        const id = context.store.runtime((now) => {
          const result = context.store.db
            .prepare(
              `INSERT INTO runtime_logs(
                project_id, name, body_json, created_at
              ) VALUES (?, ?, ?, ?)`,
            )
            .run(projectId, logName(name), canonicalJson(line), now);
          return result.lastInsertRowid;
        });
        return String(id);
      }),
    read: (
      name: string,
      project: string,
      options: { limit?: number } = {},
    ): Record<string, unknown>[] => {
      const projectId = context.projectRow(project).project_id;
      const rows = context.store.db
        .prepare(
          `SELECT body_json
           FROM runtime_logs
           WHERE project_id=? AND name=?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(
          projectId,
          logName(name),
          Math.max(1, options.limit ?? 100),
        ) as unknown as Array<{ body_json: string }>;
      return rows
        .reverse()
        .map((row) =>
          parseJson<Record<string, unknown>>(row.body_json, {}),
        );
    },
  };
}

function createArtifactWorkApi(context: EngineContext) {
  return {
    begin: (
      project: string,
      artifact: string,
      input: BeginArtifactWorkInput,
    ): { ownerId: string } | null => {
      const projectRow = context.projectRow(project);
      const artifactRow = context.artifactRow(
        projectRow.project_id,
        artifact,
      );
      return context.store.runtime((now) => {
        const existing = context.store.db
          .prepare(
            `SELECT status, owner_id
             FROM runtime_artifact_views
             WHERE artifact_id=?`,
          )
          .get(artifactRow.artifact_id) as unknown as
          | { status: string; owner_id: string | null }
          | undefined;
        if (
          existing?.owner_id ||
          existing?.status === "working" ||
          existing?.status === "error"
        ) {
          return null;
        }
        const ownerId = uuidv7();
        const deadline = now + Math.max(1, input.durationMs);
        const pid =
          input.pid ??
          (input.ownerKind === "job" ? process.pid : null);
        const meta = {
          kind: input.kind,
          orientation: input.meta?.orientation ?? null,
          queued: false,
          progress: input.meta?.progress ?? null,
          error: null,
          ...(input.meta ?? {}),
        };
        context.store.db
          .prepare(
            `INSERT INTO runtime_artifact_views(
              artifact_id, project_id, status, meta_json, owner_id,
              owner_kind, pid, deadline_at, updated_at, fence
            ) VALUES (?, ?, 'working', ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(artifact_id) DO UPDATE SET
              status='working',
              meta_json=excluded.meta_json,
              owner_id=excluded.owner_id,
              owner_kind=excluded.owner_kind,
              pid=excluded.pid,
              deadline_at=excluded.deadline_at,
              updated_at=excluded.updated_at,
              fence=runtime_artifact_views.fence+1`,
          )
          .run(
            artifactRow.artifact_id,
            projectRow.project_id,
            canonicalJson(meta),
            ownerId,
            input.ownerKind,
            pid,
            deadline,
            now,
          );
        return { ownerId };
      });
    },
    complete: (
      project: string,
      artifact: string,
      ownerId: string,
    ): boolean => {
      const projectRow = context.projectRow(project);
      const artifactId = context.artifactRow(
        projectRow.project_id,
        artifact,
      ).artifact_id;
      return context.store.runtime((now) => {
        return (
          context.store.db
            .prepare(
              `UPDATE runtime_artifact_views
               SET status='ready', meta_json='{}', owner_id=NULL,
                   owner_kind=NULL, pid=NULL, deadline_at=NULL,
                   updated_at=?
               WHERE artifact_id=? AND owner_id=?`,
            )
            .run(now, artifactId, ownerId).changes > 0
        );
      });
    },
    fail: (
      project: string,
      artifact: string,
      ownerId: string,
      failure: { message: string; code?: string },
    ): Promise<boolean> =>
      failArtifactWork(context, project, artifact, ownerId, failure),
    renew: (
      project: string,
      artifact: string,
      ownerId: string,
      extendMs: number,
    ): boolean => {
      const projectRow = context.projectRow(project);
      const artifactId = context.artifactRow(
        projectRow.project_id,
        artifact,
      ).artifact_id;
      return context.store.runtime((now) => {
        return (
          context.store.db
            .prepare(
              `UPDATE runtime_artifact_views
               SET deadline_at=MAX(COALESCE(deadline_at, 0), ?),
                   updated_at=?
               WHERE artifact_id=? AND owner_id=? AND status='working'`,
            )
            .run(now + Math.max(1, extendMs), now, artifactId, ownerId)
            .changes > 0
        );
      });
    },
    markSeen: (project: string, artifact: string): boolean => {
      const projectRow = context.projectRow(project);
      const artifactId = context.artifactRow(
        projectRow.project_id,
        artifact,
      ).artifact_id;
      return context.store.runtime((now) => {
        return (
          context.store.db
            .prepare(
              `UPDATE runtime_artifact_views
               SET seen_at=?, updated_at=? WHERE artifact_id=?`,
            )
            .run(now, now, artifactId).changes > 0
        );
      });
    },
    read: (
      project: string,
      artifact: string,
    ): Result<ArtifactView | null, EngineError> =>
      syncResultOf(() => {
        const projectRow = context.projectRow(project);
        const artifactRow = context.artifactRow(
          projectRow.project_id,
          artifact,
        );
        const row = context.store.db
          .prepare(`${VIEW_SELECT} WHERE artifact_id=?`)
          .get(artifactRow.artifact_id) as unknown as
          | ArtifactViewRow
          | undefined;
        return row ? viewFromRow(context, row) : null;
      }),
    list: (project: string): Result<ArtifactView[], EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const rows = context.store.db
          .prepare(
            `${VIEW_SELECT}
             WHERE project_id=?
             ORDER BY updated_at DESC`,
          )
          .all(projectId) as unknown as ArtifactViewRow[];
        return rows.map((row) => viewFromRow(context, row));
      }),
  };
}

function createPendingApi(context: EngineContext) {
  return {
    write: (
      project: string,
      input: WritePendingTaskInput,
      expectedOwnerId: string,
    ): Promise<
      Result<WritePendingTaskResult | null, EngineError>
    > =>
      resultOf(async () => {
        const projectRow = context.projectRow(project);
        const artifact = context.artifactRow(
          projectRow.project_id,
          input.artifactId,
        );
        const value = context.store.runtime((now) => {
          const existing = context.store.db
            .prepare(
              `SELECT task_id, owner_id
               FROM runtime_pending_tasks WHERE artifact_id=?`,
            )
            .get(artifact.artifact_id) as unknown as
            | { task_id: string; owner_id: string | null }
            | undefined;
          if (
            existing &&
            existing.owner_id !== null &&
            existing.owner_id !== expectedOwnerId
          ) {
            return null;
          }
          context.store.db
            .prepare(
              `INSERT INTO runtime_pending_tasks(
                artifact_id, project_id, task_id, task_type,
                created_at, meta_json, completing, owner_id
              ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(artifact_id) DO UPDATE SET
                task_id=excluded.task_id,
                task_type=excluded.task_type,
                created_at=excluded.created_at,
                meta_json=excluded.meta_json,
                completing=0,
                owner_id=excluded.owner_id`,
            )
            .run(
              artifact.artifact_id,
              projectRow.project_id,
              input.taskId,
              input.taskType,
              now,
              canonicalJson(input.meta ?? {}),
              expectedOwnerId,
            );
          const row = requiredPendingRow(context, artifact.artifact_id);
          return {
            task: pendingFromRow(context, row),
            inserted: !existing,
          };
        });
        return value;
      }),
    read: (
      project: string,
      artifact: string,
    ): Result<PendingTask | null, EngineError> =>
      syncResultOf(() => {
        const projectRow = context.projectRow(project);
        const artifactId = context.artifactRow(
          projectRow.project_id,
          artifact,
        ).artifact_id;
        const row = context.store.db
          .prepare(`${PENDING_SELECT} WHERE artifact_id=?`)
          .get(artifactId) as unknown as PendingRow | undefined;
        return row ? pendingFromRow(context, row) : null;
      }),
    delete: (
      project: string,
      artifact: string,
      expectedTaskId?: string,
    ): Result<boolean, EngineError> =>
      syncResultOf(() => {
        const projectRow = context.projectRow(project);
        const artifactId = context.artifactRow(
          projectRow.project_id,
          artifact,
        ).artifact_id;
        return context.store.runtime(() => {
          const statement = expectedTaskId
            ? context.store.db.prepare(
                `DELETE FROM runtime_pending_tasks
                 WHERE artifact_id=? AND task_id=?`,
              )
            : context.store.db.prepare(
                "DELETE FROM runtime_pending_tasks WHERE artifact_id=?",
              );
          return (
            statement.run(
              ...(
                expectedTaskId
                  ? [artifactId, expectedTaskId]
                  : [artifactId]
              ),
            ).changes > 0
          );
        });
      }),
    markCompleting: (
      project: string,
      artifact: string,
    ): Result<boolean, EngineError> =>
      updateCompleting(context, project, artifact, true),
    clearCompleting: (
      project: string,
      artifact: string,
    ): Result<boolean, EngineError> =>
      updateCompleting(context, project, artifact, false),
    findAll: (
      project: string,
    ): Result<PendingTask[], EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const rows = context.store.db
          .prepare(
            `${PENDING_SELECT}
             WHERE project_id=?
             ORDER BY created_at, artifact_id`,
          )
          .all(projectId) as unknown as PendingRow[];
        return rows.map((row) => pendingFromRow(context, row));
      }),
    findByExternalId: (
      project: string,
      taskId: string,
    ): Result<PendingTask | null, EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const row = context.store.db
          .prepare(
            `${PENDING_SELECT}
             WHERE project_id=? AND task_id=?`,
          )
          .get(projectId, taskId) as unknown as PendingRow | undefined;
        return row ? pendingFromRow(context, row) : null;
      }),
    getOwner: (
      project: string,
      artifact: string,
      taskId: string,
    ): string | null => {
      const projectId = context.projectRow(project).project_id;
      const artifactId = context.artifactRow(
        projectId,
        artifact,
      ).artifact_id;
      const row = context.store.db
        .prepare(
          `SELECT owner_id FROM runtime_pending_tasks
           WHERE artifact_id=? AND task_id=?`,
        )
        .get(artifactId, taskId) as unknown as
        | { owner_id: string | null }
        | undefined;
      return row?.owner_id ?? null;
    },
    fail: (
      project: string,
      artifact: string,
      taskOrInfo: string | FailureInfo,
      maybeInfo?: FailureInfo,
    ): Promise<Result<GenerationError | null, EngineError>> =>
      failPending(
        context,
        project,
        artifact,
        typeof taskOrInfo === "string" ? taskOrInfo : undefined,
        typeof taskOrInfo === "string" ? maybeInfo! : taskOrInfo,
      ),
    forceFail: (
      project: string,
      artifact: string,
      info: FailureInfo,
    ): Promise<Result<GenerationError | null, EngineError>> =>
      failPending(context, project, artifact, undefined, info, true),
  };
}

function createFailuresApi(context: EngineContext) {
  return {
    write: (
      project: string,
      artifact: string,
      info: FailureInfo,
    ): Promise<Result<GenerationError, EngineError>> =>
      writeFailure(context, project, artifact, info),
    read: (
      project: string,
      artifact: string,
    ): Result<GenerationError | null, EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const artifactId = context.artifactRow(
          projectId,
          artifact,
        ).artifact_id;
        const row = context.store.db
          .prepare(`${FAILURE_SELECT} WHERE artifact_id=?`)
          .get(artifactId) as unknown as FailureRow | undefined;
        return row ? failureFromRow(context, row) : null;
      }),
    clear: (
      project: string,
      artifact: string,
    ): Promise<Result<boolean, EngineError>> =>
      clearFailure(context, project, artifact),
    findAll: (
      project: string,
    ): Result<GenerationError[], EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const rows = context.store.db
          .prepare(
            `${FAILURE_SELECT}
             WHERE project_id=?
             ORDER BY failed_at DESC`,
          )
          .all(projectId) as unknown as FailureRow[];
        return rows.map((row) => failureFromRow(context, row));
      }),
  };
}

function createLocksApi(context: EngineContext) {
  return {
    acquire: (
      resource: string,
      options: LockOptions,
    ): Promise<Result<LockData, EngineError>> =>
      resultOf(async () => {
        const key = resourceKey(resource);
        const ownerId = options.ownerId ?? uuidv7();
        const value = context.store.runtime((now) => {
          context.store.db
            .prepare(
              `UPDATE runtime_resource_leases
               SET revoked_at=?, fence=fence+1
               WHERE resource_key=? AND revoked_at IS NULL
                 AND expires_at<=?`,
            )
            .run(now, key, now);
          const active = context.store.db
            .prepare(
              `${LEASE_SELECT}
               WHERE resource_key=? AND revoked_at IS NULL`,
            )
            .get(key) as unknown as LeaseRow | undefined;
          if (active) {
            throw new Error(`Resource is locked: ${key}`);
          }
          const identity = workspaceIdentity(context, key);
          const fenceRow = context.store.db
            .prepare(
              `SELECT COALESCE(MAX(fence), 0) AS fence
               FROM runtime_resource_leases WHERE resource_key=?`,
            )
            .get(key) as unknown as { fence: number };
          const leaseId = uuidv7();
          const fence = fenceRow.fence + 1;
          context.store.db
            .prepare(
              `INSERT INTO runtime_resource_leases(
                lease_id, project_id, artifact_id, resource_key,
                owner_id, owner_kind, pid, state, data_json, fence,
                acquired_at, expires_at, revoked_at
              ) VALUES (?, ?, ?, ?, ?, 'process', ?, ?, ?, ?, ?, ?, NULL)`,
            )
            .run(
              leaseId,
              identity.projectId,
              identity.artifactId,
              key,
              ownerId,
              process.pid,
              options.state ?? null,
              canonicalJson(options.data ?? {}),
              fence,
              now,
              now + Math.max(1, options.durationMs),
            );
          return requiredLease(context, leaseId);
        });
        return lockFromRow(value);
      }),
    release: (
      resource: string,
      ownerId?: string,
    ): Result<boolean, EngineError> =>
      syncResultOf(() => {
        const key = resourceKey(resource);
        return context.store.runtime((now) => {
          const sql = ownerId
            ? `UPDATE runtime_resource_leases
               SET revoked_at=?, fence=fence+1
               WHERE resource_key=? AND owner_id=? AND revoked_at IS NULL`
            : `UPDATE runtime_resource_leases
               SET revoked_at=?, fence=fence+1
               WHERE resource_key=? AND revoked_at IS NULL`;
          return (
            context.store.db
              .prepare(sql)
              .run(...(ownerId ? [now, key, ownerId] : [now, key]))
              .changes > 0
          );
        });
      }),
    isLocked: (resource: string): boolean => {
      const key = resourceKey(resource);
      const now = Date.now();
      return Boolean(
        context.store.db
          .prepare(
            `SELECT 1 AS present FROM runtime_resource_leases
             WHERE resource_key=? AND revoked_at IS NULL AND expires_at>?`,
          )
          .get(key, now),
      );
    },
    get: (resource: string): LockData | null => {
      const key = resourceKey(resource);
      const row = context.store.db
        .prepare(
          `${LEASE_SELECT}
           WHERE resource_key=? AND revoked_at IS NULL AND expires_at>?
           ORDER BY fence DESC LIMIT 1`,
        )
        .get(key, Date.now()) as unknown as LeaseRow | undefined;
      return row ? lockFromRow(row) : null;
    },
    cleanStale: (resource: string): boolean => {
      const key = resourceKey(resource);
      return context.store.runtime((now) => {
        return (
          context.store.db
            .prepare(
              `UPDATE runtime_resource_leases
               SET revoked_at=?, fence=fence+1
               WHERE resource_key=? AND revoked_at IS NULL
                 AND expires_at<=?`,
            )
            .run(now, key, now).changes > 0
        );
      });
    },
  };
}

async function failArtifactWork(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
  ownerId: string,
  failure: { message: string; code?: string },
): Promise<boolean> {
  const project = context.projectRow(projectReference);
  const artifact = context.artifactRow(
    project.project_id,
    artifactReference,
  );
  const current = context.store.db
    .prepare(
      `SELECT owner_id FROM runtime_artifact_views
       WHERE artifact_id=?`,
    )
    .get(artifact.artifact_id) as unknown as
    | { owner_id: string | null }
    | undefined;
  if (current?.owner_id !== ownerId) return false;
  const result = await writeFailure(context, projectReference, artifactReference, {
    message: failure.message,
    ...(failure.code ? { failCode: failure.code } : {}),
  });
  return result.ok;
}

async function failPending(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
  expectedTaskId: string | undefined,
  info: FailureInfo,
  force = false,
): Promise<Result<GenerationError | null, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const pending = context.store.db
      .prepare(`${PENDING_SELECT} WHERE artifact_id=?`)
      .get(artifact.artifact_id) as unknown as PendingRow | undefined;
    if (
      !force &&
      (!pending ||
        (expectedTaskId !== undefined &&
          pending.task_id !== expectedTaskId))
    ) {
      return null;
    }
    const result = await writeFailure(
      context,
      projectReference,
      artifactReference,
      info,
    );
    if (!result.ok) throw new Error(result.error.message);
    context.store.runtime(() => {
      context.store.db
        .prepare(
          "DELETE FROM runtime_pending_tasks WHERE artifact_id=?",
        )
        .run(artifact.artifact_id);
    });
    return result.value;
  });
}

async function writeFailure(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
  info: FailureInfo,
): Promise<Result<GenerationError, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const mutation = await context.store.semantic<number>(
      {
        projectId: project.project_id,
        operation: "artifact_failed",
        artifactId: artifact.artifact_id,
        details: { ...info },
        writeSet: [`artifact-runtime:${artifact.artifact_id}`],
      },
      ["artifact_events", "job_runs"],
      (operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO runtime_generation_errors(
              artifact_id, project_id, message, fail_code, prompt, failed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(artifact_id) DO UPDATE SET
              message=excluded.message,
              fail_code=excluded.fail_code,
              prompt=excluded.prompt,
              failed_at=excluded.failed_at`,
          )
          .run(
            artifact.artifact_id,
            project.project_id,
            info.message,
            info.failCode ?? null,
            info.prompt ?? null,
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO runtime_artifact_views(
              artifact_id, project_id, status, meta_json, updated_at
            ) VALUES (?, ?, 'error', ?, ?)
            ON CONFLICT(artifact_id) DO UPDATE SET
              status='error',
              meta_json=excluded.meta_json,
              owner_id=NULL,
              owner_kind=NULL,
              pid=NULL,
              deadline_at=NULL,
              updated_at=excluded.updated_at`,
          )
          .run(
            artifact.artifact_id,
            project.project_id,
            canonicalJson({
              error: {
                message: info.message,
                code: info.failCode ?? null,
              },
            }),
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'failed', ?, ?)`,
          )
          .run(
            uuidv7(),
            artifact.artifact_id,
            operationId,
            canonicalJson(info),
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO job_runs(
              run_id, project_id, artifact_id, job_type, state,
              payload_json, result_json, error_json,
              started_at, finished_at
            ) VALUES (?, ?, ?, 'external', 'failed', '{}', NULL, ?, NULL, ?)`,
          )
          .run(
            uuidv7(),
            project.project_id,
            artifact.artifact_id,
            canonicalJson(info),
            now,
          );
        return now;
      },
    );
    return ok(
      {
        artifactId: artifact.artifact_id,
        artifactSlug: artifact.slug,
        message: info.message,
        ...(info.failCode ? { failCode: info.failCode } : {}),
        ...(info.prompt !== undefined
          ? { prompt: info.prompt }
          : {}),
        failedAt: mutation.value,
      },
      mutation.revision,
    );
  });
}

async function clearFailure(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const exists = context.store.db
      .prepare(
        "SELECT 1 AS present FROM runtime_generation_errors WHERE artifact_id=?",
      )
      .get(artifact.artifact_id);
    if (!exists) return false;
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "clear_artifact_failure",
        artifactId: artifact.artifact_id,
        writeSet: [`artifact-runtime:${artifact.artifact_id}`],
      },
      ["artifact_events"],
      (operationId, now) => {
        context.store.db
          .prepare(
            "DELETE FROM runtime_generation_errors WHERE artifact_id=?",
          )
          .run(artifact.artifact_id);
        context.store.db
          .prepare(
            `UPDATE runtime_artifact_views
             SET status='ready', meta_json='{}', owner_id=NULL,
                 owner_kind=NULL, pid=NULL, deadline_at=NULL,
                 updated_at=?
             WHERE artifact_id=?`,
          )
          .run(now, artifact.artifact_id);
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'failure_cleared', '{}', ?)`,
          )
          .run(uuidv7(), artifact.artifact_id, operationId, now);
      },
    );
    return ok(true, mutation.revision);
  });
}

function updateCompleting(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
  completing: boolean,
): Result<boolean, EngineError> {
  return syncResultOf(() => {
    const projectId = context.projectRow(projectReference).project_id;
    const artifactId = context.artifactRow(
      projectId,
      artifactReference,
    ).artifact_id;
    return context.store.runtime(() => {
      return (
        context.store.db
          .prepare(
            `UPDATE runtime_pending_tasks
             SET completing=?
             WHERE artifact_id=?`,
          )
          .run(completing ? 1 : 0, artifactId).changes > 0
      );
    });
  });
}

function recoverArtifact(
  context: EngineContext,
  projectReference: string,
  artifactReference: string,
): Result<void, EngineError> {
  return syncResultOf(() => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    context.store.runtime((now) => {
      context.store.db
        .prepare(
          `INSERT OR IGNORE INTO runtime_artifact_views(
            artifact_id, project_id, status, meta_json, updated_at
          ) VALUES (?, ?, 'ready', '{}', ?)`,
        )
        .run(artifact.artifact_id, project.project_id, now);
    });
  });
}

function recoverAll(
  context: EngineContext,
  projectReference: string,
): Result<{ recovered: number }, EngineError> {
  return syncResultOf(() => {
    const projectId = context.projectRow(projectReference).project_id;
    const artifacts = context.store.db
      .prepare(
        `SELECT artifact_id FROM artifacts
         WHERE project_id=? AND deleted_at IS NULL`,
      )
      .all(projectId) as unknown as Array<{ artifact_id: string }>;
    const recovered = context.store.runtime((now) => {
      let count = 0;
      for (const artifact of artifacts) {
        count += context.store.db
          .prepare(
            `INSERT OR IGNORE INTO runtime_artifact_views(
              artifact_id, project_id, status, meta_json, updated_at
            ) VALUES (?, ?, 'ready', '{}', ?)`,
          )
          .run(artifact.artifact_id, projectId, now).changes;
      }
      return count;
    });
    return { recovered };
  });
}

function startReaper(
  context: EngineContext,
  projectReference: string,
  options: { intervalMs: number },
): { stop: () => void } {
  const projectId = context.projectRow(projectReference).project_id;
  const timer = setInterval(() => {
    context.store.runtime((now) => {
      context.store.db
        .prepare(
          `UPDATE runtime_resource_leases
           SET revoked_at=?, fence=fence+1
           WHERE project_id=? AND revoked_at IS NULL AND expires_at<=?`,
        )
        .run(now, projectId, now);
      context.store.db
        .prepare(
          `UPDATE runtime_artifact_views
           SET status='error',
               meta_json='{"error":{"message":"Work lease expired","code":"LEASE_EXPIRED"}}',
               owner_id=NULL, owner_kind=NULL, pid=NULL,
               deadline_at=NULL, updated_at=?, fence=fence+1
           WHERE project_id=? AND status='working'
             AND deadline_at IS NOT NULL AND deadline_at<=?`,
        )
        .run(now, projectId, now);
    });
  }, Math.max(50, options.intervalMs));
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function viewFromRow(
  context: EngineContext,
  row: ArtifactViewRow,
): ArtifactView {
  const artifact = context.artifactRowById(row.artifact_id);
  return {
    artifactId: row.artifact_id,
    slug: artifact.slug,
    status: row.status,
    meta: parseJson(row.meta_json, {}),
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    pid: row.pid,
    deadlineAt: row.deadline_at,
    updatedAt: row.updated_at,
    seenAt: row.seen_at,
  };
}

function pendingFromRow(
  context: EngineContext,
  row: PendingRow,
): PendingTask {
  const artifact = context.artifactRowById(row.artifact_id);
  return {
    artifactId: row.artifact_id,
    artifactSlug: artifact.slug,
    taskId: row.task_id,
    taskType: row.task_type,
    workspacePath: context.artifactPath(
      row.project_id,
      row.artifact_id,
    ),
    createdAt: row.created_at,
    meta: parseJson(row.meta_json, {}),
    completing: row.completing === 1,
    ownerId: row.owner_id,
  };
}

function failureFromRow(
  context: EngineContext,
  row: FailureRow,
): GenerationError {
  const artifact = context.artifactRowById(row.artifact_id);
  return {
    artifactId: row.artifact_id,
    artifactSlug: artifact.slug,
    message: row.message,
    ...(row.fail_code ? { failCode: row.fail_code } : {}),
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    failedAt: row.failed_at,
  };
}

function requiredPendingRow(
  context: EngineContext,
  artifactId: string,
): PendingRow {
  const row = context.store.db
    .prepare(`${PENDING_SELECT} WHERE artifact_id=?`)
    .get(artifactId) as unknown as PendingRow | undefined;
  if (!row) throw new Error(`Pending task not found: ${artifactId}`);
  return row;
}

function requiredLease(
  context: EngineContext,
  leaseId: string,
): LeaseRow {
  const row = context.store.db
    .prepare(`${LEASE_SELECT} WHERE lease_id=?`)
    .get(leaseId) as unknown as LeaseRow | undefined;
  if (!row) throw new Error(`Lease not found: ${leaseId}`);
  return row;
}

function lockFromRow(row: LeaseRow): LockData {
  return {
    id: row.lease_id,
    resource: row.resource_key,
    ownerId: row.owner_id,
    created_at: row.acquired_at,
    timeout_at: row.expires_at,
    ...(row.pid !== null ? { pid: row.pid } : {}),
    ...(row.state ? { state: row.state } : {}),
    data: parseJson(row.data_json, {}),
  };
}

function workspaceIdentity(
  context: EngineContext,
  resource: string,
): { projectId: string | null; artifactId: string | null } {
  const row = context.store.db
    .prepare(
      `SELECT project_id, artifact_id
       FROM runtime_workspace_entries
       WHERE ?=path OR ? LIKE path || '/%'
       ORDER BY length(path) DESC
       LIMIT 1`,
    )
    .get(resource, resource) as unknown as
    | { project_id: string; artifact_id: string }
    | undefined;
  return {
    projectId: row?.project_id ?? null,
    artifactId: row?.artifact_id ?? null,
  };
}

function resourceKey(input: string): string {
  const key = input.trim();
  if (!key) throw new Error("Lock resource is required");
  return key;
}

function settingKey(input: string): string {
  const key = input.trim();
  if (
    key.length === 0 ||
    key.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw new Error("Invalid runtime setting key");
  }
  return key;
}

function logName(input: string): string {
  const name = input.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new Error(`Invalid log name: ${input}`);
  }
  return name;
}

const VIEW_SELECT = `
  SELECT artifact_id, project_id, status, meta_json, owner_id,
         owner_kind, pid, deadline_at, updated_at, seen_at
  FROM runtime_artifact_views
`;

const PENDING_SELECT = `
  SELECT artifact_id, project_id, task_id, task_type, created_at,
         meta_json, completing, owner_id
  FROM runtime_pending_tasks
`;

const FAILURE_SELECT = `
  SELECT artifact_id, project_id, message, fail_code, prompt, failed_at
  FROM runtime_generation_errors
`;

const LEASE_SELECT = `
  SELECT lease_id, project_id, artifact_id, resource_key, owner_id,
         pid, state, data_json, fence, acquired_at, expires_at
  FROM runtime_resource_leases
`;
