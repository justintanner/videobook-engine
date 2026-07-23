import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import Database, { type Database as RuntimeDatabase } from "better-sqlite3";

import type {
  ContentStore,
  ProjectRevision,
  StorageStatus,
} from "../types.js";
import { projectBookFromRevisions } from "../book/project-book.js";
import type {
  BookAction,
  BookActionRevision,
  GetProjectBookOptions,
  ProjectBook,
  RecordBookActionInput,
} from "../book/types.js";

interface ProjectRow {
  project_id: string;
  slug: string;
  created_at: string;
  deleted_at: string | null;
}

interface FileRow {
  path: string;
  object_hash: string;
  size_bytes: number;
  mtime_ms: number;
}

interface OperationRow {
  operation_id: string;
  project_id: string;
  operation: string;
  asset_id: string | null;
  details_json: string;
  created_at: string;
  author: string;
}

interface PendingObjectRow {
  object_hash: string;
  size_bytes: number;
}

export interface SnapshotInput {
  operationId?: string;
  operation: string;
  assetId?: string;
  details?: Record<string, unknown>;
  author?: string;
  allowEmpty?: boolean;
  paths?: string[];
  baseRevision?: string;
  writeSet?: string[];
}

export interface ImportResult {
  hash: string;
  size: number;
  path: string;
}

export class ActionConflictError extends Error {
  readonly resources: string[];

  constructor(resources: string[]) {
    super(`Action conflicts with newer changes: ${resources.join(", ")}`);
    this.name = "ActionConflictError";
    this.resources = resources;
  }
}

const SKIPPED_DIRECTORIES = new Set([".git"]);
const SKIPPED_FILES = new Set([
  ".DS_Store",
  ".gitignore",
  ".gitattributes",
  ".videobook",
]);

export class Catalog {
  readonly projectsDir: string;
  readonly dataDir: string;
  readonly objectsDir: string;
  readonly objectPrefix: string;

