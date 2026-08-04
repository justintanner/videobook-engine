export const NOTEBOOK_GRID_ADDRESS_SOURCE = "[a-z](?:1[0-3]|[1-9])";
export const NOTEBOOK_ASSET_SLUG_SOURCE =
  "[a-z0-9]+(?:[-_][a-z0-9]+)+";
export const NOTEBOOK_CELL_REFERENCE_SOURCE = "[a-z0-9][a-z0-9_-]*";
export const NOTEBOOK_REFERENCE_SOURCE =
  `(?:${NOTEBOOK_GRID_ADDRESS_SOURCE}|${NOTEBOOK_ASSET_SLUG_SOURCE})`;

export const NOTEBOOK_GRID_ADDRESS_PATTERN = new RegExp(
  `^@?(${NOTEBOOK_GRID_ADDRESS_SOURCE})$`,
  "iu",
);
export const NOTEBOOK_ASSET_SLUG_PATTERN = new RegExp(
  `^@?(${NOTEBOOK_ASSET_SLUG_SOURCE})$`,
  "iu",
);
export const NOTEBOOK_MENTION_PATTERN = new RegExp(
  `@(${NOTEBOOK_GRID_ADDRESS_SOURCE}|${NOTEBOOK_CELL_REFERENCE_SOURCE})(?![\\w-])`,
  "giu",
);

export type NotebookMentionKind =
  | "grid"
  | "asset-slug"
  | "cell-slug/id-prefix";

export interface NotebookMention {
  raw: string;
  reference: string;
  kind: NotebookMentionKind;
  index: number;
  end: number;
}

export interface NotebookMentionReplacement {
  reference: string;
  replacement: string;
}

export function normalizeNotebookReference(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

export function classifyNotebookReference(
  value: string,
): NotebookMentionKind | undefined {
  const reference = normalizeNotebookReference(value);
  if (!reference) return undefined;
  if (NOTEBOOK_GRID_ADDRESS_PATTERN.test(reference)) return "grid";
  if (NOTEBOOK_ASSET_SLUG_PATTERN.test(reference)) return "asset-slug";
  if (new RegExp(`^${NOTEBOOK_CELL_REFERENCE_SOURCE}$`, "iu").test(reference)) {
    return "cell-slug/id-prefix";
  }
  return undefined;
}

export function scanNotebookMentions(input: string): NotebookMention[] {
  return [...input.matchAll(NOTEBOOK_MENTION_PATTERN)].map((match) => {
    const raw = match[0];
    const reference = normalizeNotebookReference(match[1] ?? raw);
    return {
      raw,
      reference,
      kind: classifyNotebookReference(reference)!,
      index: match.index,
      end: match.index + raw.length,
    };
  });
}

export function notebookMentionPrefixAtEnd(input: string): string | undefined {
  const match = input.match(/@([a-z0-9_-]*)$/iu);
  return match ? normalizeNotebookReference(match[1] ?? "") : undefined;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceNotebookMentions(
  input: string,
  replacements: readonly NotebookMentionReplacement[],
): string {
  let output = input;
  const ordered = [...replacements]
    .map(({ reference, replacement }) => ({
      reference: normalizeNotebookReference(reference),
      replacement,
    }))
    .filter(({ reference }) => reference.length > 0)
    .sort((left, right) => right.reference.length - left.reference.length);
  for (const { reference, replacement } of ordered) {
    output = output.replace(
      new RegExp(`@${escapePattern(reference)}(?![\\w-])`, "giu"),
      replacement,
    );
  }
  return output;
}

export function stripNotebookMentions(
  input: string,
  references: readonly string[],
): string {
  let output = input;
  const ordered = references
    .map(normalizeNotebookReference)
    .filter((reference) => reference.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const reference of ordered) {
    output = output.replace(
      new RegExp(` ?@${escapePattern(reference)}(?![\\w-])`, "giu"),
      "",
    );
  }
  return output;
}
