import type {
  EngineError,
  Result,
  StorageStatus,
} from "./engine-types.js";
import { ok } from "./engine-types.js";
import { EngineContext, resultOf } from "./context.js";
import { canonicalJson, parseJson } from "./store.js";

interface PendingObjectRow {
  object_hash: string;
  size_bytes: number;
}

export function createStorageApi(context: EngineContext) {
  return {
    status: (): StorageStatus => storageStatus(context),
    backup: (): Promise<Result<StorageStatus, EngineError>> =>
      backup(context),
  };
}

function storageStatus(context: EngineContext): StorageStatus {
  const configured = Boolean(
    context.config.remoteObjects || context.config.catalogBackup,
  );
  const head = context.store.head;
  if (!configured) {
    return { state: "unconfigured", head, pendingObjects: 0 };
  }
  const pendingObjects = countPendingObjects(context);
  const lastHead = runtimeValue<string | null>(
    context,
    "last_backup_head",
    null,
  );
  const recordedState = runtimeValue<
    StorageStatus["state"] | null
  >(context, "backup_state", null);
  const lastError = runtimeValue<string | null>(
    context,
    "backup_error",
    null,
  );
  const state =
    recordedState === "offline" || recordedState === "diverged"
      ? recordedState
      : pendingObjects > 0 || lastHead !== head
        ? "pending"
        : "backed_up";
  return {
    state,
    head,
    pendingObjects,
    ...(lastError ? { lastError } : {}),
  };
}

async function backup(
  context: EngineContext,
): Promise<Result<StorageStatus, EngineError>> {
  return resultOf(async () => {
    if (!context.config.remoteObjects && !context.config.catalogBackup) {
      return ok(storageStatus(context));
    }
    setBackupState(context, "pending", null);
    try {
      if (context.config.remoteObjects) {
        const pending = pendingObjects(context);
        for (const object of pending) {
          await context.objects.publish(
            object.object_hash,
            object.size_bytes,
          );
          context.store.runtime((now) => {
            context.store.db
              .prepare(
                `INSERT INTO runtime_object_publications(
                  object_hash, published_at
                ) VALUES (?, ?)
                ON CONFLICT(object_hash) DO UPDATE SET
                  published_at=excluded.published_at`,
              )
              .run(object.object_hash, now);
          });
        }
      }
      if (context.config.catalogBackup) {
        context.store.push(context.config.catalogBackup.name);
      }
      setRuntimeValue(
        context,
        "last_backup_head",
        context.store.head,
      );
      setBackupState(context, "backed_up", null);
      return ok(storageStatus(context));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const state = /diverg|non-fast-forward|fetch first/i.test(message)
        ? "diverged"
        : "offline";
      setBackupState(context, state, message);
      return {
        ok: false,
        error: {
          code: state === "diverged" ? "DIVERGED" : "OFFLINE",
          message,
        },
      };
    }
  });
}

function pendingObjects(context: EngineContext): PendingObjectRow[] {
  if (!context.config.remoteObjects) return [];
  return context.store.db
    .prepare(
      `SELECT o.object_hash, o.size_bytes
       FROM objects o
       LEFT JOIN runtime_object_publications p
         ON p.object_hash=o.object_hash
       WHERE p.object_hash IS NULL
       ORDER BY o.created_at, o.object_hash`,
    )
    .all() as unknown as PendingObjectRow[];
}

function countPendingObjects(context: EngineContext): number {
  if (!context.config.remoteObjects) return 0;
  const row = context.store.db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM objects o
       LEFT JOIN runtime_object_publications p
         ON p.object_hash=o.object_hash
       WHERE p.object_hash IS NULL`,
    )
    .get() as unknown as { count: number };
  return row.count;
}

function runtimeValue<T>(
  context: EngineContext,
  key: string,
  fallback: T,
): T {
  const row = context.store.db
    .prepare("SELECT value_json FROM runtime_meta WHERE key=?")
    .get(key) as unknown as { value_json: string } | undefined;
  return row ? parseJson<T>(row.value_json, fallback) : fallback;
}

function setRuntimeValue(
  context: EngineContext,
  key: string,
  value: unknown,
): void {
  context.store.runtime((now) => {
    context.store.db
      .prepare(
        `INSERT INTO runtime_meta(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json=excluded.value_json,
           updated_at=excluded.updated_at`,
      )
      .run(key, canonicalJson(value), now);
  });
}

function setBackupState(
  context: EngineContext,
  state: StorageStatus["state"],
  error: string | null,
): void {
  context.store.runtime((now) => {
    const statement = context.store.db.prepare(
      `INSERT INTO runtime_meta(key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json=excluded.value_json,
         updated_at=excluded.updated_at`,
    );
    statement.run("backup_state", canonicalJson(state), now);
    statement.run("backup_error", canonicalJson(error), now);
  });
}
