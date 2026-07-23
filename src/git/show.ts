import * as path from "node:path";

import { catalogForProjectDir } from "../storage/context.js";
import { type FsError, type Result, err, ok } from "../types.js";
import { isSafeFilename, isSafePath, invalidInput } from "../validation.js";

const REVISION_RE = /^[a-f0-9]{7,64}$/i;

export async function readFileAtCommit(
  projectDir: string,
  assetId: string,
  filename: string,
  commitHash: string,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  void gitPath;
  if (!isSafePath(assetId)) return invalidInput(`Invalid asset ID: ${assetId}`);
  if (!isSafeFilename(filename)) {
    return invalidInput(`Invalid filename: ${filename}`);
  }
  if (!REVISION_RE.test(commitHash)) {
    return invalidInput(`Invalid revision hash: ${commitHash}`);
  }
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) {
    return err({ code: "STORAGE_ERROR", message: "Catalog not registered" });
  }
  const data = await catalog.readFileAtRevision(
    path.basename(projectDir),
    path.join(assetId, filename),
    commitHash,
  );
  return data
    ? ok(data.toString("utf8"))
    : err({ code: "NOT_FOUND", message: "File not found at revision" });
}
