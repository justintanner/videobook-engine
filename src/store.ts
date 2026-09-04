import { mkdirSync, existsSync, statSync } from "node:fs";
import * as path from "node:path";

import {
  DatabaseSync,
  type DoltDiffRow,
  type DoltStatusEntry,
  type StatementSync,
} from "@dolthub/doltlite";
import { v7 as uuidv7 } from "uuid";

import type {
  CatalogBackupConfig,
  CatalogGcConfig,
  CatalogGcReport,
  CatalogGcTrigger,
  EngineError,
  OperationInput,
  SemanticCommitBoundary,
} from "./engine-types.js";
import { DEFAULT_CATALOG_GC_BYTES_THRESHOLD } from "./engine-types.js";
import { initialOrderKeys } from "./order-keys.js";
import { applyV22NotebookGridMigration } from "./migrate-grid-v22.js";
import { applyV23NotebookGridMigration } from "./migrate-grid-v23.js";
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

const OUTBOX_ALLOW_EMPTY_FLAG = "allow-empty";

interface CommitRow {
  hash: string;
}

interface RemoteRow {
  name: string;
  url: string;
}

const DEFAULT_COMMIT_AUTHOR = "Videobook <videobook@localhost>";

const IGNORE_PATTERNS = ["runtime_%", "sqlite_sequence", "job_runs"] as const;

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
  private readonly author: string;
  // Cached `dolt_diff_<table>` existence probes; see hasWorkingDiff.
  private readonly workingDiffProbes = new Map<SemanticTable, StatementSync>();
  private readonly semanticCommitBoundary:
    | ((boundary: SemanticCommitBoundary, operationId: string) => void)
    | undefined;
  private readonly catalogGcConfig: {
    bytesThreshold: number;
    onOpen: boolean;
    onClose: boolean;
  };
  private writeCount = 0;
  lastCatalogGc: CatalogGcReport | undefined;

  constructor(input: {
    dataDir: string;
    workspaceDir: string;
    initialBook?: { bookId: string; name: string };
    catalogBackup?: CatalogBackupConfig;
    author?: string;
    catalogGc?: CatalogGcConfig;
    semanticCommitBoundary?: (
      boundary: SemanticCommitBoundary,
      operationId: string,
    ) => void;
  }) {
    this.dataDir = path.resolve(input.dataDir);
    this.workspaceDir = path.resolve(input.workspaceDir);
    this.databasePath = path.join(this.dataDir, "videobook.db");
    this.author = input.author ?? DEFAULT_COMMIT_AUTHOR;
    this.semanticCommitBoundary = input.semanticCommitBoundary;
    this.catalogGcConfig = {
      bytesThreshold:
        input.catalogGc?.bytesThreshold ?? DEFAULT_CATALOG_GC_BYTES_THRESHOLD,
      onOpen: input.catalogGc?.onOpen !== false,
      onClose: input.catalogGc?.onClose !== false,
    };
    this.objectsDir = path.join(this.dataDir, "objects", "sha256");
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.workspaceDir, { recursive: true });

    const existed = existsSync(this.databasePath);
    this.db = new DatabaseSync(this.databasePath);
    // GC before configureConnection/initialize prepare any statement so
    // workingDiffProbes never holds a pre-GC StatementSync.
    if (existed) this.maybeGcOnOpen();
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
    if (this.catalogGcConfig.onClose && this.writeCount > 0) {
      try {
        this.gcCatalog("close");
      } catch {
        // Best-effort: the handle must still drop even if GC fails.
      }
    }
    this.db.close();
  }

  async semantic<T>(
    input: OperationInput,
    mutate: (operationId: string, now: number) => T,
  ): Promise<SemanticMutation<T>> {
    return this.serial(async () => {
      const operationId = uuidv7();
      const now = Date.now();
      this.begin();
      let value: T;
      try {
        value = mutate(operationId, now);
        this.db
          .prepare(
            `INSERT INTO runtime_commit_outbox(
              operation_id, tables_json, message, created_at
            ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            operationId,
            // The declared write set commits atomically with the mutation,
            // so recovery after a crash stages exactly the same tables.
            canonicalJson({
              tables: uniqueSemanticTables(input.tables),
              ...(input.allowEmpty ? { allowEmpty: true } : {}),
            }),
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
      this.writeCount += 1;
      return { value, revision, operationId };
    });
  }

  runtime<T>(mutate: (now: number) => T): T {
    this.assertRuntimeUnstaged();
    this.begin();
    try {
      const value = mutate(Date.now());
      this.commitSql();
      this.writeCount += 1;
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
    this.db.prepare("SELECT dolt_push(?, 'main') AS result").get(remoteName);
  }

  /**
   * Physically reclaims unreferenced chunks in the Dolt storage layer.
   * doltlite exposes `dolt_gc()` as a SQL function and returns a human
   * readable summary such as "3 chunks removed, 42 chunks kept".
   */
  doltGc(): string {
    return this.gcCatalog("manual").summary;
  }

  gcCatalog(trigger: CatalogGcTrigger): CatalogGcReport {
    if (trigger !== "open") this.assertRuntimeUnstaged();
    const bytesBefore = statSync(this.databasePath).size;
    const summary = this.runDoltGc();
    this.workingDiffProbes.clear();
    this.writeCount = 0;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // doltlite builds that do not expose WAL checkpoints still truncate
      // the catalog file from dolt_gc itself.
    }
    const bytesAfter = statSync(this.databasePath).size;
    const parsed = parseDoltGcSummary(summary);
    const report: CatalogGcReport = {
      trigger,
      summary,
      bytesBefore,
      bytesAfter,
      chunksRemoved: parsed.chunksRemoved,
      chunksKept: parsed.chunksKept,
    };
    this.lastCatalogGc = report;
    return report;
  }

  tableRowCounts(): Record<string, number> {
    const tables = this.db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as unknown as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${name}`)
        .get() as unknown as { n: number };
      counts[name] = Number(row.n);
    }
    return counts;
  }

  private maybeGcOnOpen(): void {
    if (!this.catalogGcConfig.onOpen) return;
    const size = statSync(this.databasePath).size;
    if (size < this.catalogGcConfig.bytesThreshold) return;
    this.gcCatalog("open");
  }

  private runDoltGc(): string {
    const row = this.db
      .prepare("SELECT dolt_gc() AS result")
      .get() as unknown as { result: string } | undefined;
    return row?.result ?? "";
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
    initialBook?: { bookId: string; name: string },
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
            "initialBookName is required when creating a new engine root",
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
      const insertIgnorePattern = this.db.prepare(
        `INSERT INTO dolt_ignore(pattern, ignored)
         VALUES (?, 1)
         ON CONFLICT(pattern) DO UPDATE SET ignored=excluded.ignored`,
      );
      for (const pattern of IGNORE_PATTERNS) insertIgnorePattern.run(pattern);
      const now = Date.now();
      this.db
        .prepare(
          "INSERT INTO engine_schema(singleton, version, created_at) VALUES (1, ?, ?)",
        )
        .run(SCHEMA_VERSION, now);
      this.db
        .prepare("INSERT INTO book(book_id, name, created_at) VALUES (?, ?, ?)")
        .run(initialBook.bookId, initialBook.name, now);
      this.initializePrimarySequence(initialBook.bookId, now);
      this.stageTables(SEMANTIC_TABLES);
      this.db.prepare("SELECT dolt_add('dolt_ignore') AS result").get();
      this.assertOnlyVersionedStaged();
      this.sqlCommit("Initialize Videobook book");
    } else {
      let row = this.db
        .prepare("SELECT version FROM engine_schema WHERE singleton = 1")
        .get() as unknown as SchemaRow | undefined;
      if (!row) {
        this.db.close();
        throw new EngineFault({
          code: "SCHEMA_INCOMPATIBLE",
          message:
            "Database schema unknown is not supported by engine schema " +
            `${SCHEMA_VERSION}`,
        });
      }
      if (row.version === 22) {
        this.migrateNotebookGrid(applyV22NotebookGridMigration, 22);
        row = { version: SCHEMA_VERSION };
      }
      if (row.version === 23) {
        this.migrateNotebookGrid(applyV23NotebookGridMigration, 23);
        row = { version: SCHEMA_VERSION };
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
      this.ensureIgnorePatterns();
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
    this.verifyCleanSemanticWorktree();
  }

  private migrateNotebookGrid(
    apply: (db: DatabaseSync) => unknown,
    fromVersion: number,
  ): void {
    apply(this.db);
    const status = this.db.doltStatus();
    this.assertOnlyVersionedStaged(status);
    const dirty = uniqueSemanticTables(
      status
        .map((entry) => entry.table_name)
        .filter(isSemanticTable)
        .filter((table) => this.hasWorkingDiff(table)),
    );
    this.stageTables(
      dirty.length > 0 ? dirty : ["cells", "engine_schema"],
    );
    this.sqlCommit(
      `Migrate notebook grid from schema ${fromVersion} to ${SCHEMA_VERSION}`,
    );
  }

  private ensureIgnorePatterns(): void {
    const insert = this.db.prepare(
      `INSERT INTO dolt_ignore(pattern, ignored)
       SELECT ?, 1
       WHERE NOT EXISTS(
         SELECT 1 FROM dolt_ignore WHERE pattern = ?
       )`,
    );
    for (const pattern of IGNORE_PATTERNS) insert.run(pattern, pattern);
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
        track_id, sequence_id, kind, order_key, name,
        enabled, locked, muted, solo, blend_mode
      ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    );
    const videoKeys = initialOrderKeys(2);
    insertTrack.run(
      uuidv7(),
      sequenceId,
      "video",
      videoKeys[0],
      "Video 1",
      null,
      null,
      "normal",
    );
    insertTrack.run(
      uuidv7(),
      sequenceId,
      "video",
      videoKeys[1],
      "Video 2",
      null,
      null,
      "normal",
    );
    const audioKeys = initialOrderKeys(4);
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      insertTrack.run(
        uuidv7(),
        sequenceId,
        "audio",
        audioKeys[ordinal],
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
      initialOrderKeys(1)[0],
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
    const declared = parseOutboxTables(row.tables_json);
    const dirty = declared.tables.filter((table) => this.hasWorkingDiff(table));
    if (dirty.length === 0 && !declared.allowEmpty) {
      // Either the mutation only touched ignored runtime tables (bookkeeping
      // mints no commit), or this is recovery after a crash that followed the
      // dolt commit. Either way only the outbox row is left to clear.
      this.clearOutboxRow(operationId);
      return this.head;
    }
    // One status scan guards the staging boundary: anything already staged
    // must be on the allowlist (a runtime table here is corruption), and a
    // dirty dolt_ignore rides along with the commit. Our own dolt_add calls
    // below stage allowlisted tables only, so the pre-staging snapshot
    // covers the post-staging assertion too.
    const status = this.db.doltStatus();
    this.assertOnlyVersionedStaged(status);
    this.stageTables(dirty);
    if (
      status.some(
        (entry) => entry.table_name === "dolt_ignore" && entry.staged === 0,
      )
    ) {
      this.db.prepare("SELECT dolt_add('dolt_ignore') AS result").get();
    }
    const revision = this.sqlCommit(row.message, dirty.length === 0);
    this.semanticCommitBoundary?.("after-dolt-commit", operationId);
    // The commit is durable at this point: clear the outbox row before
    // asserting, so a failed assertion can neither strand the row nor
    // re-attribute this operation's rows to a later commit at recovery.
    this.clearOutboxRow(operationId);
    this.assertCommittedTablesClean(dirty, revision);
    return revision;
  }

  private clearOutboxRow(operationId: string): void {
    // A single-statement delete on a runtime table; the full runtime()
    // pre-flight would re-scan doltStatus on every semantic write for no
    // added safety.
    this.begin();
    try {
      this.db
        .prepare("DELETE FROM runtime_commit_outbox WHERE operation_id = ?")
        .run(operationId);
      this.commitSql();
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private sqlCommit(message: string, allowEmpty = false): string {
    const statement = allowEmpty
      ? "SELECT dolt_commit('--allow-empty', '-m', ?, '--author', ?) AS hash"
      : "SELECT dolt_commit('-m', ?, '--author', ?) AS hash";
    const row = this.db
      .prepare(statement)
      .get(message, this.author) as unknown as CommitRow | undefined;
    const hash = row?.hash;
    if (!hash) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: "Dolt commit did not return a revision hash",
      });
    }
    return hash;
  }

  private stageTables(tables: readonly SemanticTable[]): void {
    // One dolt_add per table: the multi-argument form silently falls back
    // to staging every table doltStatus over-reports as modified, which
    // would commit unrelated storage noise (and, worse, ride over the
    // runtime-table fence).
    const unique = uniqueSemanticTables(tables);
    for (const table of unique) {
      this.db.prepare("SELECT dolt_add(?) AS result").get(table);
    }
  }

  /**
   * Full-catalog integrity sweep, run once per open (after outbox
   * recovery). Semantic writes only probe and stage the tables their
   * operation declared, so rows written to an undeclared table would sit
   * in the working set indefinitely; this sweep turns that engine bug into
   * a loud fault at the next open instead of silent attribution drift.
   *
   * doltStatus over-reports (doltlite flags index-bearing tables as
   * modified while any untracked table exists), so every candidate is
   * confirmed against the row-level diff probe before faulting.
   */
  private verifyCleanSemanticWorktree(): void {
    const dirty: SemanticTable[] = [];
    for (const entry of this.db.doltStatus()) {
      if (entry.staged !== 0 || entry.status === "ignored") continue;
      if (!isSemanticTable(entry.table_name)) continue;
      if (this.hasWorkingDiff(entry.table_name)) {
        dirty.push(entry.table_name);
      }
    }
    if (dirty.length > 0) {
      this.db.close();
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message:
          "Semantic worktree has uncommitted changes not attributed to any operation: " +
          dirty.join(", "),
        details: { dirtyTables: dirty },
      });
    }
  }

  /**
   * True when `table` still has uncommitted working-set rows.
   *
   * This is the hot path of every semantic write: each declared table is
   * probed once before staging and once after the commit. Staged-but-
   * uncommitted rows also report `to_commit = 'WORKING'`, which is what
   * makes the same probe correct during outbox recovery.
   *
   * The direct check, `doltDiff("HEAD","WORKING",t).length > 0`, materialises
   * every changed row just to test emptiness. Asking the `dolt_diff_<table>`
   * system table for a single row answers the identical question about 4x
   * faster and allocates nothing. The statement is cached per table because
   * preparing it each time cost more than running it, and repeated probes of
   * the same table hit a doltlite-internal cache (~0.01ms) while probing
   * many distinct tables in sequence thrashes it (~0.6ms each) — another
   * reason writes probe only their declared tables.
   *
   * `table` is a SemanticTable, i.e. a member of the SEMANTIC_TABLES
   * allowlist, so interpolating it into the statement cannot inject SQL.
   */
  private hasWorkingDiff(table: SemanticTable): boolean {
    let probe = this.workingDiffProbes.get(table);
    if (!probe) {
      probe = this.db.prepare(
        `SELECT 1 AS present FROM dolt_diff_${table}
         WHERE to_commit = 'WORKING' LIMIT 1`,
      );
      this.workingDiffProbes.set(table, probe);
    }
    return Boolean(probe.get());
  }

  private assertCommittedTablesClean(
    tables: readonly SemanticTable[],
    committedRevision: string,
  ): void {
    const dirty = tables.filter((table) => this.hasWorkingDiff(table));
    if (dirty.length > 0) {
      throw new EngineFault({
        code: "STORAGE_ERROR",
        message: "Semantic worktree is dirty after commit: " + dirty.join(", "),
        details: { committedRevision, dirtyTables: dirty },
      });
    }
  }

  private assertOnlyVersionedStaged(
    status: DoltStatusEntry[] = this.db.doltStatus(),
  ): void {
    for (const entry of status) {
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
      .find((entry) => entry.staged === 1 && runtime.has(entry.table_name));
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

export interface CommitOperation {
  operation: string;
  operationId: string;
  artifactId?: string;
  baseRevision?: string;
  actor?: string;
  writeSet: string[];
  details: Record<string, unknown>;
}

// The commit is the provenance record: the subject names the operation (and
// the artifact it targeted), and git-style trailers carry the operation ID,
// base revision, actor, write set, and parameters as canonical JSON.
//
// doltlite rejects commit messages of 65536 bytes or more, so oversized
// payloads degrade deterministically: the details trailer is dropped first
// (a `details-omitted` trailer records its size), then the write-set trailer
// (a `write-set-omitted` trailer records its size). History and conflict
// projections treat omitted trailers as empty.
const MAX_COMMIT_MESSAGE_BYTES = 65_024;

function commitMessage(input: OperationInput, operationId: string): string {
  const message = buildCommitMessage(input, operationId, true, true);
  if (byteLength(message) < MAX_COMMIT_MESSAGE_BYTES) return message;
  const withoutDetails = buildCommitMessage(input, operationId, false, true);
  if (byteLength(withoutDetails) < MAX_COMMIT_MESSAGE_BYTES) {
    return withoutDetails;
  }
  const minimal = buildCommitMessage(input, operationId, false, false);
  if (byteLength(minimal) >= MAX_COMMIT_MESSAGE_BYTES) {
    throw new EngineFault({
      code: "STORAGE_ERROR",
      message: `Commit message for ${input.operation} exceeds the Dolt size limit`,
    });
  }
  return minimal;
}

// Trailer values are single-line by construction: canonicalJson escapes
// newlines inside JSON, and every scalar value (operation, artifact ID,
// base revision, actor) is rejected if it carries a control character —
// otherwise a crafted actor could inject forged trailer lines.
function assertSafeTrailerValue(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new EngineFault({
      code: "INVALID_INPUT",
      message: `${label} must not contain control characters`,
    });
  }
}

function buildCommitMessage(
  input: OperationInput,
  operationId: string,
  includeDetails: boolean,
  includeWriteSet: boolean,
): string {
  assertSafeTrailerValue(input.operation, "Operation name");
  if (input.artifactId) assertSafeTrailerValue(input.artifactId, "Artifact ID");
  if (input.baseRevision) {
    assertSafeTrailerValue(input.baseRevision, "Base revision");
  }
  if (input.author) assertSafeTrailerValue(input.author, "Actor");
  const target = input.artifactId ? ` artifact:${input.artifactId}` : "";
  const trailers = [`op-id: ${operationId}`];
  if (input.baseRevision) trailers.push(`base-revision: ${input.baseRevision}`);
  const writeSetJson = canonicalJson(input.writeSet ?? []);
  if (includeWriteSet && input.writeSet && input.writeSet.length > 0) {
    trailers.push(`write-set: ${writeSetJson}`);
  } else if (!includeWriteSet && input.writeSet && input.writeSet.length > 0) {
    trailers.push(`write-set-omitted: ${byteLength(writeSetJson)}`);
  }
  const detailsJson = canonicalJson(input.details ?? {});
  if (
    includeDetails &&
    input.details &&
    Object.keys(input.details).length > 0
  ) {
    trailers.push(`details: ${detailsJson}`);
  } else if (
    !includeDetails &&
    input.details &&
    Object.keys(input.details).length > 0
  ) {
    trailers.push(`details-omitted: ${byteLength(detailsJson)}`);
  }
  // The caller-influenced actor value is emitted last and the parser is
  // first-occurrence-wins, so even a hostile value that slips past
  // validation can never override an engine-emitted trailer.
  if (input.author) trailers.push(`actor: ${input.author}`);
  return `${input.operation}${target}\n\n${trailers.join("\n")}`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// doltlite reports commit dates as "YYYY-MM-DD HH:MM:SS" in UTC.
export function commitDateMs(date: string): number {
  const parsed = Date.parse(`${date.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** doltlite commit date normalized to an ISO-8601 UTC timestamp. */
export function commitDateIso(date: string): string {
  const parsed = Date.parse(`${date.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? date : new Date(parsed).toISOString();
}

export function parseCommitMessage(message: string): CommitOperation | null {
  const lines = message.split("\n");
  const subject = lines[0] ?? "";
  const trailers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([a-z-]+): (.*)$/.exec(line);
    // First occurrence wins: engine trailers precede the caller-influenced
    // actor trailer, so injected duplicates can never shadow them.
    if (match && !trailers.has(match[1]!)) trailers.set(match[1]!, match[2]!);
  }
  const operationId = trailers.get("op-id");
  if (!operationId) return null;
  let operation = subject;
  let artifactId: string | undefined;
  const artifactMarker = subject.lastIndexOf(" artifact:");
  if (artifactMarker > 0) {
    operation = subject.slice(0, artifactMarker);
    artifactId = subject.slice(artifactMarker + " artifact:".length);
  }
  if (!operation) return null;
  const baseRevision = trailers.get("base-revision");
  const actor = trailers.get("actor");
  return {
    operation,
    operationId,
    ...(artifactId ? { artifactId } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    ...(actor ? { actor } : {}),
    writeSet: parseJson<string[]>(trailers.get("write-set") ?? "[]", []),
    details: parseJson<Record<string, unknown>>(
      trailers.get("details") ?? "{}",
      {},
    ),
  };
}

function parseDoltGcSummary(summary: string): {
  chunksRemoved: number | null;
  chunksKept: number | null;
} {
  const match = /(\d+)\s+chunks removed,\s+(\d+)\s+chunks kept/i.exec(summary);
  if (!match) return { chunksRemoved: null, chunksKept: null };
  return {
    chunksRemoved: Number(match[1]),
    chunksKept: Number(match[2]),
  };
}

function isSemanticTable(table: string): table is SemanticTable {
  return (SEMANTIC_TABLES as readonly string[]).includes(table);
}

interface OutboxTables {
  tables: SemanticTable[];
  allowEmpty: boolean;
}

/**
 * Decodes the declared write set persisted with an outbox row. Rows written
 * before write sets were declared carried a bare array (empty, or holding
 * only the allow-empty flag); recovering one of those probes the full
 * allowlist because the written tables are unknown.
 */
function parseOutboxTables(text: string): OutboxTables {
  const parsed = parseJson<unknown>(text, []);
  if (Array.isArray(parsed)) {
    return {
      tables: [...SEMANTIC_TABLES],
      allowEmpty: parsed.includes(OUTBOX_ALLOW_EMPTY_FLAG),
    };
  }
  const record = parsed as { tables?: unknown; allowEmpty?: unknown };
  return {
    tables: Array.isArray(record.tables)
      ? record.tables.filter(
          (table): table is SemanticTable =>
            typeof table === "string" && isSemanticTable(table),
        )
      : [...SEMANTIC_TABLES],
    allowEmpty: record.allowEmpty === true,
  };
}

function uniqueSemanticTables(
  tables: readonly SemanticTable[],
): SemanticTable[] {
  return [...new Set(tables)];
}
