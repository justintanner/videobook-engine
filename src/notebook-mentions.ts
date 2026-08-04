export const NOTEBOOK_GRID_ADDRESS_SOURCE = "[a-z](?:1[0-3]|[1-9])";

export const NOTEBOOK_GRID_ADDRESS_PATTERN = new RegExp(
  `^@?(${NOTEBOOK_GRID_ADDRESS_SOURCE})$`,
  "iu",
);
export const NOTEBOOK_MENTION_PATTERN = new RegExp(
  `@(${NOTEBOOK_GRID_ADDRESS_SOURCE})(?![\\w-])`,
  "giu",
);

export interface NotebookMention {
  raw: string;
  reference: string;
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

export function isNotebookGridAddress(value: string): boolean {
  return NOTEBOOK_GRID_ADDRESS_PATTERN.test(normalizeNotebookReference(value));
}

export function scanNotebookMentions(input: string): NotebookMention[] {
  return [...input.matchAll(NOTEBOOK_MENTION_PATTERN)].map((match) => {
    const raw = match[0];
    return {
      raw,
      reference: normalizeNotebookReference(match[1] ?? raw),
      index: match.index,
      end: match.index + raw.length,
    };
  });
}

export function notebookMentionPrefixAtEnd(input: string): string | undefined {
  const match = input.match(/@([a-z0-9]*)$/iu);
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
