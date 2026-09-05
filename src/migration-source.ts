import { constants, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@dolthub/doltlite";
import { EngineFault } from "./store.js";

export function openV4SourceSnapshot(root: string): { database: DatabaseSync; close: () => void } {
  const source = join(root, "data", "videobook.db");
  const directory = mkdtempSync(join(tmpdir(), "videobook-v4-inspect-"));
  try {
    const before = statSync(source, { bigint: true });
    const target = join(directory, "videobook.db");
    // Keep native connections and deferred statement cleanup off the legacy file.
    copyFileSync(source, target, constants.COPYFILE_FICLONE);
    const after = statSync(source, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new EngineFault({ code: "STALE_REVISION", message: "Schema-v4 catalog changed while its inspection snapshot was copied" });
    }
    const database = new DatabaseSync(target, { readOnly: true });
    let closed = false;
    return { database, close: () => {
      if (closed) return;
      closed = true;
      try { database.close(); }
      finally { rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); }
    } };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}
