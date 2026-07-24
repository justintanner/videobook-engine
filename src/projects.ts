import { rm } from "node:fs/promises";

import { v7 as uuidv7 } from "uuid";

import type {
  EngineError,
  Project,
  Result,
} from "./engine-types.js";
import { err, ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  syncResultOf,
  type ProjectRow,
} from "./context.js";
import { canonicalJson, EngineFault } from "./store.js";

interface RuntimeJobRow {
  id: number;
  project_id: string;
  artifact_id: string | null;
  type: string;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  started_at: number | null;
}

export function createProjectsApi(context: EngineContext) {
  return {
    create: (slug?: string): Promise<Result<Project, EngineError>> =>
      createProject(context, slug),
    list: (options?: {
      sort?: "newest" | "oldest";
    }): Project[] => listProjects(context, options),
    get: (reference?: string): Result<Project, EngineError> =>
      getProject(context, reference),
    switch: (reference: string): Result<Project, EngineError> =>
      switchProject(context, reference),
    rename: (
      reference: string,
      slug: string,
    ): Promise<Result<Project, EngineError>> =>
      renameProject(context, reference, slug),
    delete: (
      reference: string,
    ): Promise<
      Result<
        {
          projectId: string;
          slug: string;
          deletedAt: number;
          defaultProjectId: string | null;
        },
        EngineError
      >
    > => deleteProject(context, reference),
  };
}

async function createProject(
  context: EngineContext,
  requestedSlug?: string,
): Promise<Result<Project, EngineError>> {
  return resultOf(async () => {
    const slug = requestedSlug
      ? normalizeProjectSlug(requestedSlug)
      : `project-${uuidv7().slice(0, 8)}`;
    const projectId = uuidv7();
    const mutation = await context.store.semantic(
      {
        projectId,
        operation: "create_project",
        details: { slug },
        writeSet: [`project:${projectId}`, `project-slug:${slug}`],
      },
      ["projects"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO projects(
              project_id, slug, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(projectId, slug, now, now);
        return now;
      },
    );
    context.ensureProjectWorkspace(projectId);
    if (!context.defaultProjectId()) context.setDefaultProjectId(projectId);
    return ok(
      context.project(context.projectRow(projectId)),
      mutation.revision,
    );
  });
}

function listProjects(
  context: EngineContext,
  options: { sort?: "newest" | "oldest" } = {},
): Project[] {
  const direction = options.sort === "oldest" ? "ASC" : "DESC";
  const rows = context.store.db
    .prepare(
      `SELECT project_id, slug, created_at, updated_at, deleted_at
       FROM projects
       WHERE deleted_at IS NULL
       ORDER BY updated_at ${direction}, project_id ${direction}`,
    )
    .all() as unknown as ProjectRow[];
  return rows.map((row) => context.project(row));
}

function getProject(
  context: EngineContext,
  reference?: string,
): Result<Project, EngineError> {
  return syncResultOf(() => {
    const resolved =
      reference ??
      context.defaultProjectId() ??
      listProjects(context, { sort: "oldest" })[0]?.projectId;
    if (!resolved) {
      throw new EngineFault({
        code: "NOT_FOUND",
        message: "No active project found",
      });
    }
    return context.project(context.projectRow(resolved));
  });
}

function switchProject(
  context: EngineContext,
  reference: string,
): Result<Project, EngineError> {
  return syncResultOf(() => {
    const project = context.project(context.projectRow(reference));
    context.setDefaultProjectId(project.projectId);
    return { ...project, isDefault: true };
  });
}

async function renameProject(
  context: EngineContext,
  reference: string,
  requestedSlug: string,
): Promise<Result<Project, EngineError>> {
  return resultOf(async () => {
    const row = context.projectRow(reference);
    const slug = normalizeProjectSlug(requestedSlug);
    if (row.slug === slug) return context.project(row);
    const mutation = await context.store.semantic(
      {
        projectId: row.project_id,
        operation: "rename_project",
        details: { oldSlug: row.slug, newSlug: slug },
        writeSet: [
          `project:${row.project_id}`,
          `project-slug:${row.slug}`,
          `project-slug:${slug}`,
        ],
      },
      ["projects"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            "UPDATE projects SET slug=?, updated_at=? WHERE project_id=?",
          )
          .run(slug, now, row.project_id);
      },
    );
    return ok(
      context.project(context.projectRow(row.project_id)),
      mutation.revision,
    );
  });
}

