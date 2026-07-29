import { readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import type {
  ArtifactManifest,
  ArtifactManifestFile,
  EngineError,
  Result,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf, type FileRow } from "./context.js";

interface PreparedFile {
  relativePath: string;
  objectHash: string;
  size: number;
}

export function createFilesApi(context: EngineContext) {
  return {
    write: (
      artifact: string,
      filename: string,
      data: Buffer | string,
    ): Promise<Result<string, EngineError>> =>
      writeFile(context, artifact, filename, data),
    writeFromPath: (
      artifact: string,
      filename: string,
      sourcePath: string,
    ): Promise<Result<string, EngineError>> =>
      writeFromPath(context, artifact, filename, sourcePath),
    read: (
      artifact: string,
      filename: string,
    ): Promise<Result<Buffer, EngineError>> => readFile(context, artifact, filename),
    delete: (
      artifact: string,
      filename: string,
    ): Promise<Result<string, EngineError>> => deleteFile(context, artifact, filename),
    rename: (
      artifact: string,
      oldFilename: string,
      newFilename: string,
    ): Promise<Result<{ oldPath: string; newPath: string }, EngineError>> =>
      renameFile(context, artifact, oldFilename, newFilename),
    copy: (
      artifact: string,
      filename: string,
      destinationArtifact: string,
      destinationFilename: string,
    ): Promise<Result<string, EngineError>> =>
      copyFile(
        context,
        artifact,
        filename,
        destinationArtifact,
        destinationFilename,
      ),
    manifest: (
      artifact: string,
      options?: { includeDotfiles?: boolean },
    ): Promise<Result<ArtifactManifest, EngineError>> =>
      manifest(context, artifact, options),
    listSubdir: (
      artifact: string,
      subdir: string,
    ): Result<string[], EngineError> => listSubdir(context, artifact, subdir),
    ingestWorkspace: (
      artifact: string,
      paths: string[],
      operation = "ingest_workspace",
      details: Record<string, unknown> = {},
    ): Promise<Result<string, EngineError>> =>
      ingestWorkspace(context, artifact, paths, operation, details),
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
    resolveArtifact: (artifact: string): Promise<Result<string, EngineError>> =>
      resolveArtifactWorkspace(context, artifact),
    materialize: (artifact: string): Promise<Result<string, EngineError>> =>
      resolveArtifactWorkspace(context, artifact),
    evict: (artifact: string): Promise<Result<boolean, EngineError>> =>
      evictWorkspace(context, artifact),
  };
}

async function writeFile(
  context: EngineContext,
  artifactReference: string,
  filename: string,
  data: Buffer | string,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const relativePath = normalizeFilePath(filename);
    const object = await context.objects.put(data);
    const destination = path.join(
      context.ensureArtifactWorkspace(artifact.artifact_id),
      ...relativePath.split("/"),
    );
    await context.objects.materialize(object.hash, destination);
    const mutation = await context.store.semantic(
      {
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
      (_operationId, now) => {
        linkObject(
          context,
          artifact.artifact_id,
          {
            relativePath,
            objectHash: object.hash,
            size: object.size,
          },
          now,
        );
        markWorkspaceReady(context, artifact.artifact_id, now);
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
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const relativePath = normalizeFilePath(filename);
    const object = await context.objects.import(sourcePath);
    const destination = path.join(
      context.ensureArtifactWorkspace(artifact.artifact_id),
      ...relativePath.split("/"),
    );
    await context.objects.materialize(object.hash, destination);
    const mutation = await context.store.semantic(
      {
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
      (_operationId, now) => {
        linkObject(
          context,
          artifact.artifact_id,
          {
            relativePath,
            objectHash: object.hash,
            size: object.size,
          },
          now,
        );
        markWorkspaceReady(context, artifact.artifact_id, now);
      },
    );
    return ok(destination, mutation.revision);
  });
}

async function readFile(
  context: EngineContext,
  artifactReference: string,
  filename: string,
): Promise<Result<Buffer, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const relativePath = normalizeFilePath(filename);
    const row = requiredFile(context, artifact.artifact_id, relativePath);
    const buffer = await context.objects.read(row.object_hash);
    const destination = path.join(
      context.ensureArtifactWorkspace(artifact.artifact_id),
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
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const relativePath = normalizeFilePath(filename);
    requiredFile(context, artifact.artifact_id, relativePath);
    const mutation = await context.store.semantic(
      {
        operation: "delete_file",
        artifactId: artifact.artifact_id,
        details: { path: relativePath },
        writeSet: [`file:${artifact.artifact_id}:${relativePath}`],
      },
      () => {
        context.store.db
          .prepare("DELETE FROM artifact_files WHERE artifact_id=? AND path=?")
          .run(artifact.artifact_id, relativePath);
      },
    );
    const destination = path.join(
      context.artifactPath(artifact.artifact_id),
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
): Promise<Result<{ oldPath: string; newPath: string }, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const oldRelative = normalizeFilePath(oldFilename);
    const newRelative = normalizeFilePath(newFilename);
    const row = requiredFile(context, artifact.artifact_id, oldRelative);
    if (fileExists(context, artifact.artifact_id, newRelative)) {
      throw new Error(`File already exists: ${newRelative}`);
    }
    const workspace = context.ensureArtifactWorkspace(artifact.artifact_id);
    const oldPath = path.join(workspace, ...oldRelative.split("/"));
    const newPath = path.join(workspace, ...newRelative.split("/"));
    await context.objects.materialize(row.object_hash, newPath);
    const mutation = await context.store.semantic(
      {
        operation: "rename_file",
        artifactId: artifact.artifact_id,
        details: { oldPath: oldRelative, newPath: newRelative },
        writeSet: [
          `file:${artifact.artifact_id}:${oldRelative}`,
          `file:${artifact.artifact_id}:${newRelative}`,
        ],
      },
      () => {
        context.store.db
          .prepare(
            `UPDATE artifact_files SET path=?
             WHERE artifact_id=? AND path=?`,
          )
          .run(
            newRelative,
            artifact.artifact_id,
            oldRelative,
          );
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
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const source = context.artifactRow(sourceReference);
    const destination = context.artifactRow(destinationReference);
    const sourcePath = normalizeFilePath(filename);
    const destinationPath = normalizeFilePath(destinationFilename);
    const row = requiredFile(context, source.artifact_id, sourcePath);
    const absolute = path.join(
      context.ensureArtifactWorkspace(destination.artifact_id),
      ...destinationPath.split("/"),
    );
    await context.objects.materialize(row.object_hash, absolute);
    const mutation = await context.store.semantic(
      {
        operation: "copy_file",
        artifactId: destination.artifact_id,
        details: {
          sourceArtifactId: source.artifact_id,
          sourcePath,
          destinationPath,
        },
        writeSet: [`file:${destination.artifact_id}:${destinationPath}`],
      },
      (_operationId, now) => {
        context.store.db
          .prepare(
            `INSERT INTO artifact_files(
              artifact_id, path, object_hash, created_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(artifact_id, path) DO UPDATE SET
              object_hash=excluded.object_hash`,
          )
          .run(
            destination.artifact_id,
            destinationPath,
            row.object_hash,
            now,
          );
        markWorkspaceReady(context, destination.artifact_id, now);
      },
    );
    return ok(absolute, mutation.revision);
  });
}

async function manifest(
  context: EngineContext,
  artifactReference: string,
  options: { includeDotfiles?: boolean } = {},
): Promise<Result<ArtifactManifest, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    await materializeArtifact(context, artifact.artifact_id);
    const rows = filesForArtifact(context, artifact.artifact_id);
    const filtered = options.includeDotfiles
      ? rows
      : rows.filter(
          (row) =>
            !row.path.split("/").some((segment) => segment.startsWith(".")),
        );
    const files = filtered.map(rowToManifestFile);
    return {
      artifactId: artifact.artifact_id,
      slug: artifact.slug,
      path: context.artifactPath(artifact.artifact_id),
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
): Result<string[], EngineError> {
  try {
    const artifact = context.artifactRow(artifactReference);
    const prefix = `${normalizeFilePath(subdir).replace(/\/+$/, "")}/`;
    const rows = context.store.db
      .prepare(
        `SELECT path FROM artifact_files
         WHERE artifact_id=? AND path LIKE ? ORDER BY path`,
      )
      .all(artifact.artifact_id, `${prefix}%`) as unknown as Array<{ path: string }>;
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
  operation: string,
  details: Record<string, unknown>,
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const workspace = context.ensureArtifactWorkspace(artifact.artifact_id);
    const requestedPaths = [...new Set(paths.map(normalizeFilePath))];
    const uniquePaths: string[] = [];
    for (const requestedPath of requestedPaths) {
      const source = path.join(workspace, ...requestedPath.split("/"));
      const sourceStat = await stat(source);
      if (sourceStat.isFile()) {
        uniquePaths.push(requestedPath);
      } else if (sourceStat.isDirectory()) {
        uniquePaths.push(...(await workspaceFiles(source, requestedPath)));
      } else {
        throw new Error(
          `Workspace path is neither a file nor directory: ${requestedPath}`,
        );
      }
    }
    const expandedPaths = [...new Set(uniquePaths)].sort();
    const prepared: PreparedFile[] = [];
    for (const relativePath of expandedPaths) {
      const source = path.join(workspace, ...relativePath.split("/"));
      const object = await context.objects.import(source);
      prepared.push({
        relativePath,
        objectHash: object.hash,
        size: object.size,
      });
    }
    const mutation = await context.store.semantic(
      {
        operation,
        artifactId: artifact.artifact_id,
        details: { ...details, paths: expandedPaths },
        writeSet: expandedPaths.map(
          (item) => `file:${artifact.artifact_id}:${item}`,
        ),
      },
      (_operationId, now) => {
        for (const file of prepared) linkObject(context, artifact.artifact_id, file, now);
        markWorkspaceReady(context, artifact.artifact_id, now);
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
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Workspace path is not a regular file: ${relativePath}`);
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
        `SELECT object_hash FROM dolt_at_artifact_files(?)
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
): Promise<Result<string, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    const workspace = await materializeArtifact(context, artifact.artifact_id);
    touchWorkspace(context, artifact.artifact_id);
    return workspace;
  });
}

async function evictWorkspace(
  context: EngineContext,
  artifactReference: string,
): Promise<Result<boolean, EngineError>> {
  return resultOf(async () => {
    const artifact = context.artifactRow(artifactReference);
    await rm(context.artifactPath(artifact.artifact_id), {
      recursive: true,
      force: true,
    });
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
  const workspace = context.ensureArtifactWorkspace(artifact.artifact_id);
  for (const row of filesForArtifact(context, artifact.artifact_id)) {
    await context.objects.materialize(
      row.object_hash,
      path.join(workspace, ...row.path.split("/")),
    );
  }
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `INSERT INTO runtime_workspace_entries(
          artifact_id, path, hydrated_at, invalidated_at, last_accessed_at
        ) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          path=excluded.path,
          hydrated_at=excluded.hydrated_at,
          invalidated_at=NULL,
          last_accessed_at=excluded.last_accessed_at`,
      )
      .run(artifact.artifact_id, workspace, now, now);
  });
  return workspace;
}

function linkObject(
  context: EngineContext,
  artifactId: string,
  file: PreparedFile,
  now: number,
): void {
  // Re-linking resurrects a forgotten object: the bytes were re-created by
  // the caller before this mutation, so the tombstone marker is cleared and
  // backup will publish the object again. A no-op rewrite of an already
  // clear row produces no Dolt row diff and therefore no commit.
  context.store.db
    .prepare(
      `INSERT INTO objects(object_hash, size_bytes, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(object_hash) DO UPDATE SET forgotten_at=NULL`,
    )
    .run(file.objectHash, file.size, now);
  context.store.db
    .prepare(
      `INSERT INTO artifact_files(
        artifact_id, path, object_hash, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id, path) DO UPDATE SET
        object_hash=excluded.object_hash`,
    )
    .run(
      artifactId,
      file.relativePath,
      file.objectHash,
      now,
    );
}

function markWorkspaceReady(
  context: EngineContext,
  artifactId: string,
  now: number,
): void {
  context.store.db
    .prepare(
      `INSERT INTO runtime_workspace_entries(
        artifact_id, path, hydrated_at, invalidated_at, last_accessed_at
      ) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        hydrated_at=excluded.hydrated_at,
        invalidated_at=NULL,
        last_accessed_at=excluded.last_accessed_at`,
    )
    .run(artifactId, context.artifactPath(artifactId), now, now);
  context.store.db
    .prepare(
      `INSERT INTO runtime_artifact_views(
        artifact_id, status, meta_json, updated_at
      ) VALUES (?, 'ready', '{}', ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        status='ready', meta_json='{}', owner_id=NULL, owner_kind=NULL,
        pid=NULL, deadline_at=NULL, updated_at=excluded.updated_at`,
    )
    .run(artifactId, now);
}

function touchWorkspace(context: EngineContext, artifactId: string): void {
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        "UPDATE runtime_workspace_entries SET last_accessed_at=? WHERE artifact_id=?",
      )
      .run(now, artifactId);
  });
}

