import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

function fingerprint(databasePath: string): string {
  const stat = statSync(databasePath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function markerPath(databasePath: string): string { return `${databasePath}.gc.json`; }

export function isCatalogCompacted(databasePath: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(markerPath(databasePath), "utf8")) as { version?: unknown; fingerprint?: unknown };
    if (marker.version !== 1 || marker.fingerprint !== fingerprint(databasePath)) return false;
    for (const suffix of ["-wal", "-journal"]) {
      try { if (statSync(`${databasePath}${suffix}`).size > 0) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return true;
  } catch { return false; }
}

export function forgetCatalogCompaction(databasePath: string): void {
  try { rmSync(markerPath(databasePath), { force: true }); }
  catch { /* The file fingerprint still rejects markers after a catalog write. */ }
}

export function rememberCatalogCompaction(databasePath: string): void {
  const temporary = `${markerPath(databasePath)}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, fingerprint: fingerprint(databasePath) })}\n`);
    renameSync(temporary, markerPath(databasePath));
  } catch { /* Missing maintenance metadata falls back to automatic GC. */ }
  finally {
    try { rmSync(temporary, { force: true }); } catch { /* Best-effort cleanup. */ }
  }
}
