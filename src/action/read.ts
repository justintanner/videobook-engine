import * as path from "node:path";

import { catalogForProjectDir } from "../storage/context.js";
import type { ActionLogEntry } from "../types.js";

export interface ActionLogOptions {
  limit?: number;
  since?: string;
}

export async function readActionLog(
  projectDir: string,
  options?: ActionLogOptions,
  gitPath?: string,
): Promise<ActionLogEntry[]> {
  void gitPath;
  const catalog = catalogForProjectDir(projectDir);
  if (!catalog) return [];
  const revisions = catalog.history(
    path.basename(projectDir),
    Math.max(options?.limit ?? 20, 100),
  );
  const entries = revisions
    .filter(
      (revision) =>
        revision.operation?.startsWith("action:") ||
        revision.operation?.startsWith("book:action:"),
    )
    .filter(
      (revision) =>
        !options?.since ||
        revisions.findIndex((item) => item.hash === revision.hash) <
          revisions.findIndex((item) => item.hash === options.since),
    )
    .map((revision): ActionLogEntry => {
      const raw = String(revision.details?.payload ?? "");
      const payload =
        revision.details?.payloadType === "object"
          ? (JSON.parse(raw) as Record<string, unknown>)
          : raw;
      return {
        hash: revision.hash,
        action:
          revision.operation
            ?.replace(/^book:/, "")
            .slice("action:".length) ?? "",
        payload,
        date: revision.date,
      };
    });
  return entries.slice(0, options?.limit ?? 20);
}