function requiredFile(
  context: EngineContext,
  artifactId: string,
  relativePath: string,
): FileRow {
  const row = context.store.db
    .prepare(
      `SELECT f.artifact_id, f.path, f.object_hash, o.size_bytes,
              f.created_at
       FROM artifact_files f
       JOIN objects o ON o.object_hash=f.object_hash
       WHERE f.artifact_id=? AND f.path=?`,
    )
    .get(artifactId, relativePath) as unknown as FileRow | undefined;
  if (!row) throw new Error(`File not found: ${relativePath}`);
  return row;
}

function fileExists(context: EngineContext, artifactId: string, relativePath: string): boolean {
  return Boolean(
    context.store.db
      .prepare("SELECT 1 AS present FROM artifact_files WHERE artifact_id=? AND path=?")
      .get(artifactId, relativePath),
  );
}

function filesForArtifact(context: EngineContext, artifactId: string): FileRow[] {
  return context.store.db
    .prepare(
      `SELECT f.artifact_id, f.path, f.object_hash, o.size_bytes,
              f.created_at
       FROM artifact_files f
       JOIN objects o ON o.object_hash=f.object_hash
       WHERE f.artifact_id=? ORDER BY f.path`,
    )
    .all(artifactId) as unknown as FileRow[];
}

function rowToManifestFile(row: FileRow): ArtifactManifestFile {
  const mimeType = mimeTypeFor(row.path);
  return {
    name: row.path,
    sizeBytes: row.size_bytes,
    extension: path.extname(row.path) || null,
    ...(mimeType ? { mimeType } : {}),
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
    case ".weba":
      return "audio/webm";
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
