import * as path from "node:path";

import { catalogForProjectDir } from "../storage/context.js";
import {
  type ActionLogEntry,
  type FsError,
  type Result,
  err,
  ok,
} from "../types.js";

const ACTION_PATTERN = /^[a-zA-Z0-9-]+$/;

export async function logAction(
  projectDir: string,
  action: string,
  payload: string | Record<string, unknown>,
  gitPath?: string,
): Promise<Result<ActionLogEntry, FsError>> {
  void gitPath;
  if (!ACTION_PATTERN.test(action)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid action name "${action}": must be alphanumeric with hyphens`,
    });
  }
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) {
    return err({ code: "STORAGE_ERROR", message: "Catalog not registered" });
  }
  const revision = await catalog.snapshotProject(projectDir, {
    operation: `action:${action}`,
    details: {
      payload:
        typeof payload === "string" ? payload : JSON.stringify(payload),
      payloadType: typeof payload,
    },
    allowEmpty: true,
  });
  if (!revision) {
    return err({ code: "STORAGE_ERROR", message: "Action was not recorded" });
  }
  return ok({
    hash: revision.hash,
    action,
    payload,
    date: revision.date,
  });
}