async function deleteProject(
  context: EngineContext,
  reference: string,
): Promise<
  Result<
    {
      projectId: string;
      slug: string;
      deletedAt: number;
      defaultProjectId: string | null;
    },
    EngineError
  >
> {
  return resultOf(async () => {
    const project = context.projectRow(reference);
    const jobs = context.store.db
      .prepare(
        `SELECT id, project_id, artifact_id, type, payload_json, result_json,
                error_json, started_at
         FROM runtime_jobs
         WHERE project_id=?
           AND state IN ('queued','running','completing')`,
      )
      .all(project.project_id) as unknown as RuntimeJobRow[];
    const artifacts = context.store.db
      .prepare(
        `SELECT artifact_id
         FROM artifacts
         WHERE project_id=? AND deleted_at IS NULL`,
      )
      .all(project.project_id) as unknown as Array<{
      artifact_id: string;
    }>;
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "delete_project",
        details: {
          slug: project.slug,
          cancelledJobs: jobs.map((job) => job.id),
        },
        writeSet: [`project:${project.project_id}`],
      },
      ["projects", "artifacts", "artifact_events", "job_runs"],
      (operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE projects
             SET deleted_at=?, updated_at=?
             WHERE project_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, project.project_id);
        context.store.db
          .prepare(
            `UPDATE artifacts
             SET deleted_at=?, updated_at=?
             WHERE project_id=? AND deleted_at IS NULL`,
          )
          .run(now, now, project.project_id);
        for (const artifact of artifacts) {
          context.store.db
            .prepare(
              `INSERT INTO artifact_events(
                event_id, artifact_id, operation_id, event,
                details_json, created_at
              ) VALUES (?, ?, ?, 'deleted_with_project', '{}', ?)`,
            )
            .run(uuidv7(), artifact.artifact_id, operationId, now);
        }
        for (const job of jobs) {
          const errorJson = canonicalJson({
            message: "Project deleted",
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
                payload_json, result_json, error_json, started_at, finished_at
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
             WHERE project_id=? AND revoked_at IS NULL`,
          )
          .run(now, project.project_id);
        context.store.db
          .prepare(
            `UPDATE runtime_workspace_entries
             SET invalidated_at=?
             WHERE project_id=?`,
          )
          .run(now, project.project_id);
        context.store.db
          .prepare(
            `DELETE FROM runtime_artifact_views WHERE project_id=?`,
          )
          .run(project.project_id);
        context.store.db
          .prepare(
            `DELETE FROM runtime_pending_tasks WHERE project_id=?`,
          )
          .run(project.project_id);
        return now;
      },
    );

    const currentDefault = context.defaultProjectId();
    let defaultProjectId = currentDefault;
    if (currentDefault === project.project_id) {
      defaultProjectId =
        listProjects(context, { sort: "oldest" })[0]?.projectId ?? null;
      context.setDefaultProjectId(defaultProjectId);
    }
    await rm(context.projectPath(project.project_id), {
      recursive: true,
      force: true,
    });
    return ok(
      {
        projectId: project.project_id,
        slug: project.slug,
        deletedAt: mutation.value,
        defaultProjectId,
      },
      mutation.revision,
    );
  });
}

export function normalizeProjectSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid project slug: ${input}`);
  }
  return slug;
}

export function isValidProjectSlug(input: string): boolean {
  try {
    return normalizeProjectSlug(input) === input;
  } catch {
    return false;
  }
}
