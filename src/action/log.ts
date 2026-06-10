import {
  type ActionLogEntry,
  type FsError,
  type Result,
  ok,
  err,
} from "../types.js";
import { isGitRepo } from "../git/init.js";
import { gitExecSafe } from "../git/exec.js";
import { withGitLock } from "../git/mutex.js";

const ACTION_PATTERN = /^[a-zA-Z0-9-]+$/;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

function isIndexLockError(stderr: string): boolean {
  return stderr.includes("index.lock") || stderr.includes("Unable to create");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collapse control characters to spaces. Newlines in the subject would split
 *  the commit subject line; \x00/\x1f in the body would forge the record and
 *  field separators readActionLog parses with. */
function sanitizeControlChars(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]+/g, " ");
}

function buildCommitMessage(
  action: string,
  payload: string | Record<string, unknown>,
): string {
  const isText = typeof payload === "string";
  const preview = isText ? sanitizeControlChars(payload).slice(0, 72) : action;
  // Record payloads are safe via JSON.stringify (control chars are escaped);
  // string payloads must keep newlines but drop the separator bytes.
  const body = isText
    ? payload.replace(/[\x00\x1f\x7f]+/g, " ")
    : JSON.stringify(payload);
  return `[action:${action}] ${preview}\n\n${body}`;
}

export async function logAction(
  projectDir: string,
  action: string,
  payload: string | Record<string, unknown>,
  gitPath?: string,
): Promise<Result<ActionLogEntry, FsError>> {
  if (!ACTION_PATTERN.test(action)) {
    return err({
      code: "INVALID_INPUT",
      message: `Invalid action name "${action}": must be alphanumeric with hyphens`,
    });
  }

  if (!(await isGitRepo(projectDir))) {
    return err({ code: "GIT_ERROR", message: "Not a git repository" });
  }

  return withGitLock(projectDir, async () => {
    const message = buildCommitMessage(action, payload);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const result = await gitExecSafe(
        ["commit", "--allow-empty", "-m", message],
        { cwd: projectDir, gitPath },
      );

      if (result.exitCode !== 0) {
        if (isIndexLockError(result.stderr) && attempt < MAX_ATTEMPTS - 1) {
          await delay(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        return err({
          code: "GIT_ERROR",
          message: `Failed to commit action: ${result.stderr}`,
        });
      }

      const hashResult = await gitExecSafe(["rev-parse", "HEAD"], {
        cwd: projectDir,
        gitPath,
      });

      if (hashResult.exitCode !== 0) {
        return err({ code: "GIT_ERROR", message: "Failed to get commit hash" });
      }

      const hash = hashResult.stdout.trim();

      const dateResult = await gitExecSafe(
        ["log", "-1", "--format=%aI", hash],
        { cwd: projectDir, gitPath },
      );

      return ok({
        hash,
        action,
        payload,
        date: dateResult.stdout.trim(),
      });
    }

    return err({ code: "GIT_ERROR", message: "Failed after retries" });
  });
}
