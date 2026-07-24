import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";

import { v7 as uuidv7 } from "uuid";

import type {
  Artifact,
  ArtifactKind,
  Book,
  EngineConfig,
  EngineError,
  Result,
} from "./engine-types.js";
import { err } from "./engine-types.js";
import { ObjectStore } from "./cas.js";
import { DoltStore, EngineFault } from "./store.js";

interface BookRow {
  book_id: string;
  slug: string;
  created_at: number;
}

export interface ArtifactRow {
  artifact_id: string;
  slug: string;
  kind: ArtifactKind;
  created_at: number;
}

export interface FileRow {
  artifact_id: string;
  path: string;
  object_hash: string;
  size_bytes: number;
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

    const databasePath = path.join(storage.dataDir, "videobook.db");
    const initialBook = !existsSync(databasePath)
      ? (() => {
          if (!config.initialBookSlug) {
            throw new EngineFault({
              code: "INVALID_INPUT",
              message:
                "initialBookSlug is required when creating a new engine root",
            });
          }
          return {
            bookId: uuidv7(),
            slug: normalizeBookSlug(config.initialBookSlug),
          };
        })()
      : undefined;

    this.store = new DoltStore({
      dataDir: this.config.dataDir,
      workspaceDir: this.config.workspaceDir,
      initialBook,
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

  bookRow(): BookRow {
    const row = this.store.db
      .prepare("SELECT book_id, slug, created_at FROM book")
      .get() as unknown as BookRow | undefined;
    if (!row) {
      throw new EngineFault({
        code: "SCHEMA_INCOMPATIBLE",
        message: "Book catalog is missing its singleton book record",
      });
    }
    return row;
  }

  book(row = this.bookRow()): Book {
    return {
      bookId: row.book_id,
      slug: row.slug,
      createdAt: row.created_at,
    };
  }

  artifactRow(reference: string): ArtifactRow {
    const row = this.store.db
      .prepare(
        `SELECT artifact_id, slug, kind, created_at
         FROM artifacts
         WHERE artifact_id = ? OR slug = ?
         ORDER BY CASE WHEN artifact_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(reference, reference, reference) as unknown as
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
        `SELECT artifact_id, slug, kind, created_at
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

  artifact(row: ArtifactRow): Artifact {
    return {
      artifactId: row.artifact_id,
      slug: row.slug,
      kind: row.kind,
      createdAt: row.created_at,
      path: this.artifactPath(row.artifact_id),
    };
  }

  artifactPath(artifactId: string): string {
    return path.join(this.store.workspaceDir, artifactId);
  }

  ensureArtifactWorkspace(artifactId: string): string {
    const workspace = this.artifactPath(artifactId);
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  close(): void {
    this.store.close();
  }
}

export function normalizeBookSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid book slug: ${input}`);
  }
  return slug;
}

export function isValidBookSlug(input: string): boolean {
  try {
    return normalizeBookSlug(input) === input;
  } catch {
    return false;
  }
}

function toError(error: unknown): EngineError {
  if (error instanceof EngineFault) return error.error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("artifacts_active_slug") ||
    /UNIQUE constraint failed: artifacts\.slug/i.test(message)
  ) {
    return { code: "SLUG_CONFLICT", message };
  }
  if (/UNIQUE constraint failed/i.test(message)) {
    return { code: "ALREADY_EXISTS", message };
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
