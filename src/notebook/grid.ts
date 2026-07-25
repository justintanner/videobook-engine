import type { NotebookGrid } from "./types.js";

function availableColumnId(
  ordinal: number,
  existing: ReadonlySet<string>,
): string {
  const base = `column-${ordinal}`;
  if (!existing.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export function extendNotebookGrid(
  grid: NotebookGrid,
  minimumColumnCount: number,
): NotebookGrid {
  if (
    !Number.isSafeInteger(minimumColumnCount)
    || minimumColumnCount < 1
  ) {
    throw new TypeError("minimumColumnCount must be a positive integer");
  }
  const columns = grid.columns.map((column) => ({ ...column }));
  const ids = new Set(columns.map((column) => column.id));
  while (columns.length < minimumColumnCount) {
    const id = availableColumnId(columns.length + 1, ids);
    ids.add(id);
    columns.push({ id });
  }
  return { columns };
}
