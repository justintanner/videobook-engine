import {
  mkdir,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import * as path from "node:path";

import type {
  ArtifactManifest,
  ArtifactManifestFile,
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import {
  EngineContext,
  resultOf,
  type FileRow,
} from "./context.js";
import { canonicalJson } from "./store.js";

interface PreparedFile {
  relativePath: string;
  objectHash: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
}

export function createFilesApi(context: EngineContext) {
  return {
    write: (
      artifact: string,
      filename: string,
      data: Buffer | string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      writeFile(context, artifact, filename, data, project),
    writeFromPath: (
      artifact: string,
      filename: string,
      sourcePath: string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      writeFromPath(context, artifact, filename, sourcePath, project),
    read: (
      artifact: string,
      filename: string,
      project: string,
    ): Promise<Result<Buffer, EngineError>> =>
      readFile(context, artifact, filename, project),
    delete: (
      artifact: string,
      filename: string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      deleteFile(context, artifact, filename, project),
    rename: (
      artifact: string,
      oldFilename: string,
      newFilename: string,
      project: string,
    ): Promise<
      Result<{ oldPath: string; newPath: string }, EngineError>
    > =>
      renameFile(
        context,
        artifact,
        oldFilename,
        newFilename,
        project,
      ),
    copy: (
      artifact: string,
      filename: string,
      destinationArtifact: string,
      destinationFilename: string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      copyFile(
        context,
        artifact,
        filename,
        destinationArtifact,
        destinationFilename,
        project,
      ),
    manifest: (
      artifact: string,
      project: string,
      options?: { includeDotfiles?: boolean },
    ): Promise<Result<ArtifactManifest, EngineError>> =>
      manifest(context, artifact, project, options),
    listSubdir: (
      artifact: string,
      subdir: string,
      project: string,
    ): Result<string[], EngineError> =>
      listSubdir(context, artifact, subdir, project),
    ingestWorkspace: (
      artifact: string,
      paths: string[],
      project: string,
      operation = "ingest_workspace",
      details: Record<string, unknown> = {},
    ): Promise<Result<string, EngineError>> =>
      ingestWorkspace(
        context,
        artifact,
        paths,
        project,
        operation,
        details,
      ),
    readAtRevision: (
      artifactId: string,
      filename: string,
      revision: string,
    ): Promise<Result<Buffer, EngineError>> =>
      readAtRevision(context, artifactId, filename, revision),
    importObject: (sourcePath: string) => context.objects.import(sourcePath),
  };
}

export function createWorkspacesApi(context: EngineContext) {
  return {
    resolveArtifact: (
      artifact: string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      resolveArtifactWorkspace(context, artifact, project),
    materialize: (
      artifact: string,
      project: string,
    ): Promise<Result<string, EngineError>> =>
      resolveArtifactWorkspace(context, artifact, project),
    evict: (
      artifact: string,
      project: string,
    ): Promise<Result<boolean, EngineError>> =>
      evictWorkspace(context, artifact, project),
  };
}

async function writeFile(
  context: EngineContext,
  artifactReference: string,
  filename: string,
  data: Buffer | string,
  projectReference: string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const relativePath = normalizeFilePath(filename);
    const object = await context.objects.put(data);
    const destination = path.join(
      context.ensureArtifactWorkspace(
        project.project_id,
        artifact.artifact_id,
      ),
      ...relativePath.split("/"),
    );
    await context.objects.materialize(object.hash, destination);
    const mtimeMs = Date.now();
    const mimeType = mimeTypeFor(relativePath);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "write_file",
        artifactId: artifact.artifact_id,
        details: {
          path: relativePath,
          objectHash: object.hash,
          size: object.size,
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `file:${artifact.artifact_id}:${relativePath}`,
        ],
      },
      ["objects", "artifact_files", "artifacts"],
      (_operationId, now) => {
        linkObject(
          context,
          artifact.artifact_id,
          {
            relativePath,
            objectHash: object.hash,
            size: object.size,
            mimeType,
            mtimeMs,
          },
          now,
        );
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, artifact.artifact_id);
        markWorkspaceReady(
          context,
          project.project_id,
          artifact.artifact_id,
          now,
        );
      },
    );
    return ok(destination, mutation.revision);
  });
}

async function writeFromPath(
  context: EngineContext,
  artifactReference: string,
  filename: string,
  sourcePath: string,
  projectReference: string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const relativePath = normalizeFilePath(filename);
    const object = await context.objects.import(sourcePath);
    const destination = path.join(
      context.ensureArtifactWorkspace(
        project.project_id,
        artifact.artifact_id,
      ),
      ...relativePath.split("/"),
    );
    await context.objects.materialize(object.hash, destination);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "write_file",
        artifactId: artifact.artifact_id,
        details: {
          path: relativePath,
          objectHash: object.hash,
          size: object.size,
        },
        writeSet: [
          `artifact:${artifact.artifact_id}`,
          `file:${artifact.artifact_id}:${relativePath}`,
        ],
      },
      ["objects", "artifact_files", "artifacts"],
      (_operationId, now) => {
        linkObject(
          context,
          artifact.artifact_id,
          {
            relativePath,
            objectHash: object.hash,
            size: object.size,
            mimeType: mimeTypeFor(relativePath),
            mtimeMs: now,
          },
          now,
        );
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, artifact.artifact_id);
        markWorkspaceReady(
          context,
          project.project_id,
          artifact.artifact_id,
          now,
        );
      },
    );
    return ok(destination, mutation.revision);
  });
}

