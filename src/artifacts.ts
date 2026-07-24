import { rm } from "node:fs/promises";

import { v7 as uuidv7 } from "uuid";

import type {
  Artifact,
  ArtifactKind,
  CreateArtifactInput,
  EngineError,
  RenameArtifactInput,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
  type ArtifactRow,
} from "./context.js";
import { canonicalJson } from "./store.js";

interface ActiveRuntimeJobRow {
  id: number;
  project_id: string;
  artifact_id: string | null;
  type: string;
  payload_json: string;
  result_json: string | null;
  started_at: number | null;
}

export function createArtifactsApi(context: EngineContext) {
  return {
    create: (
      input: CreateArtifactInput | string,
      name?: string,
      project?: string,
    ): Promise<Result<Artifact, EngineError>> =>
      createArtifact(context, input, name, project),
    list: (
      project: string,
      options?: { sort?: "newest" | "oldest" },
    ): Artifact[] => listArtifacts(context, project, options),
    get: (
      project: string,
      artifact: string,
    ): Result<Artifact, EngineError> =>
      syncResultOf(() =>
        context.artifact(
          context.artifactRow(
            context.projectRow(project).project_id,
            artifact,
          ),
        ),
      ),
    resolveSlug: (
      project: string,
      slug: string,
    ): Result<Artifact, EngineError> =>
      syncResultOf(() => {
        const projectId = context.projectRow(project).project_id;
        const row = context.store.db
          .prepare(
            `SELECT artifact_id, project_id, slug, kind, data_json,
                    created_at, updated_at, deleted_at
             FROM artifacts
             WHERE project_id=? AND slug=? AND deleted_at IS NULL`,
          )
          .get(projectId, slug) as unknown as ArtifactRow | undefined;
        if (!row) {
          throw new Error(`Active artifact slug not found: ${slug}`);
        }
        return context.artifact(row);
      }),
    isSlugAvailable: (project: string, slug: string): boolean => {
      const projectId = context.projectRow(project).project_id;
      return !context.store.db
        .prepare(
          `SELECT 1 AS present
           FROM artifacts
           WHERE project_id=? AND slug=? AND deleted_at IS NULL`,
        )
        .get(projectId, slug);
    },
    rename: (
      input: RenameArtifactInput | string,
      name?: string,
      project?: string,
    ): Promise<Result<Artifact, EngineError>> =>
      renameArtifact(context, input, name, project),
    delete: (
      artifact: string,
      project: string,
    ): Promise<
      Result<
        {
          artifactId: string;
          slug: string;
          deletedAt: number;
        },
        EngineError
      >
    > => deleteArtifact(context, artifact, project),
  };
}

async function createArtifact(
  context: EngineContext,
  input: CreateArtifactInput | string,
  positionalName?: string,
  positionalProject?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? {
            kind: normalizeKind(input),
            name: positionalName ?? "",
            project: positionalProject ?? "",
            explicitSlug: undefined,
          }
        : {
            kind: normalizeKind(input.kind),
            name: input.name ?? input.slug ?? "",
            project: input.project,
            explicitSlug: input.slug,
          };
    const project = context.projectRow(parsed.project);
    const base = artifactSlug(
      parsed.kind,
      parsed.explicitSlug ?? parsed.name,
    );
    const slug =
      parsed.explicitSlug === undefined
        ? nextActiveSlug(context, project.project_id, base)
        : base;
    const artifactId = uuidv7();
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "create_artifact",
        artifactId,
        details: { slug, kind: parsed.kind },
        writeSet: [
          `artifact:${artifactId}`,
          `artifact-slug:${project.project_id}:${slug}`,
        ],
      },
      ["artifacts", "artifact_events"],
      (operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, project_id, slug, kind, data_json,
              created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, '{}', ?, ?, NULL)`,
          )
          .run(
            artifactId,
            project.project_id,
            slug,
            parsed.kind,
            now,
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'created', ?, ?)`,
          )
          .run(
            uuidv7(),
            artifactId,
            operationId,
            canonicalJson({ slug, kind: parsed.kind }),
            now,
          );
        context.store.db
          .prepare(
            `INSERT INTO runtime_artifact_views(
              artifact_id, project_id, status, meta_json,
              deadline_at, updated_at
            ) VALUES (?, ?, 'pending', '{}', ?, ?)`,
          )
          .run(artifactId, project.project_id, now + 30_000, now);
        context.store.db
          .prepare(
            `INSERT INTO runtime_workspace_entries(
              artifact_id, project_id, path, last_accessed_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            artifactId,
            project.project_id,
            context.artifactPath(project.project_id, artifactId),
            now,
          );
      },
    );
    context.ensureArtifactWorkspace(project.project_id, artifactId);
    return ok(
      context.artifact(
        context.artifactRow(project.project_id, artifactId),
      ),
      mutation.revision,
    );
  });
}

function listArtifacts(
  context: EngineContext,
  projectReference: string,
  options: { sort?: "newest" | "oldest" } = {},
): Artifact[] {
  const project = context.projectRow(projectReference);
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, project_id, slug, kind, data_json,
              created_at, updated_at, deleted_at
       FROM artifacts
       WHERE project_id=? AND deleted_at IS NULL
       ORDER BY created_at ${direction}, artifact_id ${direction}`,
    )
    .all(project.project_id) as unknown as ArtifactRow[];
  return rows.map((row) => context.artifact(row));
}

