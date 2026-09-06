import type { DatabaseSync, MergeResult } from "@dolthub/doltlite";

import { EngineFault } from "./store.js";

/**
 * Merge policy per constraint class (ve-mim.6; see docs/engine-layout.md
 * "Merge policy per constraint class").
 *
 * doltlite facts this policy is built on (verified empirically):
 *
 * - `dolt_merge()` verifies the merged working set against UNIQUE, CHECK,
 *   and foreign-key constraints and, on any violation, rolls the whole
 *   merge back with "Committing this transaction resulted in a working set
 *   with constraint violations, transaction rolled back." There is no
 *   `dolt_verify_constraints()` in doltlite; the merge itself is the
 *   constraint verification, and `PRAGMA foreign_key_check` plus targeted
 *   scans are the post-merge verification primitives.
 *   `dolt_constraint_violations[_<table>]` views exist but stay empty
 *   because violating merges never commit.
 * - Same-row modifications on both sides refuse the merge with a conflict
 *   error; the working set and accepted head remain intact.
 *
 * Policy:
 *
 * 1. Precondition: both sides must carry the same `engine_schema.version`.
 *    Mismatches are refused with SCHEMA_INCOMPATIBLE before any merge is
 *    attempted (`assertSameSchemaVersion`).
 * 2. Artifact identity is `artifact_id` (UUIDv7), which is collision-free
 *    across forks, so merges have no name-conflict class. `artifacts.label`
 *    is non-unique display text and merges like any other column.
 * 3. RESTRICT foreign-key dangles (one fork deletes a row the other fork
 *    newly references) are caught by doltlite's merge-time working-set
 *    verification and surface as a typed MERGE_VIOLATION, never a raw
 *    IO_ERROR. `verifyConstraintHealth` re-checks referential integrity
 *    after every successful merge.
 * 4. `transcripts.state='current'` and `sequences.is_primary=1` are derived
 *    singletons: a merge of two forks that each crowned a different row
 *    yields duplicates, which `reconcileSingletonFlags` rewrites to a
 *    single deterministic winner after the merge. Transcripts: latest
 *    `created_at` wins, ties break on the lowest `transcript_id`.
 *    Sequences: earliest `created_at` wins (the original primary), ties
 *    break on the lowest `sequence_id`. Reads resolve the same winner
 *    deterministically (see `primarySequence` in src/sequences.ts), so the
 *    engine is consistent even before reconcile runs.
 */

interface MergePolicyOutcome {
  fastForward: boolean;
  /** Transcript rows demoted from current to derived by the reconcile. */
  reconciledTranscripts: number;
  /** Sequence rows demoted from primary by the reconcile. */
  reconciledSequences: number;
}

interface VersionRow {
  version: number;
}

const CONSTRAINT_VIOLATION_REFUSAL =
  /working set with constraint violations/;

// Policy scans are table-tolerant so the same code runs against a full
// engine catalog and against purpose-built merge databases that carry only
// the semantic tables their scenario needs (see ve-wsu).
function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table) !== undefined
  );
}

function schemaVersionAt(db: DatabaseSync, ref: string): number {
  const row = db
    .prepare("SELECT version FROM dolt_at_engine_schema(?) WHERE singleton=1")
    .get(ref) as unknown as VersionRow | undefined;
  if (!row) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message: `Ref ${ref} has no engine_schema version row`,
    });
  }
  return row.version;
}

/** Merge precondition: both sides must carry the same schema version. */
export function assertSameSchemaVersion(
  db: DatabaseSync,
  oursRef: string,
  theirsRef: string,
): void {
  const ours = schemaVersionAt(db, oursRef);
  const theirs = schemaVersionAt(db, theirsRef);
  if (ours !== theirs) {
    throw new EngineFault({
      code: "SCHEMA_INCOMPATIBLE",
      message:
        `Merge refused: schema version ${theirs} on ${theirsRef} does not ` +
        `match version ${ours} on ${oursRef}`,
      details: { oursRef, theirsRef, oursVersion: ours, theirsVersion: theirs },
    });
  }
}

/**
 * Rewrites merged duplicate singleton flags to a single deterministic
 * winner per group. Returns the number of demoted rows.
 */
export function reconcileSingletonFlags(db: DatabaseSync): {
  transcripts: number;
  sequences: number;
} {
  let transcripts = 0;
  if (tableExists(db, "transcripts")) {
    const transcriptGroups = db
      .prepare(
        `SELECT artifact_id, stream_id, object_hash
         FROM transcripts
         WHERE state='current'
         GROUP BY artifact_id, stream_id, object_hash
         HAVING COUNT(*) > 1`,
      )
      .all() as unknown as Array<{
      artifact_id: string;
      stream_id: string;
      object_hash: string;
    }>;
    const demoteTranscripts = db.prepare(
      `UPDATE transcripts SET state='derived'
       WHERE state='current'
         AND artifact_id=? AND stream_id=? AND object_hash=?
         AND transcript_id NOT IN (
           SELECT transcript_id FROM transcripts
           WHERE state='current'
             AND artifact_id=? AND stream_id=? AND object_hash=?
           ORDER BY created_at DESC, transcript_id ASC
           LIMIT 1
         )`,
    );
    for (const group of transcriptGroups) {
      transcripts += demoteTranscripts.run(
        group.artifact_id,
        group.stream_id,
        group.object_hash,
        group.artifact_id,
        group.stream_id,
        group.object_hash,
      ).changes;
    }
  }

  let sequences = 0;
  if (tableExists(db, "sequences")) {
    const sequenceGroups = db
      .prepare(
        `SELECT book_id
         FROM sequences
         WHERE is_primary=1
         GROUP BY book_id
         HAVING COUNT(*) > 1`,
      )
      .all() as unknown as Array<{ book_id: string }>;
    const demoteSequences = db.prepare(
      `UPDATE sequences SET is_primary=0
       WHERE is_primary=1
         AND book_id=?
         AND sequence_id NOT IN (
           SELECT sequence_id FROM sequences
           WHERE is_primary=1 AND book_id=?
           ORDER BY created_at ASC, sequence_id ASC
           LIMIT 1
         )`,
    );
    for (const group of sequenceGroups) {
      sequences += demoteSequences.run(group.book_id, group.book_id).changes;
    }
  }

  return { transcripts, sequences };
}