async function readFile(
  context: EngineContext,
  artifactReference: string,
  filename: string,
  projectReference: string,
): Promise<Result<Buffer, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const relativePath = normalizeFilePath(filename);
    const row = context.store.db
      .prepare(
        `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
                mtime_ms, created_at
         FROM artifact_files
         WHERE artifact_id=? AND path=?`,
      )
      .get(artifact.artifact_id, relativePath) as unknown as
      | FileRow
      | undefined;
    if (!row) throw new Error(`File not found: ${relativePath}`);
    const buffer = await context.objects.read(row.object_hash);
    const destination = path.join(
      context.ensureArtifactWorkspace(
        project.project_id,
        artifact.artifact_id,
      ),
      ...relativePath.split("/"),
    );
    await context.objects.materialize(row.object_hash, destination);
    touchWorkspace(context, artifact.artifact_id);
    return buffer;
  });
}

async function deleteFile(
  context: EngineContext,
  artifactReference: string,
  filename: string,
  projectReference: string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const relativePath = normalizeFilePath(filename);
    const exists = context.store.db
      .prepare(
        "SELECT 1 AS present FROM artifact_files WHERE artifact_id=? AND path=?",
      )
      .get(artifact.artifact_id, relativePath);
    if (!exists) throw new Error(`File not found: ${relativePath}`);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "delete_file",
        artifactId: artifact.artifact_id,
        details: { path: relativePath },
        writeSet: [`file:${artifact.artifact_id}:${relativePath}`],
      },
      ["artifact_files", "artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            "DELETE FROM artifact_files WHERE artifact_id=? AND path=?",
          )
          .run(artifact.artifact_id, relativePath);
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, artifact.artifact_id);
      },
    );
    const destination = path.join(
      context.artifactPath(project.project_id, artifact.artifact_id),
      ...relativePath.split("/"),
    );
    await rm(destination, { force: true });
    return ok(destination, mutation.revision);
  });
}

async function renameFile(
  context: EngineContext,
  artifactReference: string,
  oldFilename: string,
  newFilename: string,
  projectReference: string,
): Promise<
  Result<{ oldPath: string; newPath: string }, EngineError>
> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const oldRelative = normalizeFilePath(oldFilename);
    const newRelative = normalizeFilePath(newFilename);
    const row = context.store.db
      .prepare(
        `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
                mtime_ms, created_at
         FROM artifact_files
         WHERE artifact_id=? AND path=?`,
      )
      .get(artifact.artifact_id, oldRelative) as unknown as
      | FileRow
      | undefined;
    if (!row) throw new Error(`File not found: ${oldRelative}`);
    if (
      context.store.db
        .prepare(
          "SELECT 1 AS present FROM artifact_files WHERE artifact_id=? AND path=?",
        )
        .get(artifact.artifact_id, newRelative)
    ) {
      throw new Error(`File already exists: ${newRelative}`);
    }
    const workspace = context.ensureArtifactWorkspace(
      project.project_id,
      artifact.artifact_id,
    );
    const oldPath = path.join(workspace, ...oldRelative.split("/"));
    const newPath = path.join(workspace, ...newRelative.split("/"));
    await context.objects.materialize(row.object_hash, newPath);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "rename_file",
        artifactId: artifact.artifact_id,
        details: { oldPath: oldRelative, newPath: newRelative },
        writeSet: [
          `file:${artifact.artifact_id}:${oldRelative}`,
          `file:${artifact.artifact_id}:${newRelative}`,
        ],
      },
      ["artifact_files", "artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `UPDATE artifact_files
             SET path=?, mime_type=?, mtime_ms=?
             WHERE artifact_id=? AND path=?`,
          )
          .run(
            newRelative,
            mimeTypeFor(newRelative),
            now,
            artifact.artifact_id,
            oldRelative,
          );
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, artifact.artifact_id);
      },
    );
    await rm(oldPath, { force: true });
    return ok({ oldPath, newPath }, mutation.revision);
  });
}

async function copyFile(
  context: EngineContext,
  sourceReference: string,
  filename: string,
  destinationReference: string,
  destinationFilename: string,
  projectReference: string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const source = context.artifactRow(
      project.project_id,
      sourceReference,
    );
    const destination = context.artifactRow(
      project.project_id,
      destinationReference,
    );
    const sourcePath = normalizeFilePath(filename);
    const destinationPath = normalizeFilePath(destinationFilename);
    const row = context.store.db
      .prepare(
        `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
                mtime_ms, created_at
         FROM artifact_files
         WHERE artifact_id=? AND path=?`,
      )
      .get(source.artifact_id, sourcePath) as unknown as
      | FileRow
      | undefined;
    if (!row) throw new Error(`File not found: ${sourcePath}`);
    const absolute = path.join(
      context.ensureArtifactWorkspace(
        project.project_id,
        destination.artifact_id,
      ),
      ...destinationPath.split("/"),
    );
    await context.objects.materialize(row.object_hash, absolute);
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation: "copy_file",
        artifactId: destination.artifact_id,
        details: {
          sourceArtifactId: source.artifact_id,
          sourcePath,
          destinationPath,
        },
        writeSet: [
          `file:${destination.artifact_id}:${destinationPath}`,
        ],
      },
      ["artifact_files", "artifacts"],
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifact_files(
              artifact_id, path, object_hash, size_bytes, mime_type,
              mtime_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(artifact_id, path) DO UPDATE SET
              object_hash=excluded.object_hash,
              size_bytes=excluded.size_bytes,
              mime_type=excluded.mime_type,
              mtime_ms=excluded.mtime_ms`,
          )
          .run(
            destination.artifact_id,
            destinationPath,
            row.object_hash,
            row.size_bytes,
            mimeTypeFor(destinationPath),
            now,
            now,
          );
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, destination.artifact_id);
      },
    );
    return ok(absolute, mutation.revision);
  });
}

async function manifest(
  context: EngineContext,
  artifactReference: string,
  projectReference: string,
  options: { includeDotfiles?: boolean } = {},
): Promise<Result<ArtifactManifest, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    await materializeArtifact(context, artifact.artifact_id);
    const rows = context.store.db
      .prepare(
        `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
                mtime_ms, created_at
         FROM artifact_files
         WHERE artifact_id=?
         ORDER BY path`,
      )
      .all(artifact.artifact_id) as unknown as FileRow[];
    const filtered = options.includeDotfiles
      ? rows
      : rows.filter(
          (row) =>
            !row.path
              .split("/")
              .some((segment) => segment.startsWith(".")),
        );
    const files = filtered.map(rowToManifestFile);
    return {
      artifactId: artifact.artifact_id,
      slug: artifact.slug,
      path: context.artifactPath(
        project.project_id,
        artifact.artifact_id,
      ),
      fileCount: files.length,
      files,
      directories: directoriesFor(filtered),
    };
  });
}

