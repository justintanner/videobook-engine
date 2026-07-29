import type { EditOperation } from "./mvp-contracts.js";

export function isDestructiveEditOperation(
  operation: EditOperation,
): boolean {
  return operation.kind === "remove-range"
    || operation.kind === "batch-replace-range"
    || (operation.kind === "insert-clip" && operation.mode === "overwrite");
}
