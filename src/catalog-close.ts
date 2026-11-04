import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { DatabaseSync } from "@dolthub/doltlite";

/**
 * Close a writable catalog connection so nothing can write into its directory
 * afterwards.
 *
 * `close()` is `sqlite3_close_v2`, and the wrapper cannot finalize a
 * `StatementSync`: only its garbage-collection destructor does. A connection
 * with a live statement therefore outlives `close()`, and its real close runs
 * whenever the collector gets there. Unless the store holds a clean-close marker
 * by then, that close takes the graph lock and appends one, which recreates
 * `.videobook.db-lock` if it was removed and changes the catalog file. Removing
 * a catalog right after close could fail with ENOTEMPTY or leave the lock file
 * behind, and a compaction record written at close could go stale.
 *
 * A peer connection has no statements, so its close is real and writes the
 * marker now, and the next read on `db` adopts it. The deferred close then has
 * nothing to write. It still holds file descriptors until collection.
 *
 * A peer writes nothing when the last commit added no chunks, such as a row
 * inserted and then deleted. The store is content-addressed, so that commit is a
 * bare root, which a peer reads as a marker already written, while `db` still
 * owes one for its own commit. `wrote` says `db` may have committed: if the peer
 * then appends nothing, a runtime write gives it a commit it can mark.
 */
export function closeCatalogDatabase(
  db: DatabaseSync,
  { wrote = false }: { wrote?: boolean } = {},
): void {
  const databasePath = db.location();
  try {
    // A deferred close would keep the transaction, and its write lock, too.
    if (db.inTransaction) db.exec("ROLLBACK");
    // A peer would create a catalog that has gone missing.
    if (databasePath && existsSync(databasePath)) {
      const size = statSync(databasePath).size;
      new DatabaseSync(databasePath).close();
      if (wrote && statSync(databasePath).size === size) {
        // A new value every time: a repeated one could reuse existing chunks.
        db.exec(
          `INSERT INTO runtime_meta(key, value_json, updated_at)
           VALUES ('clean_close', '"${randomUUID()}"', ${Date.now()})
           ON CONFLICT(key) DO UPDATE SET
             value_json=excluded.value_json,
             updated_at=excluded.updated_at`,
        );
        new DatabaseSync(databasePath).close();
      }
      db.exec("SELECT 1 FROM sqlite_schema LIMIT 1");
    }
  } catch {
    // Best-effort: the handle must still drop even if the catalog is unusable.
  }
  db.close();
}