function listSubdir(
  context: EngineContext,
  artifactReference: string,
  subdir: string,
  projectReference: string,
): Result<string[], EngineError> {
  try {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const prefix = `${normalizeFilePath(subdir).replace(/\/+$/, "")}/`;
    const rows = context.store.db
      .prepare(
        `SELECT path FROM artifact_files
         WHERE artifact_id=? AND path LIKE ?
         ORDER BY path`,
      )
      .all(artifact.artifact_id, `${prefix}%`) as unknown as Array<{
      path: string;
    }>;
    return ok(
      rows
        .map((row) => row.path.slice(prefix.length))
        .filter((name) => name.length > 0 && !name.includes("/")),
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "IO_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function ingestWorkspace(
  context: EngineContext,
  artifactReference: string,
  paths: string[],
  projectReference: string,
  operation: string,
  details: Record<string, unknown>,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    const workspace = context.ensureArtifactWorkspace(
      project.project_id,
      artifact.artifact_id,
    );
    const requestedPaths = [
      ...new Set(paths.map((item) => normalizeFilePath(item))),
    ];
    const uniquePaths: string[] = [];
    for (const requestedPath of requestedPaths) {
      const source = path.join(
        workspace,
        ...requestedPath.split("/"),
      );
      const sourceStat = await stat(source);
      if (sourceStat.isFile()) {
        uniquePaths.push(requestedPath);
        continue;
      }
      if (!sourceStat.isDirectory()) {
        throw new Error(
          `Workspace path is neither a file nor directory: ${requestedPath}`,
        );
      }
      uniquePaths.push(
        ...(await workspaceFiles(source, requestedPath)),
      );
    }
    const expandedPaths = [...new Set(uniquePaths)].sort();
    const prepared: PreparedFile[] = [];
    for (const relativePath of expandedPaths) {
      const source = path.join(workspace, ...relativePath.split("/"));
      const sourceStat = await stat(source);
      const object = await context.objects.import(source);
      prepared.push({
        relativePath,
        objectHash: object.hash,
        size: object.size,
        mimeType: mimeTypeFor(relativePath),
        mtimeMs: sourceStat.mtimeMs,
      });
    }
    const mutation = await context.store.semantic(
      {
        projectId: project.project_id,
        operation,
        artifactId: artifact.artifact_id,
        details: {
          ...details,
          paths: expandedPaths,
        },
        writeSet: expandedPaths.map(
          (item) => `file:${artifact.artifact_id}:${item}`,
        ),
      },
      ["objects", "artifact_files", "artifacts"],
      (_operationId, now) => {
        for (const file of prepared) {
          linkObject(context, artifact.artifact_id, file, now);
        }
        context.store.db
          .prepare(
            "UPDATE artifacts SET updated_at=? WHERE artifact_id=?",
          )
          .run(now, artifact.artifact_id);
        markWorkspaceReady(
          context,
          project.project_id,
          artifact.artifact_id,
          now,
        );
      },
    );
    return ok(mutation.revision, mutation.revision);
  });
}

async function workspaceFiles(
  directory: string,
  relativeDirectory: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await workspaceFiles(absolutePath, relativePath)),
      );
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `Workspace path is not a regular file: ${relativePath}`,
      );
    }
  }
  return files;
}

async function readAtRevision(
  context: EngineContext,
  artifactId: string,
  filename: string,
  revision: string,
): Promise<Result<Buffer, EngineError>> {
  return resultOf(async () => {
    const relativePath = normalizeFilePath(filename);
    const row = context.store.db
      .prepare(
        `SELECT object_hash
         FROM dolt_at_artifact_files(?)
         WHERE artifact_id=? AND path=?`,
      )
      .get(revision, artifactId, relativePath) as unknown as
      | { object_hash: string }
      | undefined;
    if (!row) {
      throw new Error(
        `File ${relativePath} not found for artifact ${artifactId} at ${revision}`,
      );
    }
    return context.objects.read(row.object_hash);
  });
}

async function resolveArtifactWorkspace(
  context: EngineContext,
  artifactReference: string,
  projectReference: string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    await materializeArtifact(context, artifact.artifact_id);
    const workspace = context.ensureArtifactWorkspace(
      project.project_id,
      artifact.artifact_id,
    );
    touchWorkspace(context, artifact.artifact_id);
    return workspace;
  });
}

async function evictWorkspace(
  context: EngineContext,
  artifactReference: string,
  projectReference: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const project = context.projectRow(projectReference);
    const artifact = context.artifactRow(
      project.project_id,
      artifactReference,
    );
    await rm(
      context.artifactPath(project.project_id, artifact.artifact_id),
      { recursive: true, force: true },
    );
    context.store.runtime((now) => {
      context.store.db
        .prepare(
          `UPDATE runtime_workspace_entries
           SET invalidated_at=?, hydrated_at=NULL, last_accessed_at=?
           WHERE artifact_id=?`,
        )
        .run(now, now, artifact.artifact_id);
    });
    return true;
  });
}

