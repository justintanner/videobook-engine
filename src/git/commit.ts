import { catalogForProjectDir } from "../storage/context.js";

export type CommitResult =
  | { status: "committed"; hash: string }
  /** Nothing to commit — the operation produced no on-disk diff. */
  | { status: "clean" }
  | { status: "failed"; message: string };

export async function commitOperation(
  projectDir: string,
  operation: string,
  assetId?: string,
  details?: Record<string, unknown>,
  gitPath?: string,
  allowEmpty?: boolean,
  paths?: string[],
): Promise<CommitResult> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) return { status: "failed", message: "Catalog not registered" };
  try {
    const revision = await catalog.snapshotProject(projectDir, {
      operation,
      ...(assetId ? { assetId } : {}),
      ...(details ? { details } : {}),
      ...(allowEmpty ? { allowEmpty } : {}),
      ...(paths ? { paths } : {}),
    });
    return revision
      ? { status: "committed", hash: revision.hash }
      : { status: "clean" };
  } catch (error: unknown) {
    return { status: "failed", message: (error as Error).message };
  }
}
