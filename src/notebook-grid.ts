import type { NotebookGridSlot } from "./notebook/types.js";
import { NOTEBOOK_GRID_ADDRESS_PATTERN } from "./notebook-mentions.js";

export const NOTEBOOK_GRID_ROW_COUNT = 26;
export const NOTEBOOK_GRID_COLUMN_COUNT = 13;
export const NOTEBOOK_GRID_CAPACITY =
  NOTEBOOK_GRID_ROW_COUNT * NOTEBOOK_GRID_COLUMN_COUNT;
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
    throw new Error(`${label} must be within @a1-@z13`);
  }
}

export function notebookGridAddress(slot: NotebookGridSlot): string {
  assertNotebookGridSlot(slot);
  return `${String.fromCharCode(97 + slot.row)}${slot.column + 1}`;
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
    row: address[0]!.toLowerCase().charCodeAt(0) - 97,
    column: Number(address.slice(1)) - 1,
  };
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
  const occupiedKeys = new Set<string>();
  for (const slot of occupied) {
    assertNotebookGridSlot(slot);
    occupiedKeys.add(`${slot.row}:${slot.column}`);
  }
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