  private readonly db: DatabaseSync;
  private readonly runtimeDb: RuntimeDatabase;
  private readonly objectStore?: ContentStore;
  private syncState: StorageStatus["state"] = "synced";
  private lastError?: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    projectsDir: string;
    dataDir: string;
    objectStore?: ContentStore;
    objectPrefix?: string;
    branch?: string;
  }) {
    this.projectsDir = path.resolve(options.projectsDir);
    this.dataDir = path.resolve(options.dataDir);
    this.objectsDir = path.join(this.dataDir, "objects", "sha256");
    this.objectPrefix =
      options.objectPrefix ?? "superlzy-media/videobook/sha256";
    this.objectStore = options.objectStore;
    this.assertSeparatedPaths();
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, "videobook.db"));
    this.runtimeDb = new Database(path.join(this.dataDir, "runtime.sqlite"));
    this.runtimeDb.exec(`
      CREATE TABLE IF NOT EXISTS object_publication (
        object_hash TEXT PRIMARY KEY,
        published_at TEXT NOT NULL
      )
    `);
    this.initialize(options.branch ?? "main");
  }

  async prepare(): Promise<void> {
    await fs.mkdir(this.projectsDir, { recursive: true });
    await fs.mkdir(this.objectsDir, { recursive: true });
  }

  close(): void {
    this.runtimeDb.close();
    this.db.close();
  }

  get head(): string {
    return this.db.doltLog({ limit: 1 })[0]?.commit_hash ?? "";
  }

  hasProject(slug: string): boolean {
    return this.projectBySlug(slug) !== null;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare(
        "SELECT project_id, slug, created_at, deleted_at FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC",
      )
      .all() as unknown as ProjectRow[];
  }

  projectBySlug(slug: string): ProjectRow | null {
    return (
      (this.db
        .prepare(
          "SELECT project_id, slug, created_at, deleted_at FROM projects WHERE slug = ? AND deleted_at IS NULL",
        )
        .get(slug) as unknown as ProjectRow | undefined) ?? null
    );
  }

  async createProject(slug: string): Promise<ProjectRevision> {
    const operationId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO projects(project_id, slug, created_at, deleted_at) VALUES (?, ?, ?, NULL)",
        )
        .run(randomUUID(), slug, now);
      const project = this.requiredProject(slug);
      this.insertOperation(project.project_id, operationId, {
        operation: "create_project",
        author: "videobook",
      });
    });
    return this.commitRevision(slug, operationId, "create_project");
  }

  async renameProject(
    oldSlug: string,
    newSlug: string,
  ): Promise<ProjectRevision> {
    const project = this.requiredProject(oldSlug);
    const operationId = randomUUID();
    this.transaction(() => {
      this.db
        .prepare("UPDATE projects SET slug = ? WHERE project_id = ?")
        .run(newSlug, project.project_id);
      this.insertOperation(project.project_id, operationId, {
        operation: "rename_project",
        details: { oldSlug, newSlug },
        author: "videobook",
      });
    });
    return this.commitRevision(newSlug, operationId, "rename_project", {
      oldSlug,
      newSlug,
    });
  }

  async deleteProject(slug: string): Promise<ProjectRevision> {
    const project = this.requiredProject(slug);
    const operationId = randomUUID();
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare("UPDATE projects SET deleted_at = ? WHERE project_id = ?")
        .run(now, project.project_id);
      this.insertOperation(project.project_id, operationId, {
        operation: "delete_project",
        author: "videobook",
      });
    });
    return this.commitRevision(slug, operationId, "delete_project");
  }

  async snapshotProject(
    projectDir: string,
    input: SnapshotInput,
  ): Promise<ProjectRevision | null> {
    return this.serial(async () => {
      const slug = path.basename(projectDir);
      const project = this.requiredProject(slug);
      const currentHead = this.head;
      const rebasedOver = this.validateActionBase(
        slug,
        input.baseRevision,
        input.writeSet ?? [],
      );
      const details = {
        ...(input.details ?? {}),
        ...(rebasedOver ? { book_rebased_over: currentHead } : {}),
      };
      const previous = this.currentFiles(project.project_id);
      const scanned = await this.scanWorkspace(projectDir, input.paths);
      const files = input.paths
        ? mergeScopedFiles(previous, scanned, input.paths)
        : scanned;
      const changed = fileSetsDiffer(previous, files);
      if (!changed && !input.allowEmpty) return null;
      const operationId = input.operationId ?? randomUUID();
      this.transaction(() => {
        this.db
          .prepare("DELETE FROM project_files WHERE project_id = ?")
          .run(project.project_id);
        const insert = this.db.prepare(
          "INSERT INTO project_files(project_id, path, object_hash, size_bytes, mtime_ms) VALUES (?, ?, ?, ?, ?)",
        );
        for (const file of files) {
          insert.run(
            project.project_id,
            file.path,
            file.object_hash,
            file.size_bytes,
            file.mtime_ms,
          );
        }
        this.insertOperation(project.project_id, operationId, {
          ...input,
          details,
        });
      });
      const revision = this.commitRevision(
        slug,
        operationId,
        input.operation,
        details,
        input.assetId,
        input.author,
      );
      return revision;
    });
  }

  history(slug: string, limit = 20, assetId?: string): ProjectRevision[] {
    const project = this.requiredProject(slug);
    const commits = this.db.doltLog();
    const revisions: ProjectRevision[] = [];
    for (let index = 0; index < commits.length; index++) {
      const commit = commits[index]!;
      const parent = commits[index + 1];
      if (!parent) continue;
      const additions = this.db
        .doltDiff(parent.commit_hash, commit.commit_hash, "operations")
        .filter((row) => row.diff_type === "added");
      for (const row of additions) {
        const operation = operationFromDiff(row);
        if (!operation || operation.project_id !== project.project_id) continue;
        if (assetId && operation.asset_id !== assetId) continue;
        revisions.push({
          hash: commit.commit_hash,
          message: commit.message,
          date: operation.created_at,
          author: operation.author,
          projectId: operation.project_id,
          operationId: operation.operation_id,
          operation: operation.operation,
          assetId: operation.asset_id ?? undefined,
          details: JSON.parse(
            operation.details_json,
          ) as Record<string, unknown>,
          ...revisionFileChanges(
            this.db.doltDiff(
              parent.commit_hash,
              commit.commit_hash,
              "project_files",
            ),
            project.project_id,
            assetId,
          ),
        });
        if (revisions.length >= limit) return revisions;
      }
    }
    return revisions;
  }

  projectBook(
    slug: string,
    options: GetProjectBookOptions = {},
  ): ProjectBook {
    const project = this.requiredProject(slug);
    const revisions = this.history(slug, 10_000);
    return projectBookFromRevisions(
      project.project_id,
      slug,
      revisions[0]?.hash ?? this.head,
      revisions,
      options,
    );
  }

  bookAction(slug: string, actionId: string): BookAction | null {
    return (
      this.projectBook(slug, { limit: 10_000 }).actions.find(
        (action) => action.id === actionId,
      ) ?? null
    );
  }

  async recordBookAction(
    input: RecordBookActionInput,
  ): Promise<BookActionRevision> {
    const actionId = input.actionId ?? randomUUID();
    const eventId = randomUUID();
    const details: Record<string, unknown> = {
      ...(input.details ?? {}),
      book_action_id: actionId,
      book_phase: input.phase ?? "completed",
      book_scope: input.scope ?? "project",
      book_lane: input.lane ?? input.actor ?? "videobook",
      book_parent_action_ids: input.parentActionIds ?? [],
      book_input_artifact_ids: input.inputArtifactIds ?? [],
      book_output_artifact_ids: input.outputArtifactIds ?? [],
      book_write_set: input.writeSet ?? [],
      ...(input.baseRevision
        ? { book_base_revision: input.baseRevision }
        : {}),
      ...(input.targetArtifactId
        ? { book_target_artifact_id: input.targetArtifactId }
        : {}),
      ...(input.targetActionId
        ? { book_target_action_id: input.targetActionId }
        : {}),
      ...(input.layout ? { book_layout: input.layout } : {}),
    };
    const revision = await this.snapshotProject(
      path.join(this.projectsDir, input.projectSlug),
      {
        operationId: eventId,
        operation: `book:${input.operation}`,
        ...(input.targetArtifactId
          ? { assetId: input.targetArtifactId }
          : {}),
        details,
        author: input.actor ?? "videobook",
        allowEmpty: true,
        ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
        writeSet: input.writeSet ?? [],
      },
    );
    if (!revision) throw new Error("Book action did not create a revision");
    const action = this.bookAction(input.projectSlug, actionId);
    if (!action) throw new Error("Book action projection was not found");
    return { action, revision };
  }

  async readFileAtRevision(
    slug: string,
    relativePath: string,
    revision: string,
  ): Promise<Buffer | null> {
    const project = this.requiredProject(slug);
    const row = this.db
      .prepare(
        "SELECT object_hash FROM dolt_at_project_files(?) WHERE project_id = ? AND path = ?",
      )
      .get(revision, project.project_id, relativePath) as
      | { object_hash: string }
      | undefined;
    if (!row) return null;
    return this.readObject(row.object_hash);
  }

  async restoreAsset(
    slug: string,
    assetId: string,
    revision: string,
  ): Promise<ProjectRevision | null> {
    const project = this.requiredProject(slug);
    const rows = this.filesAtRevision(project.project_id, revision).filter(
      (row) => row.path === assetId || row.path.startsWith(`${assetId}/`),
    );
    if (rows.length === 0) return null;
    const assetDir = path.join(this.projectsDir, slug, assetId);
    await fs.rm(assetDir, { recursive: true, force: true });
    await this.materializeRows(path.join(this.projectsDir, slug), rows);
    return this.snapshotProject(path.join(this.projectsDir, slug), {
      operation: "restore",
      assetId,
      details: { from_revision: revision },
      allowEmpty: true,
    });
  }

  async rewindProject(
    slug: string,
    revision: string,
  ): Promise<ProjectRevision | null> {
    const project = this.requiredProject(slug);
    const history = this.history(slug, 10_000);
    const targetRevision = history.find(
      (item) => item.hash === revision || item.hash.startsWith(revision),
    );
    const currentRevision = history[0];
    const rows = this.filesAtRevision(project.project_id, revision);
    const projectDir = path.join(this.projectsDir, slug);
    const current = await fs.readdir(projectDir, { withFileTypes: true });
    for (const entry of current) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (SKIPPED_FILES.has(entry.name)) continue;
      await fs.rm(path.join(projectDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
    await this.materializeRows(projectDir, rows);
    return this.snapshotProject(projectDir, {
      operation: "rewind",
      details: {
        from_revision: revision,
        book_action_id: randomUUID(),
        book_phase: "completed",
        book_scope: "project",
        book_lane: "videobook",
        book_parent_action_ids: [
          ...new Set([
            currentRevision?.details?.book_action_id,
            currentRevision?.operationId,
            targetRevision?.details?.book_action_id,
            targetRevision?.operationId,
          ].filter((value): value is string => typeof value === "string")),
        ],
        ...(targetRevision
          ? { book_target_action_id:
              typeof targetRevision.details?.book_action_id === "string"
                ? targetRevision.details.book_action_id
                : targetRevision.operationId }
          : {}),
      },
      allowEmpty: true,
    });
  }

  historicalSlugs(slug: string): Set<string> {
    return new Set(
      this.history(slug, 10_000)
        .map((revision) => revision.assetId)
        .filter((value): value is string => value !== undefined),
    );
  }

  async importFile(sourcePath: string): Promise<ImportResult> {
    const stat = await fs.stat(sourcePath);
    const hash = await hashFile(sourcePath);
    const destination = this.objectPath(hash);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.db
      .prepare(
        "INSERT OR IGNORE INTO objects(object_hash, size_bytes, created_at) VALUES (?, ?, ?)",
      )
      .run(hash, stat.size, new Date().toISOString());
    return { hash, size: stat.size, path: destination };
  }

  async getStorageStatus(): Promise<StorageStatus> {
    const pendingObjects = this.pendingObjects().length;
    const state =
      pendingObjects > 0 && this.syncState === "synced"
        ? "ahead"
        : this.syncState;
    return {
      state,
      head: this.head,
      pendingObjects,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async syncObjects(): Promise<StorageStatus> {
    if (!this.objectStore) return this.getStorageStatus();
    this.syncState = "syncing";
    const pending = this.pendingObjects();
    try {
      for (const object of pending) {
        const key = this.objectKey(object.object_hash);
        const remote = await this.objectStore.head(key);
        if (!remote.exists) {
          await this.objectStore.uploadFile(
            key,
            this.objectPath(object.object_hash),
          );
          const verified = await this.objectStore.head(key);
          if (!verified.exists || verified.size !== object.size_bytes) {
            throw new Error(
              `Remote object verification failed: ${object.object_hash}`,
            );
          }
        } else if (remote.size !== undefined && remote.size !== object.size_bytes) {
          throw new Error(`Remote object size mismatch: ${object.object_hash}`);
        }
        this.runtimeDb
          .prepare(
            "INSERT OR REPLACE INTO object_publication(object_hash, published_at) VALUES (?, ?)",
          )
          .run(object.object_hash, new Date().toISOString());
      }
      this.syncState = "synced";
      this.lastError = undefined;
    } catch (error: unknown) {
      this.syncState = "offline";
      this.lastError = (error as Error).message;
    }
    return this.getStorageStatus();
  }

  private initialize(branch: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS objects (
        object_hash TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_files (
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        PRIMARY KEY(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        asset_id TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        author TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_project
        ON operations(project_id, created_at);
    `);
    if (this.db.doltStatus().length > 0) {
      this.db.doltCommit("Initialize Videobook catalog");
    }
    if (branch !== "main" && !this.db.doltBranches().some((item) => item.name === branch)) {
      this.db.doltBranch(branch, "main");
      this.db.doltCheckout(branch);
    } else if (this.db.doltActiveBranch() !== branch) {
      this.db.doltCheckout(branch);
    }
  }

  private assertSeparatedPaths(): void {
    const projects = `${this.projectsDir}${path.sep}`;
    const data = `${this.dataDir}${path.sep}`;
    if (
      this.projectsDir === this.dataDir ||
      projects.startsWith(data) ||
      data.startsWith(projects)
    ) {
      throw new Error("projectsDir and dataDir must not overlap");
    }
  }

  private requiredProject(slug: string): ProjectRow {
    const project = this.projectBySlug(slug);
    if (!project) throw new Error(`Project not found: ${slug}`);
    return project;
  }

  private validateActionBase(
    slug: string,
    baseRevision: string | undefined,
    writeSet: string[],
  ): boolean {
    if (!baseRevision || baseRevision === this.head) return false;
    const revisions = this.history(slug, 10_000);
    const baseIndex = revisions.findIndex(
      (revision) =>
        revision.hash === baseRevision ||
        revision.hash.startsWith(baseRevision),
    );
    if (baseIndex < 0) throw new ActionConflictError(["project:head"]);
    const requested = new Set(writeSet);
    if (requested.size === 0) return true;
    const changed = new Set<string>();
    for (const revision of revisions.slice(0, baseIndex)) {
      if (revision.assetId) changed.add(`artifact:${revision.assetId}`);
      for (const file of revision.files ?? []) changed.add(`file:${file}`);
      const recorded = revision.details?.book_write_set;
      if (Array.isArray(recorded)) {
        for (const resource of recorded) {
          if (typeof resource === "string") changed.add(resource);
        }
      }
    }
    const conflicts = [...requested].filter((resource) =>
      changed.has(resource),
    );
    if (conflicts.length > 0) throw new ActionConflictError(conflicts);
    return true;
  }

  private insertOperation(
    projectId: string,
    operationId: string,
    input: SnapshotInput,
  ): void {
    this.db
      .prepare(
        `INSERT INTO operations(
          operation_id, project_id, operation, asset_id, details_json, created_at, author
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        projectId,
        input.operation,
        input.assetId ?? null,
        JSON.stringify(input.details ?? {}),
        new Date().toISOString(),
        input.author ?? "videobook",
      );
  }

  private commitRevision(
    slug: string,
    operationId: string,
    operation: string,
    details?: Record<string, unknown>,
    assetId?: string,
    author = "videobook",
  ): ProjectRevision {
    const hash = this.db.doltCommit(formatMessage(operation, assetId));
    const date = new Date().toISOString();
    return {
      hash,
      message: formatMessage(operation, assetId),
      date,
      author,
      projectId: this.requiredProjectAllowDeleted(slug).project_id,
      operationId,
      operation,
      ...(assetId ? { assetId } : {}),
      ...(details ? { details } : {}),
    };
  }

  private requiredProjectAllowDeleted(slug: string): ProjectRow {
    const project = this.db
      .prepare(
        "SELECT project_id, slug, created_at, deleted_at FROM projects WHERE slug = ?",
      )
      .get(slug) as unknown as ProjectRow | undefined;
    if (!project) throw new Error(`Project not found: ${slug}`);
    return project;
  }

  private currentFiles(projectId: string): FileRow[] {
    return this.db
      .prepare(
        "SELECT path, object_hash, size_bytes, mtime_ms FROM project_files WHERE project_id = ? ORDER BY path",
      )
      .all(projectId) as unknown as FileRow[];
  }

  private filesAtRevision(projectId: string, revision: string): FileRow[] {
    return this.db
      .prepare(
        "SELECT path, object_hash, size_bytes, mtime_ms FROM dolt_at_project_files(?) WHERE project_id = ? ORDER BY path",
      )
      .all(revision, projectId) as unknown as FileRow[];
  }

  private async scanWorkspace(
    projectDir: string,
    scopedPaths?: string[],
  ): Promise<FileRow[]> {
    const files: FileRow[] = [];
    const seen = new Set<string>();
    const visit = async (absolute: string): Promise<void> => {
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const relative = path.relative(projectDir, absolute);
      if (isRuntimePath(relative)) return;
      if (stat.isFile()) {
        if (SKIPPED_FILES.has(path.basename(absolute)) || seen.has(relative)) {
          return;
        }
        try {
          const imported = await this.importFile(absolute);
          files.push({
            path: relative,
            object_hash: imported.hash,
            size_bytes: imported.size,
            mtime_ms: Math.floor(stat.mtimeMs),
          });
          seen.add(relative);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return;
      }
      if (!stat.isDirectory() || SKIPPED_DIRECTORIES.has(path.basename(absolute))) {
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(absolute, { withFileTypes: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (!entry.isDirectory() && SKIPPED_FILES.has(entry.name)) continue;
        await visit(path.join(absolute, entry.name));
      }
    };
    if (scopedPaths) {
      for (const scopedPath of scopedPaths) {
        await visit(path.join(projectDir, scopedPath));
      }
    } else {
      await visit(projectDir);
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async readObject(hash: string): Promise<Buffer | null> {
    const objectPath = this.objectPath(hash);
    try {
      return await fs.readFile(objectPath);
    } catch {}
    if (!this.objectStore) return null;
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await this.objectStore.downloadFile(this.objectKey(hash), objectPath);
    const actual = await hashFile(objectPath);
    if (actual !== hash) {
      await fs.rm(objectPath, { force: true });
      throw new Error(`Hydrated object hash mismatch: ${hash}`);
    }
    return fs.readFile(objectPath);
  }

  private async materializeRows(
    projectDir: string,
    rows: FileRow[],
  ): Promise<void> {
    for (const row of rows) {
      const data = await this.readObject(row.object_hash);
      if (!data) throw new Error(`Object unavailable: ${row.object_hash}`);
      const destination = path.join(projectDir, row.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, data);
    }
  }

  private objectPath(hash: string): string {
    return path.join(this.objectsDir, hash.slice(0, 2), hash);
  }

  private objectKey(hash: string): string {
    return `${this.objectPrefix}/${hash.slice(0, 2)}/${hash}`;
  }

  private pendingObjects(): PendingObjectRow[] {
    const published = new Set(
      (
        this.runtimeDb
          .prepare("SELECT object_hash FROM object_publication")
          .all() as Array<{ object_hash: string }>
      ).map((row) => row.object_hash),
    );
    return (
      this.db
        .prepare("SELECT object_hash, size_bytes FROM objects")
        .all() as unknown as PendingObjectRow[]
    ).filter((object) => !published.has(object.object_hash));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function formatMessage(operation: string, assetId?: string): string {
  return assetId ? `[${assetId}] ${operation}` : `${operation}: project`;
}

function fileSetsDiffer(left: FileRow[], right: FileRow[]): boolean {
  if (left.length !== right.length) return true;
  return left.some((file, index) => {
    const other = right[index];
    return (
      !other ||
      file.path !== other.path ||
      file.object_hash !== other.object_hash ||
      file.size_bytes !== other.size_bytes
    );
  });
}

function mergeScopedFiles(
  previous: FileRow[],
  scanned: FileRow[],
  paths: string[],
): FileRow[] {
  const normalized = paths.map((item) => item.replaceAll("\\", "/"));
  const matches = (file: FileRow): boolean =>
    normalized.some(
      (target) =>
        file.path === target || file.path.startsWith(`${target}/`),
    );
  return [
    ...previous.filter((file) => !matches(file)),
    ...scanned.filter((file) => matches(file)),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function isRuntimePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.startsWith(".videocity/state.sqlite") ||
    normalized === ".videocity/.project.lock" ||
    normalized.startsWith(".videocity/logs/") ||
    normalized.startsWith(".logs/")
  );
}

function operationFromDiff(
  row: Record<string, unknown>,
): OperationRow | null {
  const operationId = row.to_operation_id;
  const projectId = row.to_project_id;
  const operation = row.to_operation;
  const details = row.to_details_json;
  const createdAt = row.to_created_at;
  const author = row.to_author;
  if (
    typeof operationId !== "string" ||
    typeof projectId !== "string" ||
    typeof operation !== "string" ||
    typeof details !== "string" ||
    typeof createdAt !== "string" ||
    typeof author !== "string"
  ) {
    return null;
  }
  return {
    operation_id: operationId,
    project_id: projectId,
    operation,
    asset_id:
      typeof row.to_asset_id === "string" ? row.to_asset_id : null,
    details_json: details,
    created_at: createdAt,
    author,
  };
}

function revisionFileChanges(
  rows: Array<Record<string, unknown>>,
  projectId: string,
  assetId?: string,
): Pick<ProjectRevision, "files" | "fileChanges"> {
  const fileChanges = rows.flatMap((row) => {
    const targetProject = row.to_project_id ?? row.from_project_id;
    if (targetProject !== projectId) return [];
    const rawPath = row.to_path ?? row.from_path;
    if (typeof rawPath !== "string") return [];
    if (
      assetId &&
      rawPath !== assetId &&
      !rawPath.startsWith(`${assetId}/`)
    ) {
      return [];
    }
    const file = assetId
      ? rawPath.slice(assetId.length).replace(/^[/\\]/, "")
      : rawPath;
    const status =
      row.diff_type === "added"
        ? "A"
        : row.diff_type === "removed"
          ? "D"
          : "M";
    return [{ status, file }];
  });
  return {
    files: fileChanges.map((change) => change.file),
    fileChanges,
  };
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) {
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
