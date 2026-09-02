import type { DatabaseSync } from "@dolthub/doltlite";

import { SCHEMA_VERSION } from "./catalog-metadata.js";
import type { NotebookGridSlot } from "./notebook/types.js";
import { rewriteCatalogMentions } from "./migrate-grid-text.js";
import { notebookGridAddress } from "./notebook-grid.js";

// Schema 23 labelled columns a-h and rows 1-64 (@a1-@h64). Schema 24 keeps
// the same 8x64 slots but letters the rows and numbers the columns, so every
// stored mention is re-encoded in place; no cell moves.
const V23_ADDRESS_SOURCE = "[a-h](?:6[0-4]|[1-5][0-9]|[1-9])";
const V23_MENTION_PATTERN = new RegExp(
  `@(${V23_ADDRESS_SOURCE})(?![\\w-])`,
  "giu",
);
const V23_ADDRESS_PATTERN = new RegExp(`^${V23_ADDRESS_SOURCE}$`, "iu");

interface V23GridMigrationResult {
  rewritten: number;
}

export function parseV23GridAddress(
  value: string,
): NotebookGridSlot | undefined {
  const address = value.trim().replace(/^@/u, "").toLowerCase();
  if (!V23_ADDRESS_PATTERN.test(address)) return undefined;
  return {
    column: address.charCodeAt(0) - 97,
    row: Number(address.slice(1)) - 1,
  };
}

export function rewriteV23Mentions(text: string): string {
  return text.replace(V23_MENTION_PATTERN, (raw: string, address: string) => {
    const slot = parseV23GridAddress(address);
    return slot ? `@${notebookGridAddress(slot)}` : raw;
  });
}

export function applyV23NotebookGridMigration(
  db: DatabaseSync,
): V23GridMigrationResult {
  const rewritten = rewriteCatalogMentions(db, () => rewriteV23Mentions);
  db.prepare("UPDATE engine_schema SET version=? WHERE singleton=1")
    .run(SCHEMA_VERSION);
  return { rewritten };
}