async function renameArtifact(
  context: EngineContext,
  input: RenameArtifactInput | string,
  positionalName?: string,
  positionalProject?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? {
            artifact: input,
            name: positionalName ?? "",
            slug: undefined,
            project: positionalProject ?? "",
          }
        : input;
    const project = context.projectRow(parsed.project);
    const current = context.artifactRow(
      project.project_id,
      parsed.artifact,
    );
    const slug = artifactSlug(
      current.kind,
      parsed.slug ?? parsed.name ?? "",
    );
    if (slug === current.slug) return context.artifact(current);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "rename_artifact",
        artifactId: current.artifact_id,
        details: { oldSlug: current.slug, newSlug: slug },
        writeSet: [
          `artifact:${current.artifact_id}`,
          `artifact-slug:${project.project_id}:${current.slug}`,
          `artifact-slug:${project.project_id}:${slug}`,
        ],
      },
      ["artifacts", "artifact_events"],
      (operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET slug=?, updated_at=?
             WHERE artifact_id=? AND deleted_at IS NULL`,
          )
          .run(slug, now, current.artifact_id);
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'renamed', ?, ?)`,
          )
          .run(
            uuidv7(),
            current.artifact_id,
            operationId,
            canonicalJson({ oldSlug: current.slug, newSlug: slug }),
            now,
          );
      },
    );
    return ok(
      context.artifact(
        context.artifactRow(project.project_id, current.artifact_id),
      ),
      mutation.revision,
    );
  });
}

async function deleteArtifact(
  context: EngineContext,
  artifactReference: string,
  projectReference: string,
): Promise<
  Result<
    { artifactId: string; slug: string; deletedAt: number },
    EngineError
  >
> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const jobs = context.store.db
      .prepare(
        `SELECT id, project_id, artifact_id, type, payload_json, result_json,
                started_at
         FROM runtime_jobs
         WHERE artifact_id=?
           AND state IN ('queued','running','completing')`,
      )
      .all(artifact.artifact_id) as unknown as ActiveRuntimeJobRow[];
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "delete_artifact",
        artifactId: artifact.artifact_id,
        details: {
          slug: artifact.slug,
          cancelledJobs: jobs.map((job) => job.id),
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `artifact-slug:${project.project_id}:${artifact.slug}`,
        ],
      },
      ["artifacts", "artifact_events", "job_runs"],
      (operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET deleted_at=?, updated_at=?
             WHERE artifact_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, artifact.artifact_id);
        context.store.db
          .prepare(
            `INSERT INTO artifact_events(
              event_id, artifact_id, operation_id, event,
              details_json, created_at
            ) VALUES (?, ?, ?, 'deleted', ?, ?)`,
          )
          .run(
            uuidv7(),
            artifact.artifact_id,
            operationId,
            canonicalJson({ slug: artifact.slug }),
            now,
          );
        for (const job of jobs) {
          const errorJson = canonicalJson({
            message: "Artifact deleted",
          });
          context.store.db
            .prepare(
              `UPDATE runtime_jobs
               SET state='aborted', error_json=?, finished_at=?,
                   lease_expires_at=NULL, pid=NULL, fence=fence+1
               WHERE id=?`,
            )
            .run(errorJson, now, job.id);
          context.store.db
            .prepare(
              `INSERT INTO job_runs(
                run_id, project_id, artifact_id, job_type, state,
                payload_json, result_json, error_json,
                started_at, finished_at
              ) VALUES (?, ?, ?, ?, 'aborted', ?, ?, ?, ?, ?)`,
            )
            .run(
              uuidv7(),
              job.project_id,
              job.artifact_id,
              job.type,
              job.payload_json,
              job.result_json,
              errorJson,
              job.started_at,
              now,
            );
        }
        context.store.db
          .prepare(
            `UPDATE runtime_resource_leases
             SET revoked_at=?, fence=fence+1
             WHERE artifact_id=? AND revoked_at IS NULL`,
          )
          .run(now, artifact.artifact_id);
        context.store.db
          .prepare(
            `UPDATE runtime_workspace_entries
             SET invalidated_at=?
             WHERE artifact_id=?`,
          )
          .run(now, artifact.artifact_id);
        context.store.db
          .prepare(
            "DELETE FROM runtime_artifact_views WHERE artifact_id=?",
          )
          .run(artifact.artifact_id);
        context.store.db
          .prepare(
            "DELETE FROM runtime_pending_tasks WHERE artifact_id=?",
          )
          .run(artifact.artifact_id);
        return now;
      },
    );
    await rm(
      context.artifactPath(project.project_id, artifact.artifact_id),
      { recursive: true, force: true },
    );
    return ok(
      {
        artifactId: artifact.artifact_id,
        slug: artifact.slug,
        deletedAt: mutation.value,
      },
      mutation.revision,
    );
  });
}

export function normalizeKind(input: string): ArtifactKind {
  switch (input.trim().toLowerCase()) {
    case "vid":
    case "video":
      return "video";
    case "img":
    case "image":
      return "image";
    case "aud":
    case "audio":
      return "audio";
    case "script":
    case "scr":
      return "script";
    case "char":
    case "character":
      return "character";
    case "prm":
    case "prompt":
      return "prompt";
    case "scn":
    case "scene":
      return "scene";
    case "nb":
    case "notebook":
      return "notebook";
    case "final":
      return "final";
    default:
      throw new Error(`Invalid artifact kind: ${input}`);
  }
}

export function artifactSlug(kind: ArtifactKind, input: string): string {
  if (kind === "final") return "final";
  const prefix = prefixForKind(kind);
  let normalized = input
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!normalized) throw new Error("Artifact name or slug is required");
  const knownPrefix = /^(vid|img|aud|script|char|prm|scn|nb)-/;
  if (knownPrefix.test(normalized)) {
    if (!normalized.startsWith(`${prefix}-`)) {
      throw new Error(
        `Artifact slug ${normalized} does not match kind ${kind}`,
      );
    }
    return normalized;
  }
  normalized = `${prefix}-${normalized}`;
  if (!/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid artifact slug: ${normalized}`);
  }
  return normalized;
}

function nextActiveSlug(
  context: EngineContext,
  projectId: string,
  base: string,
): string {
  let suffix = 1;
  let candidate = base;
  while (
    context.store.db
      .prepare(
        `SELECT 1 AS present
         FROM artifacts
         WHERE project_id=? AND slug=? AND deleted_at IS NULL`,
      )
      .get(projectId, candidate)
  ) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function prefixForKind(kind: ArtifactKind): string {
  switch (kind) {
    case "video":
      return "vid";
    case "image":
      return "img";
    case "audio":
      return "aud";
    case "script":
      return "script";
    case "character":
      return "char";
    case "prompt":
      return "prm";
    case "scene":
      return "scn";
    case "notebook":
      return "nb";
    case "final":
      return "final";
  }
}