export async function materializeArtifact(
  context: EngineContext,
  artifactId: string,
): Promise<string> {
  const artifact = context.artifactRowById(artifactId);
  const workspace = context.ensureArtifactWorkspace(
    artifact.project_id,
    artifact.artifact_id,
  );
  const rows = context.store.db
    .prepare(
      `SELECT artifact_id, path, object_hash, size_bytes, mime_type,
              mtime_ms, created_at
       FROM artifact_files
       WHERE artifact_id=?`,
    )
    .all(artifact.artifact_id) as unknown as FileRow[];
  for (const row of rows) {
    await context.objects.materialize(
      row.object_hash,
      path.join(workspace, ...row.path.split("/")),
    );
  }
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `INSERT INTO runtime_workspace_entries(
          artifact_id, project_id, path, hydrated_at, invalidated_at,
          last_accessed_at
        ) VALUES (?, ?, ?, ?, NULL, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          path=excluded.path,
          hydrated_at=excluded.hydrated_at,
          invalidated_at=NULL,
          last_accessed_at=excluded.last_accessed_at`,
      )
      .run(
        artifact.artifact_id,
        artifact.project_id,
        workspace,
        now,
        now,
      );
  });
  return workspace;
}

function linkObject(
  context: EngineContext,
  artifactId: string,
  file: PreparedFile,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO objects(
        object_hash, size_bytes, mime_type, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(object_hash) DO UPDATE SET
        size_bytes=excluded.size_bytes,
        mime_type=COALESCE(objects.mime_type, excluded.mime_type)`,
    )
    .run(file.objectHash, file.size, file.mimeType, now);
  context.store.db
    .prepare(
      `INSERT INTO artifact_files(
        artifact_id, path, object_hash, size_bytes, mime_type,
        mtime_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id, path) DO UPDATE SET
        object_hash=excluded.object_hash,
        size_bytes=excluded.size_bytes,
        mime_type=excluded.mime_type,
        mtime_ms=excluded.mtime_ms`,
    )
    .run(
      artifactId,
      file.relativePath,
      file.objectHash,
      file.size,
      file.mimeType,
      file.mtimeMs,
      now,
    );
}

function markWorkspaceReady(
  context: EngineContext,
  projectId: string,
  artifactId: string,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO runtime_workspace_entries(
        artifact_id, project_id, path, hydrated_at, invalidated_at,
        last_accessed_at
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        hydrated_at=excluded.hydrated_at,
        invalidated_at=NULL,
        last_accessed_at=excluded.last_accessed_at`,
    )
    .run(
      artifactId,
      projectId,
      context.artifactPath(projectId, artifactId),
      now,
      now,
    );
  context.store.db
    .prepare(
      `INSERT INTO runtime_artifact_views(
        artifact_id, project_id, status, meta_json, updated_at
      ) VALUES (?, ?, 'ready', '{}', ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status='ready',
        meta_json='{}',
        owner_id=NULL,
        owner_kind=NULL,
        pid=NULL,
        deadline_at=NULL,
        updated_at=excluded.updated_at`,
    )
    .run(artifactId, projectId, now);
}

function touchWorkspace(context: EngineContext, artifactId: string): void {
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `UPDATE runtime_workspace_entries
         SET last_accessed_at=? WHERE artifact_id=?`,
      )
      .run(now, artifactId);
  });
}

function rowToManifestFile(row: FileRow): ArtifactManifestFile {
  return {
    name: row.path,
    sizeBytes: row.size_bytes,
    extension: path.extname(row.path) || null,
    mtimeMs: row.mtime_ms,
    ...(row.mime_type ? { mimeType: row.mime_type } : {}),
    objectHash: row.object_hash,
  };
}

function directoriesFor(rows: FileRow[]): Record<string, string[]> {
  const directories: Record<string, string[]> = {};
  for (const row of rows) {
    const slash = row.path.lastIndexOf("/");
    if (slash < 0) continue;
    const directory = row.path.slice(0, slash);
    const filename = row.path.slice(slash + 1);
    (directories[directory] ??= []).push(filename);
  }
  return directories;
}

export function normalizeFilePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === ".." || !segment)
  ) {
    throw new Error(`Invalid artifact file path: ${input}`);
  }
  return normalized;
}

function mimeTypeFor(filename: string): string | null {
  switch (path.extname(filename).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return null;
  }
}