/**
 * Post-merge verification: referential integrity plus the invariants the
 * merge policy owns (single current transcript per source, single primary
 * sequence per book). Throws MERGE_VIOLATION on any breach.
 */
export function verifyConstraintHealth(db: DatabaseSync): void {
  const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all();
  const multipleCurrent = tableExists(db, "transcripts")
    ? (db
        .prepare(
          `SELECT artifact_id, stream_id, object_hash, COUNT(*) AS currents
           FROM transcripts
           WHERE state='current'
           GROUP BY artifact_id, stream_id, object_hash
           HAVING currents > 1`,
        )
        .all() as unknown as Array<{ artifact_id: string; currents: number }>)
    : [];
  const multiplePrimary = tableExists(db, "sequences")
    ? (db
        .prepare(
          `SELECT book_id, COUNT(*) AS primaries
           FROM sequences
           WHERE is_primary=1
           GROUP BY book_id
           HAVING primaries > 1`,
        )
        .all() as unknown as Array<{ book_id: string; primaries: number }>)
    : [];
  if (
    foreignKeyRows.length > 0 ||
    multipleCurrent.length > 0 ||
    multiplePrimary.length > 0
  ) {
    throw new EngineFault({
      code: "MERGE_VIOLATION",
      message: "Merged working set violates semantic constraints",
      details: {
        foreignKeyViolations: foreignKeyRows,
        multipleCurrentTranscripts: multipleCurrent,
        multiplePrimarySequences: multiplePrimary,
      },
    });
  }
}

function mapMergeError(branch: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (CONSTRAINT_VIOLATION_REFUSAL.test(message)) {
    // doltlite's merge-time verification refused and rolled back, so both
    // refs are still intact; surface the refusal as a typed violation.
    throw new EngineFault({
      code: "MERGE_VIOLATION",
      message:
        `Merge of ${branch} refused by Dolt constraint verification: ` +
        "the merged working set would violate UNIQUE, CHECK, or " +
        "foreign-key constraints (for example a RESTRICT reference to a " +
        "row deleted on the other side)",
      details: { branch, cause: message },
    });
  }
  if (/merge conflict|cannot merge: conflicts detected/i.test(message)) {
    throw new EngineFault({
      code: "MERGE_CONFLICT",
      message: `Merge of ${branch} has row-level conflicts: ${message}`,
      details: { branch, cause: message },
    });
  }
  throw error;
}

/**
 * Dolt-commits the singleton-flag reconcile, when it changed anything, so
 * the working set is clean for the next merge. Kept separate from the
 * merge commit because `dolt_merge()` finalizes its own commit before the
 * merged working set can be inspected.
 */
function commitReconcile(
  db: DatabaseSync,
  reconciled: { transcripts: number; sequences: number },
): void {
  const tables: string[] = [];
  if (reconciled.transcripts > 0) tables.push("transcripts");
  if (reconciled.sequences > 0) tables.push("sequences");
  if (tables.length === 0) return;
  for (const table of tables) {
    db.prepare("SELECT dolt_add(?) AS result").get(table);
  }
  db.prepare("SELECT dolt_commit('-m', ?) AS hash").get(
    `Reconcile merged singleton flags: ${tables.join(", ")}`,
  );
}

/**
 * Merges `branch` into HEAD under the engine merge policy: same-schema
 * precondition, Dolt constraint verification with typed errors,
 * deterministic singleton-flag reconcile, and a post-merge constraint
 * health check.
 *
 * The dedicated merge-back flow in src/fork.ts applies its projection
 * merge policies separately. The installed native dependency is also
 * checked against the complete catalog, including ignored runtime tables.
 */
export function mergeWithPolicy(
  db: DatabaseSync,
  branch: string,
): MergePolicyOutcome {
  assertSameSchemaVersion(db, "HEAD", branch);
  let result: MergeResult;
  try {
    result = db.doltMerge(branch);
  } catch (error) {
    mapMergeError(branch, error);
  }
  const reconciled = reconcileSingletonFlags(db);
  verifyConstraintHealth(db);
  commitReconcile(db, reconciled);
  return {
    fastForward: result.fast_forward === 1,
    reconciledTranscripts: reconciled.transcripts,
    reconciledSequences: reconciled.sequences,
  };
}
