import { rm } from "node:fs/promises";

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
import { EngineFault } from "./store.js";
import { newUuidV7 } from "./ids.js";

interface ActiveRuntimeJobRow {
  id: number;
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
    ): Promise<Result<Artifact, EngineError>> =>
      createArtifact(context, input, name),
    list: (options?: { sort?: "newest" | "oldest" }): Artifact[] =>
      listArtifacts(context, options),
    get: (artifact: string): Result<Artifact, EngineError> =>
      syncResultOf(() => context.artifact(context.artifactRow(artifact))),
    resolveSlug: (slug: string): Result<Artifact, EngineError> =>
      syncResultOf(() => {
        const row = context.store.db
          .prepare(
            `SELECT artifact_id, slug, kind, created_at
             FROM artifacts
             WHERE slug=?`,
          )
          .get(slug) as unknown as ArtifactRow | undefined;
        if (!row) throw new Error(`Active artifact slug not found: ${slug}`);
        return context.artifact(row);
      }),
    isSlugAvailable: (slug: string): boolean =>
      !context.store.db
        .prepare(
          `SELECT 1 AS present
           FROM artifacts
           WHERE slug=?`,
        )
        .get(slug),
    rename: (
      input: RenameArtifactInput | string,
      name?: string,
    ): Promise<Result<Artifact, EngineError>> =>
      renameArtifact(context, input, name),
    delete: (
      artifact: string,
    ): Promise<
      Result<
        { artifactId: string; slug: string },
        EngineError
      >
    > => deleteArtifact(context, artifact),
  };
}

async function createArtifact(
  context: EngineContext,
  input: CreateArtifactInput | string,
  positionalName?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? {
            kind: normalizeKind(input),
            name: positionalName ?? "",
            explicitSlug: undefined,
          }
        : {
            kind: normalizeKind(input.kind),
            name: input.name ?? input.slug ?? "",
            explicitSlug: input.slug,
          };
    const base = artifactSlug(parsed.kind, parsed.explicitSlug ?? parsed.name);
    const slug =
      parsed.explicitSlug === undefined
        ? nextActiveSlug(context, base)
        : base;
    const artifactId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "create_artifact",
        artifactId,
        details: { slug, kind: parsed.kind },
        writeSet: [
          `artifact:${artifactId}`,
          `artifact-slug:${slug}`,
        ],
      },
      ["artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, slug, kind, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(artifactId, slug, parsed.kind, now);
        context.store.db
          .prepare(
            `INSERT INTO runtime_artifact_views(
              artifact_id, status, meta_json, deadline_at, updated_at
            ) VALUES (?, 'pending', '{}', ?, ?)`,
          )
          .run(artifactId, now + 30_000, now);
        context.store.db
          .prepare(
            `INSERT INTO runtime_workspace_entries(
              artifact_id, path, last_accessed_at
            ) VALUES (?, ?, ?)`,
          )
          .run(artifactId, context.artifactPath(artifactId), now);
      },
    );
    context.ensureArtifactWorkspace(artifactId);
    return ok(context.artifact(context.artifactRow(artifactId)), mutation.revision);
  });
}

function listArtifacts(
  context: EngineContext,
  options: { sort?: "newest" | "oldest" } = {},
): Artifact[] {
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, slug, kind, created_at
       FROM artifacts
       ORDER BY created_at ${direction}, artifact_id ${direction}`,
    )
    .all() as unknown as ArtifactRow[];
  return rows.map((row) => context.artifact(row));
}

async function renameArtifact(
  context: EngineContext,
  input: RenameArtifactInput | string,
  positionalName?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? { artifact: input, name: positionalName ?? "", slug: undefined }
        : input;
    const current = context.artifactRow(parsed.artifact);
    const slug = artifactSlug(current.kind, parsed.slug ?? parsed.name ?? "");
    if (slug === current.slug) return context.artifact(current);
    const mutation = await context.store.semantic(
      {
        operation: "rename_artifact",
        artifactId: current.artifact_id,
        details: { oldSlug: current.slug, newSlug: slug },
        writeSet: [
          `artifact:${current.artifact_id}`,
          `artifact-slug:${current.slug}`,
          `artifact-slug:${slug}`,
        ],
      },
      ["artifacts"],
      () => {
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET slug=?
             WHERE artifact_id=?`,
          )
          .run(slug, current.artifact_id);
      },
    );
    return ok(context.artifact(context.artifactRow(current.artifact_id)), mutation.revision);
  });
}

async function deleteArtifact(
  context: EngineContext,
  artifactReference: string,
): Promise<
  Result<{ artifactId: string; slug: string }, EngineError>
> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const references = artifactReferences(context, artifact.artifact_id);
    if (references.length > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message: `Artifact is still referenced: ${artifact.slug}`,
        details: { references },
      });
    }
    const jobs = context.store.db
      .prepare(
        `SELECT id, artifact_id, type, payload_json, result_json, started_at
         FROM runtime_jobs
         WHERE artifact_id=?
           AND state IN ('queued','running','completing')`,
      )
      .all(artifact.artifact_id) as unknown as ActiveRuntimeJobRow[];
    const mutation = await context.store.semantic(
      {
        operation: "delete_artifact",
        artifactId: artifact.artifact_id,
        details: {
          slug: artifact.slug,
          cancelledJobs: jobs.map((job) => job.id),
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `artifact-slug:${artifact.slug}`,
        ],
      },
      [
        "artifacts",
        "artifact_files",
        "artifact_metadata",
        "audio_waveforms",
        "job_runs",
      ],
      (_operationId, now) => {
        context.store.db
          .prepare("DELETE FROM artifacts WHERE artifact_id=?")
          .run(artifact.artifact_id);
        for (const job of jobs) {
          const errorJson = canonicalJson({ message: "Artifact deleted" });
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
                run_id, artifact_id, job_type, state,
                payload_json, result_json, error_json,
                started_at, finished_at
              ) VALUES (?, ?, ?, 'aborted', ?, ?, ?, ?, ?)`,
            )
            .run(
              newUuidV7(),
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
          .prepare("DELETE FROM runtime_workspace_entries WHERE artifact_id=?")
          .run(artifact.artifact_id);
        context.store.db
          .prepare("DELETE FROM runtime_artifact_views WHERE artifact_id=?")
          .run(artifact.artifact_id);
        context.store.db
          .prepare("DELETE FROM runtime_pending_tasks WHERE artifact_id=?")
          .run(artifact.artifact_id);
        context.store.db
          .prepare("DELETE FROM runtime_generation_errors WHERE artifact_id=?")
          .run(artifact.artifact_id);
        context.store.db
          .prepare("DELETE FROM runtime_similarity_embeddings WHERE artifact_id=?")
          .run(artifact.artifact_id);
        context.store.db
          .prepare(
            "DELETE FROM runtime_text_similarity_documents WHERE artifact_id=?",
          )
          .run(artifact.artifact_id);
      },
    );
    await rm(context.artifactPath(artifact.artifact_id), {
      recursive: true,
      force: true,
    });
    return ok(
      {
        artifactId: artifact.artifact_id,
        slug: artifact.slug,
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
    case "final":
      return "final";
    default:
      throw new Error(`Invalid artifact kind: ${input}`);
  }
}

/** Normalizes a name or slug with the canonical prefix for its artifact kind. */
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
  const knownPrefix = /^(vid|img|aud|script|char|prompt|scene|prm|scn)-/;
  if (knownPrefix.test(normalized)) {
    if (!normalized.startsWith(`${prefix}-`)) {
      throw new Error(`Artifact slug ${normalized} does not match kind ${kind}`);
    }
    return normalized;
  }
  normalized = `${prefix}-${normalized}`;
  if (!/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(`Invalid artifact slug: ${normalized}`);
  }
  return normalized;
}

function nextActiveSlug(context: EngineContext, base: string): string {
  let suffix = 1;
  let candidate = base;
  while (
    context.store.db
      .prepare(
        `SELECT 1 AS present
         FROM artifacts
         WHERE slug=?`,
      )
      .get(candidate)
  ) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function artifactReferences(
  context: EngineContext,
  artifactId: string,
): Array<{ kind: string; id: string }> {
  const references: Array<{ kind: string; id: string }> = [];
  const cells = context.store.db
    .prepare(
      `SELECT notebook_id, cell_id FROM cells
       WHERE output_artifact_id=? ORDER BY notebook_id, cell_id`,
    )
    .all(artifactId) as unknown as Array<{
    notebook_id: string;
    cell_id: string;
  }>;
  references.push(
    ...cells.map((cell) => ({
      kind: "cell.outputArtifact",
      id: `${cell.notebook_id}/${cell.cell_id}`,
    })),
  );
  const slots = context.store.db
    .prepare(
      "SELECT slot_id FROM timeline_slots WHERE artifact_id=? ORDER BY slot_id",
    )
    .all(artifactId) as unknown as Array<{ slot_id: string }>;
  references.push(
    ...slots.map((slot) => ({ kind: "timeline.slot", id: slot.slot_id })),
  );
  const audio = context.store.db
    .prepare(
      "SELECT audio_id FROM timeline_audio WHERE artifact_id=? ORDER BY audio_id",
    )
    .all(artifactId) as unknown as Array<{ audio_id: string }>;
  references.push(
    ...audio.map((item) => ({ kind: "timeline.audio", id: item.audio_id })),
  );
  return references;
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
      return "prompt";
    case "scene":
      return "scene";
    case "final":
      return "final";
  }
}
