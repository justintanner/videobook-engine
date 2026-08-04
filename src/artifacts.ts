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
      label?: string,
    ): Promise<Result<Artifact, EngineError>> =>
      createArtifact(context, input, label),
    list: (options?: { sort?: "newest" | "oldest" }): Artifact[] =>
      listArtifacts(context, options),
    get: (artifactId: string): Result<Artifact, EngineError> =>
      syncResultOf(() => context.artifact(context.artifactRowById(artifactId))),
    rename: (
      input: RenameArtifactInput | string,
      label?: string,
    ): Promise<Result<Artifact, EngineError>> =>
      renameArtifact(context, input, label),
    delete: (
      artifactId: string,
    ): Promise<Result<{ artifactId: string }, EngineError>> =>
      deleteArtifact(context, artifactId),
  };
}

function normalizeLabel(input: string | undefined): string | null {
  const label = input?.trim();
  return label ? label : null;
}

async function createArtifact(
  context: EngineContext,
  input: CreateArtifactInput | string,
  positionalLabel?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? {
            kind: normalizeKind(input),
            label: normalizeLabel(positionalLabel),
          }
        : {
            kind: normalizeKind(input.kind),
            label: normalizeLabel(input.label),
          };
    const artifactId = newUuidV7();
    const mutation = await context.store.semantic(
      {
        operation: "create_artifact",
        tables: ["artifacts"],
        artifactId,
        details: {
          ...(parsed.label === null ? {} : { label: parsed.label }),
          kind: parsed.kind,
        },
        writeSet: [`artifact:${artifactId}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifacts(
              artifact_id, label, kind, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(artifactId, parsed.label, parsed.kind, now);
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
    return ok(context.artifact(context.artifactRowById(artifactId)), mutation.revision);
  });
}

function listArtifacts(
  context: EngineContext,
  options: { sort?: "newest" | "oldest" } = {},
): Artifact[] {
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, label, kind, created_at
       FROM artifacts
       ORDER BY created_at ${direction}, artifact_id ${direction}`,
    )
    .all() as unknown as ArtifactRow[];
  return rows.map((row) => context.artifact(row));
}

async function renameArtifact(
  context: EngineContext,
  input: RenameArtifactInput | string,
  positionalLabel?: string,
): Promise<Result<Artifact, EngineError>> {
  return resultOf(async () => {
    const parsed =
      typeof input === "string"
        ? { artifact: input, label: positionalLabel ?? "" }
        : input;
    const current = context.artifactRowById(parsed.artifact);
    const label = normalizeLabel(parsed.label);
    if (label === current.label) return context.artifact(current);
    const mutation = await context.store.semantic(
      {
        operation: "rename_artifact",
        tables: ["artifacts"],
        artifactId: current.artifact_id,
        details: {
          ...(current.label === null ? {} : { oldLabel: current.label }),
          ...(label === null ? {} : { newLabel: label }),
        },
        writeSet: [`artifact:${current.artifact_id}`],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET label=?
             WHERE artifact_id=?`,
          )
          .run(label, current.artifact_id);
      },
    );
    return ok(
      context.artifact(context.artifactRowById(current.artifact_id)),
      mutation.revision,
    );
  });
}

async function deleteArtifact(
  context: EngineContext,
  artifactId: string,
): Promise<Result<{ artifactId: string }, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRowById(artifactId);
    const references = artifactReferences(context, artifact.artifact_id);
    if (references.length > 0) {
      throw new EngineFault({
        code: "IN_USE",
        message: `Artifact is still referenced: ${artifact.artifact_id}`,
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
        tables: [
          "artifacts",
          "artifact_files",
          "artifact_metadata",
          "audio_waveforms",
        ],
        artifactId: artifact.artifact_id,
        details: {
          ...(artifact.label === null ? {} : { label: artifact.label }),
          cancelledJobs: jobs.map((job) => job.id),
        },
        writeSet: [`artifact:${artifact.artifact_id}`],
      },
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
    return ok({ artifactId: artifact.artifact_id }, mutation.revision);
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

function artifactReferences(
  context: EngineContext,
  artifactId: string,
): Array<{ kind: string; id: string }> {
  // Covers every RESTRICT foreign key targeting artifacts so a refused
  // delete surfaces as IN_USE rather than a raw FK error mapped to
  // IO_ERROR. CASCADE-owned rows (artifact_files, artifact_metadata,
  // audio_waveforms) are deleted with the artifact and are not listed.
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
  const streams = context.store.db
    .prepare(
      `SELECT stream_id FROM artifact_streams
       WHERE artifact_id=? ORDER BY stream_id`,
    )
    .all(artifactId) as unknown as Array<{ stream_id: string }>;
  references.push(
    ...streams.map((stream) => ({ kind: "stream", id: stream.stream_id })),
  );
  const transcripts = context.store.db
    .prepare(
      `SELECT transcript_id FROM transcripts
       WHERE artifact_id=? ORDER BY transcript_id`,
    )
    .all(artifactId) as unknown as Array<{ transcript_id: string }>;
  references.push(
    ...transcripts.map((row) => ({
      kind: "transcript",
      id: row.transcript_id,
    })),
  );
  const clips = context.store.db
    .prepare(
      `SELECT clip_id FROM sequence_clips
       WHERE artifact_id=? ORDER BY clip_id`,
    )
    .all(artifactId) as unknown as Array<{ clip_id: string }>;
  references.push(
    ...clips.map((clip) => ({ kind: "sequenceClip", id: clip.clip_id })),
  );
  const pinned = context.store.db
    .prepare(
      `SELECT notebook_id, cell_id, result_id FROM pinned_search_results
       WHERE artifact_id=? ORDER BY notebook_id, cell_id, result_id`,
    )
    .all(artifactId) as unknown as Array<{
    notebook_id: string;
    cell_id: string;
    result_id: string;
  }>;
  references.push(
    ...pinned.map((row) => ({
      kind: "pinnedSearchResult",
      id: `${row.notebook_id}/${row.cell_id}/${row.result_id}`,
    })),
  );
  return references;
}
