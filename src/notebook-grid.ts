import type { NotebookGridSlot } from "./notebook/types.js";
import { NOTEBOOK_GRID_ADDRESS_PATTERN } from "./notebook-mentions.js";

export const NOTEBOOK_GRID_ROW_COUNT = 64;
export const NOTEBOOK_GRID_COLUMN_COUNT = 8;
export const NOTEBOOK_GRID_CAPACITY =
  NOTEBOOK_GRID_ROW_COUNT * NOTEBOOK_GRID_COLUMN_COUNT;
export const NOTEBOOK_GRID_ADDRESS_RANGE = "@a1-@h64";
export const NOTEBOOK_GRID_FULL_ERROR = "Notebook grid is full";

export function isNotebookGridSlot(
  slot: NotebookGridSlot,
): boolean {
  return Number.isInteger(slot.row)
    && slot.row >= 0
    && slot.row < NOTEBOOK_GRID_ROW_COUNT
    && Number.isInteger(slot.column)
    && slot.column >= 0
    && slot.column < NOTEBOOK_GRID_COLUMN_COUNT;
}

export function assertNotebookGridSlot(
  slot: NotebookGridSlot,
  label = "Notebook grid slot",
): void {
  if (!isNotebookGridSlot(slot)) {
    throw new Error(`${label} must be within ${NOTEBOOK_GRID_ADDRESS_RANGE}`);
  }
}

export function notebookGridAddress(slot: NotebookGridSlot): string {
  assertNotebookGridSlot(slot);
  return `${String.fromCharCode(97 + slot.column)}${slot.row + 1}`;
}

export function notebookGridTag(slot: NotebookGridSlot): string {
  return `@${notebookGridAddress(slot)}`;
}

export function parseNotebookGridAddress(
  value: string,
): NotebookGridSlot | undefined {
  const match = NOTEBOOK_GRID_ADDRESS_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const address = match[1]!;
  return {
    column: address[0]!.toLowerCase().charCodeAt(0) - 97,
    row: Number(address.slice(1)) - 1,
  };
}

function occupiedNotebookGridKeys(
  occupied: Iterable<NotebookGridSlot>,
): Set<string> {
  const occupiedKeys = new Set<string>();
  for (const slot of occupied) {
    assertNotebookGridSlot(slot);
    occupiedKeys.add(`${slot.row}:${slot.column}`);
  }
  return occupiedKeys;
}

export function firstEmptyNotebookGridSlot(
  occupied: Iterable<NotebookGridSlot>,
): NotebookGridSlot {
  return firstEmptyNotebookGridSlots(occupied, 1)[0]!;
}

export function firstEmptyNotebookGridSlots(
  occupied: Iterable<NotebookGridSlot>,
  count: number,
): NotebookGridSlot[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error("Notebook grid slot count must be a nonnegative integer");
  }
  if (count === 0) return [];
  const occupiedKeys = occupiedNotebookGridKeys(occupied);
  const result: NotebookGridSlot[] = [];
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (occupiedKeys.has(`${row}:${column}`)) continue;
      result.push({ row, column });
      if (result.length === count) return result;
    }
  }
  if (result.length === count) return result;
  throw new Error(NOTEBOOK_GRID_FULL_ERROR);
}

/**
 * Free slot minimizing Manhattan distance from @a1.
 * Ties break by lower row, then lower column (address order among equals).
 */
export function nearestOriginNotebookGridSlot(
  occupied: Iterable<NotebookGridSlot>,
): NotebookGridSlot {
  const occupiedKeys = occupiedNotebookGridKeys(occupied);
  let best: NotebookGridSlot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (occupiedKeys.has(`${row}:${column}`)) continue;
      const distance = row + column;
      if (
        best === null
        || distance < bestDistance
        || (
          distance === bestDistance
          && (
            row < best.row
            || (row === best.row && column < best.column)
          )
        )
      ) {
        best = { row, column };
        bestDistance = distance;
      }
    }
  }
  if (!best) throw new Error(NOTEBOOK_GRID_FULL_ERROR);
  return best;
}

/**
 * Next free slot scanning down the row axis from `anchor` (inclusive).
 * Same column first; when exhausted, spill rightward column-by-column from
 * the anchor row; then origin-proximity fallback.
 */
export function nextVerticalSlotFrom(
  anchor: NotebookGridSlot,
  occupied: Iterable<NotebookGridSlot>,
): NotebookGridSlot {
  assertNotebookGridSlot(anchor);
  const occupiedKeys = occupiedNotebookGridKeys(occupied);
  for (let row = anchor.row; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    if (!occupiedKeys.has(`${row}:${anchor.column}`)) {
      return { row, column: anchor.column };
    }
  }
  for (
    let column = anchor.column + 1;
    column < NOTEBOOK_GRID_COLUMN_COUNT;
    column += 1
  ) {
    for (let row = anchor.row; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
      if (!occupiedKeys.has(`${row}:${column}`)) {
        return { row, column };
      }
    }
  }
  return nearestOriginNotebookGridSlot(occupied);
}

/**
 * Next free slot scanning right along the column axis from `anchor` (inclusive).
 * Same row first; when exhausted, spill downward row-by-row from the anchor
 * column; then origin-proximity fallback.
 */
export function nextHorizontalSlotFrom(
  anchor: NotebookGridSlot,
  occupied: Iterable<NotebookGridSlot>,
): NotebookGridSlot {
  assertNotebookGridSlot(anchor);
  const occupiedKeys = occupiedNotebookGridKeys(occupied);
  for (
    let column = anchor.column;
    column < NOTEBOOK_GRID_COLUMN_COUNT;
    column += 1
  ) {
    if (!occupiedKeys.has(`${anchor.row}:${column}`)) {
      return { row: anchor.row, column };
    }
  }
  for (let row = anchor.row + 1; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (
      let column = anchor.column;
      column < NOTEBOOK_GRID_COLUMN_COUNT;
      column += 1
    ) {
      if (!occupiedKeys.has(`${row}:${column}`)) {
        return { row, column };
      }
    }
  }
  return nearestOriginNotebookGridSlot(occupied);
}

/**
 * Wave placement for generation tiles: scan `waveRow` left-to-right from
 * `startColumn` for a slot whose below-neighbor is also free (room for the
 * tile's output cell directly beneath), advancing row by row while both stay
 * within the board; origin-proximity fallback when no pair fits.
 */
export function nextWaveTileSlot(
  waveRow: number,
  startColumn: number,
  occupied: Iterable<NotebookGridSlot>,
): NotebookGridSlot {
  const occupiedKeys = occupiedNotebookGridKeys(occupied);
  const firstRow = Math.min(
    Math.max(0, Math.trunc(waveRow)),
    NOTEBOOK_GRID_ROW_COUNT - 1,
  );
  const firstColumn = Math.min(
    Math.max(0, Math.trunc(startColumn)),
    NOTEBOOK_GRID_COLUMN_COUNT - 1,
  );
  for (let row = firstRow; row + 1 < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (
      let column = firstColumn;
      column < NOTEBOOK_GRID_COLUMN_COUNT;
      column += 1
    ) {
      if (occupiedKeys.has(`${row}:${column}`)) continue;
      if (occupiedKeys.has(`${row + 1}:${column}`)) continue;
      return { row, column };
    }
  }
  return nearestOriginNotebookGridSlot(occupied);
}
