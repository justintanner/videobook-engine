import { mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";

import {
  DatabaseSync,
  type DoltDiffRow,
  type DoltStatusEntry,
} from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import type {
  CatalogBackupConfig,
  EngineError,
  OperationInput,
  SemanticCommitBoundary,
} from "./engine-types.js";
import {
  RUNTIME_SCHEMA_SQL,
  RUNTIME_TABLES,
  SCHEMA_VERSION,
  SEMANTIC_SCHEMA_SQL,
  SEMANTIC_TABLES,
  type SemanticTable,
} from "./schema.js";

interface SchemaRow {
  version: number;
}

interface OutboxRow {
  operation_id: string;
  tables_json: string;
  message: string;
}

interface CommitRow {
  hash: string;
}

interface RemoteRow {
  name: string;
  url: string;
}

export class EngineFault extends Error {
  readonly error: EngineError;

  constructor(error: EngineError) {
    super(error.message);
    this.name = "EngineFault";
    this.error = error;
  }
}

interface SemanticMutation<T> {
  value: T;
  revision: string;
  operationId: string;
}

export class DoltStore {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly objectsDir: string;
  readonly workspaceDir: string;

  private writeChain: Promise<void> = Promise.resolve();
  private readonly semanticCommitBoundary:
    | ((boundary: SemanticCommitBoundary, operationId: string) => void)
    | undefined;

  constructor(input: {
    dataDir: string;
    workspaceDir: string;
    initialBook?: { bookId: string; slug: string };
    catalogBackup?: CatalogBackupConfig;
    semanticCommitBoundary?: (
      boundary: SemanticCommitBoundary,
      operationId: string,
    ) => void;
  }) {
    this.dataDir = path.resolve(input.dataDir);
    this.workspaceDir = path.resolve(input.workspaceDir);
    this.databasePath = path.join(this.dataDir, "videobook.db");
    this.semanticCommitBoundary = input.semanticCommitBoundary;
    this.objectsDir = path.join(this.dataDir, "objects", "sha256");
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.workspaceDir, { recursive: true });

    const existed = existsSync(this.databasePath);
    this.db = new DatabaseSync(this.databasePath);
    this.configureConnection();
    this.initialize(existed, input.initialBook);
    if (input.catalogBackup) this.configureRemote(input.catalogBackup);
  }

  get head(): string {
    return this.db.doltLog({ limit: 1 })[0]?.commit_hash ?? "";
  }

  get status(): DoltStatusEntry[] {
    return this.db.doltStatus();
  }

  close(): void {
    this.db.close();
  }

  async semantic<T>(
    input: OperationInput,
    tables: readonly SemanticTable[],
    mutate: (operationId: string, now: number) => T,
  ): Promise<SemanticMutation<T>> {
    return this.serial(async () => {
      const operationId = uuidv7();
      const now = Date.now();
      const touched = uniqueSemanticTables([...tables, "operations"]);
      this.assertRuntimeUnstaged();
      this.begin();
      let value: T;
      try {
        value = mutate(operationId, now);
        this.db
          .prepare(
            `INSERT INTO operations(
              operation_id, operation, artifact_id, details_json,
              write_set_json, base_revision, created_at, author
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operationId,
            input.operation,
            input.artifactId ?? null,
            canonicalJson(input.details ?? {}),
            canonicalJson(input.writeSet ?? []),
            input.baseRevision ?? null,
            now,
            input.author ?? "videobook",
          );
        this.db
          .prepare(
            `INSERT INTO runtime_commit_outbox(
              operation_id, tables_json, message, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            operationId,
            canonicalJson(touched),
            commitMessage(input, operationId),
            now,
          );
        this.semanticCommitBoundary?.("before-sql-commit", operationId);
        this.commitSql();
      } catch (error) {
        this.rollback();
        throw error;
      }

      this.semanticCommitBoundary?.("after-sql-commit", operationId);
      const revision = this.commitOutbox(operationId);
      return { value, revision, operationId };
    });
  }

  runtime<T>(mutate: (now: number) => T): T {
    this.assertRuntimeUnstaged();
    this.begin();
    try {
      const value = mutate(Date.now());
      this.commitSql();
      return value;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  diff(from: string, to: string, table: SemanticTable): DoltDiffRow[] {
    return this.db.doltDiff(from, to, table);
  }

  push(remoteName: string): void {
    this.assertRuntimeUnstaged();
    this.db
      .prepare("SELECT dolt_push(?, 'main') AS result")
      .get(remoteName);
  }

  private configureConnection(): void {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 10000");
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // DoltLite builds that do not expose WAL still provide atomic commits.
    }
  }

  private initialize(
    existed: boolean,
    initialBook?: { bookId: string; slug: string },
  ): void {
    const schemaExists = this.tableExists("engine_schema");
    if (existed && !schemaExists) {
      const userTables = this.userTables();
      if (userTables.length > 0) {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message:
            "Existing database is not a supported Videobook catalog; choose an empty dataDir",
          details: { tables: userTables },
        });
      }
    }

    if (!schemaExists) {
      if (!initialBook) {
        this.db.close();
        throw new EngineFault({
          code: "INVALID_INPUT",
          message:
            "initialBookSlug is required when creating a new engine root",
        });
      }
      this.db.exec(SEMANTIC_SCHEMA_SQL);
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS dolt_ignore(
          pattern TEXT NOT NULL,
          ignored TINYINT NOT NULL,
          PRIMARY KEY(pattern)
        )`,
      );
      this.db
        .prepare(
          `INSERT INTO dolt_ignore(pattern, ignored)
           VALUES ('runtime_%', 1), ('sqlite_sequence', 1)
           ON CONFLICT(pattern) DO UPDATE SET ignored=excluded.ignored`,
        )
        .run();
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, ?, ?)",
        )
        .run(SCHEMA_VERSION, now);
      this.db
        .prepare(
          "INSERT INTO book(book_id, slug, created_at) VALUES (?, ?, ?)",
        )
        .run(initialBook.bookId, initialBook.slug, now);
      this.db
        .prepare(
          "INSERT INTO timeline(book_id, render) VALUES (?, 'landscape')",
        )
        .run(initialBook.bookId);
      this.initializePrimarySequence(initialBook.bookId, now);
      this.stageTables(SEMANTIC_TABLES);
      this.db
        .prepare("SELECT dolt_add('dolt_ignore') AS result")
        .get();
      this.assertOnlyVersionedStaged();
      this.sqlCommit("Initialize Videobook book");
    } else {
      const row = this.db
        .prepare(
          "SELECT version FROM engine_schema WHERE singleton = 1",
        )
        .get() as unknown as SchemaRow | undefined;
      if (!row) {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message: "Database schema unknown is not supported by engine schema "
            + `${SCHEMA_VERSION}`,
        });
      }
      if (row.version !== SCHEMA_VERSION) {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message: `Database schema ${row.version} is not supported by engine schema ${SCHEMA_VERSION}`,
        });
      }
      const books = this.db
        .prepare("SELECT book_id FROM book")
        .all() as unknown as Array<{ book_id: string }>;
      if (books.length !== 1) {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message: `Book catalog must contain exactly one book record; found ${books.length}`,
        });
      }
      if (this.db.doltActiveBranch() !== "main") {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message: "Videobook only supports the main branch",
        });
      }
    }

    this.db.exec(RUNTIME_SCHEMA_SQL);
    this.db
      .prepare(
        `INSERT INTO runtime_meta(key, value_json, updated_at)
         VALUES ('schema_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json=excluded.value_json,
           updated_at=excluded.updated_at`,
      )
      .run(String(SCHEMA_VERSION), Date.now());
    this.assertRuntimeUnstaged();
    this.recoverOutbox();
  }

  private configureRemote(remote: CatalogBackupConfig): void {
    const rows = this.db
      .prepare("SELECT * FROM dolt_remotes()")
      .all() as unknown as RemoteRow[];
    const current = rows.find((row) => row.name === remote.name);
    if (current) {
      if (current.url !== remote.url) {
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message: `Catalog remote ${remote.name} already points to a different URL`,
        });
      }
      return;
    }
    this.db
      .prepare("SELECT dolt_remote('add', ?, ?) AS result")
      .get(remote.name, remote.url);
  }

  private initializePrimarySequence(bookId: string, now: number): void {
    const sequenceId = uuidv7();
    this.db
      .prepare(
        `INSERT INTO sequences(
          sequence_id, book_id, name, is_primary, width, height,
          pixel_aspect_numerator, pixel_aspect_denominator,
          frame_rate_numerator, frame_rate_denominator,
          audio_sample_rate_hz, audio_channel_layout,
          background_rgba_json, created_at
        ) VALUES (?, ?, 'Main', 1, 1920, 1080, 1, 1, 30, 1, 48000, 'stereo', ?, ?)`,
      )
      .run(sequenceId, bookId, canonicalJson([0, 0, 0, 1]), now);
    const insertTrack = this.db.prepare(
      `INSERT INTO sequence_tracks(
        track_id, sequence_id, kind, ordinal, name,
        enabled, locked, muted, solo, blend_mode
      ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    );
    insertTrack.run(uuidv7(), sequenceId, "video", 0, "Video 1", null, null, "normal");
    insertTrack.run(uuidv7(), sequenceId, "video", 1, "Video 2", null, null, "normal");
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      insertTrack.run(
        uuidv7(),
        sequenceId,
        "audio",
        ordinal,
        `Audio ${ordinal + 1}`,
        0,
        0,
        null,
      );
    }
    insertTrack.run(
      uuidv7(),
      sequenceId,
      "caption",
      0,
      "Captions",
      null,
      null,
      null,
    );
  }

  private recoverOutbox(): void {
    const rows = this.db
      .prepare(
        `SELECT operation_id, tables_json, message
         FROM runtime_commit_outbox
         ORDER BY created_at, operation_id`,
      )
      .all() as unknown as OutboxRow[];
    for (const row of rows) {
      this.commitOutbox(row.operation_id);
    }
  }

  private commitOutbox(operationId: string): string {
    const row = this.db
      .prepare(
        `SELECT operation_id, tables_json, message
         FROM runtime_commit_outbox
         WHERE operation_id = ?`,
      )
      .get(operationId) as unknown as OutboxRow | undefined;
    if (!row) return this.head;
    const tables = parseStringArray(row.tables_json);
    const changedTables: SemanticTable[] = [];
    for (const table of tables) {
      if (!isSemanticTable(table)) {
        throw new EngineFault({
          code: "STORAGE_ERROR",
          message: `Commit outbox contains non-semantic table: ${table}`,
        });
      }
      const changed = this.db
        .doltStatus()
        .some(
          (entry) =>
            entry.table_name === table &&
            entry.staged === 0 &&
            entry.status !== "ignored",
        );
      if (changed) changedTables.push(table);
    }
    this.stageTables(changedTables);
    this.assertOnlyVersionedStaged();
    const hasStaged = this.db
      .doltStatus()
      .some((entry) => entry.staged === 1);
    const revision = hasStaged ? this.sqlCommit(row.message) : this.head;
    this.semanticCommitBoundary?.("after-dolt-commit", operationId);
    this.runtime(() => {
      this.db
        .prepare(
          "DELETE FROM runtime_commit_outbox WHERE operation_id = ?",
        )
        .run(operationId);
    });
    return revision;
  }

  private sqlCommit(message: string): string {
    const row = this.db
      .prepare("SELECT dolt_commit('-m', ?) AS hash")
      .get(message) as unknown as CommitRow | undefined;
    const hash = row?.hash;
    if (!hash) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: "Dolt commit did not return a revision hash",
      });
    }
    this.assertRuntimeUnstaged();
    return hash;
  }

  private stageTables(tables: readonly SemanticTable[]): void {
    const unique = uniqueSemanticTables(tables);
    for (const table of unique) {
      this.db
        .prepare("SELECT dolt_add(?) AS result")
        .get(table);
    }
  }

  private assertOnlyVersionedStaged(): void {
    for (const entry of this.db.doltStatus()) {
      if (entry.staged !== 1) continue;
      if (
        !isSemanticTable(entry.table_name) &&
        entry.table_name !== "dolt_ignore"
      ) {
        throw new EngineFault({
          code: "STORAGE_ERROR",
          message: `Refusing to commit non-versioned table ${entry.table_name}`,
        });
      }
    }
  }

  private assertRuntimeUnstaged(): void {
    const runtime = new Set<string>(RUNTIME_TABLES);
    const staged = this.db
      .doltStatus()
      .find(
        (entry) => entry.staged === 1 && runtime.has(entry.table_name),
      );
    if (staged) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: `Runtime table ${staged.table_name} must never be staged`,
      });
    }
  }

  private userTables(): string[] {
    return (
      this.db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name NOT LIKE 'sqlite_%'
             AND name NOT LIKE 'dolt_%'
           ORDER BY name`,
        )
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);
  }

  private tableExists(table: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(table),
    );
  }

  private begin(): void {
    this.db.exec("BEGIN IMMEDIATE");
  }

  private commitSql(): void {
    this.db.exec("COMMIT");
  }

  private rollback(): void {
    if (this.db.inTransaction) this.db.exec("ROLLBACK");
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(work, work);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function commitMessage(input: OperationInput, operationId: string): string {
  const target = input.artifactId ? ` artifact:${input.artifactId}` : "";
  return `${input.operation}${target}\n\nop-id: ${operationId}`;
}

function parseStringArray(text: string): string[] {
  const parsed = parseJson<unknown>(text, []);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function isSemanticTable(table: string): table is SemanticTable {
  return (SEMANTIC_TABLES as readonly string[]).includes(table);
}

function uniqueSemanticTables(
  tables: readonly SemanticTable[],
): SemanticTable[] {
  return [...new Set(tables)];
}
