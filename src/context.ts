import { mkdirSync } from "node:fs";
import * as path from "node:path";

import type {
  Artifact,
  ArtifactKind,
  EngineConfig,
  EngineError,
  Project,
  Result,
} from "./engine-types.js";
import { err } from "./engine-types.js";
import { ObjectStore } from "./cas.js";
import { DoltStore, EngineFault, parseJson } from "./store.js";

export interface ProjectRow {
  project_id: string;
  slug: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ArtifactRow {
  artifact_id: string;
  project_id: string;
  slug: string;
  kind: ArtifactKind;
  data_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface FileRow {
  artifact_id: string;
  path: string;
  object_hash: string;
  size_bytes: number;
  mime_type: string | null;
  mtime_ms: number;
  created_at: number;
}

export class EngineContext {
  readonly store: DoltStore;
  readonly objects: ObjectStore;
  readonly config: EngineConfig;

  constructor(config: EngineConfig) {
    const storage =
      config.rootDir !== undefined
        ? {
            dataDir: path.join(path.resolve(config.rootDir), "data"),
            workspaceDir: path.join(
              path.resolve(config.rootDir),
              "workspaces",
            ),
          }
        : {
            dataDir: path.resolve(config.dataDir),
            workspaceDir: path.resolve(config.workspaceDir),
          };
    this.config = {
      ...config,
      ...storage,
      rootDir: undefined,
    };
    if (storage.dataDir === storage.workspaceDir) {
      throw new EngineFault({
        code: "INVALID_INPUT",
        message: "dataDir and workspaceDir must be different directories",
      });
    }
    this.store = new DoltStore({
      dataDir: this.config.dataDir,
      workspaceDir: this.config.workspaceDir,
      ...(config.catalogBackup
        ? { catalogBackup: config.catalogBackup }
        : {}),
    });
    this.objects = new ObjectStore(
      this.store.objectsDir,
      config.remoteObjects,
      config.objectPrefix,
    );
  }

  projectRow(reference: string, includeDeleted = false): ProjectRow {
    const row = this.store.db
      .prepare(
        `SELECT project_id, slug, created_at, updated_at, deleted_at
         FROM projects
         WHERE (project_id = ? OR slug = ?)
           ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(reference, reference, reference) as unknown as
      | ProjectRow
      | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Project not found: ${reference}`,
      });
    }
    return row;
  }

  artifactRow(
    projectId: string,
    reference: string,
    includeDeleted = false,
  ): ArtifactRow {
    const deletedClause = includeDeleted
      ? "AND (artifact_id = ? OR (slug = ? AND deleted_at IS NULL))"
      : "AND deleted_at IS NULL AND (artifact_id = ? OR slug = ?)";
    const row = this.store.db
      .prepare(
        `SELECT artifact_id, project_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM artifacts
         WHERE project_id = ?
           ${deletedClause}
         ORDER BY CASE WHEN artifact_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(projectId, reference, reference, reference) as unknown as
      | ArtifactRow
      | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Artifact not found: ${reference}`,
      });
    }
    return row;
  }

  artifactRowById(artifactId: string): ArtifactRow {
    const row = this.store.db
      .prepare(
        `SELECT artifact_id, project_id, slug, kind, data_json,
                created_at, updated_at, deleted_at
         FROM artifacts
         WHERE artifact_id = ?`,
      )
      .get(artifactId) as unknown as ArtifactRow | undefined;
    if (!row) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: `Artifact not found: ${artifactId}`,
      });
    }
    return row;
  }

  project(row: ProjectRow): Project {
    return {
      projectId: row.project_id,
      slug: row.slug,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      path: this.projectPath(row.project_id),
      isDefault: this.defaultProjectId() === row.project_id,
    };
  }

  artifact(row: ArtifactRow): Artifact {
    return {
      artifactId: row.artifact_id,
      projectId: row.project_id,
      slug: row.slug,
      kind: row.kind,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      path: this.artifactPath(row.project_id, row.artifact_id),
    };
  }

  projectPath(projectId: string): string {
    return path.join(this.store.workspaceDir, projectId);
  }

  artifactPath(projectId: string, artifactId: string): string {
    return path.join(this.projectPath(projectId), artifactId);
  }

  ensureProjectWorkspace(projectId: string): string {
    const workspace = this.projectPath(projectId);
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  ensureArtifactWorkspace(projectId: string, artifactId: string): string {
    const workspace = this.artifactPath(projectId, artifactId);
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  defaultProjectId(): string | null {
    const row = this.store.db
      .prepare(
        "SELECT value_json FROM runtime_settings WHERE key='default_project_id'",
      )
      .get() as unknown as { value_json: string } | undefined;
    return row
      ? parseJson<string | null>(row.value_json, null)
      : null;
  }

  setDefaultProjectId(projectId: string | null): void {
    this.store.runtime((now) => {
      this.store.db
        .prepare(
          `INSERT INTO runtime_settings(key, value_json, updated_at)
           VALUES ('default_project_id', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value_json=excluded.value_json,
             updated_at=excluded.updated_at`,
        )
        .run(JSON.stringify(projectId), now);
    });
  }

  close(): void {
    this.store.close();
  }
}

function toError(error: unknown): EngineError {
  if (error instanceof EngineFault) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("artifacts_active_slug") ||
    message.includes("projects_active_slug") ||
    message.includes("UNIQUE constraint failed")
  ) {
    return { code: "SLUG_CONFLICT", message };
  }
  if (/object unavailable/i.test(message)) {
    return { code: "OBJECT_UNAVAILABLE", message };
  }
  if (
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ||
    /not found/i.test(message)
  ) {
    return { code: "NOT_FOUND", message };
  }
  if (/already exists/i.test(message)) {
    return { code: "ALREADY_EXISTS", message };
  }
  if (/\blocked\b|is locked/i.test(message)) {
    return { code: "LOCKED", message };
  }
  if (
    /invalid|required|must |only terminal|outside the artifact workspace/i.test(
      message,
    )
  ) {
    return { code: "INVALID_INPUT", message };
  }
  return { code: "IO_ERROR", message };
}

export async function resultOf<T>(
  work: () => Promise<Result<T, EngineError> | T>,
): Promise<Result<T, EngineError>> {
  try {
    const value = await work();
    if (
      typeof value === "object" &&
      value !== null &&
      "ok" in value
    ) {
      return value as Result<T, EngineError>;
    }
    return { ok: true, value: value as T };
  } catch (error) {
    return err(toError(error));
  }
}

export function syncResultOf<T>(work: () => T): Result<T, EngineError> {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    return err(toError(error));
  }
}
