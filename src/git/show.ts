import { gitExecSafe } from "./exec.js";
import { isGitRepo } from "./init.js";
import { type FsError, type Result, ok, err } from "../types.js";
import { isSafeFilename, isSafePath, invalidInput } from "../validation.js";

const COMMIT_HASH_RE = /^[a-f0-9]{7,64}$/i;

/** Read a file's contents at a specific git commit via `git show <hash>:<assetId>/<filename>`. */
export async function readFileAtCommit(
  projectDir: string,
  assetId: string,
  filename: string,
  commitHash: string,
  gitPath?: string,
): Promise<Result<string, FsError>> {
  if (!isSafePath(assetId)) {
    return invalidInput(`Invalid asset ID: ${assetId}`);
  }
  if (!isSafeFilename(filename)) {
    return invalidInput(`Invalid filename: ${filename}`);
  }
  if (!COMMIT_HASH_RE.test(commitHash)) {
    return invalidInput(`Invalid commit hash: ${commitHash}`);
  }
  if (!(await isGitRepo(projectDir))) {
    return err({ code: "NOT_FOUND", message: "Not a git repository" });
  }

  const target = `${commitHash}:${assetId}/${filename}`;
  const result = await gitExecSafe(["show", target], {
    cwd: projectDir,
    gitPath,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return err({
      code: "NOT_FOUND",
      message: stderr.length > 0
        ? `git show ${target} failed: ${stderr}`
        : `File not found at commit: ${target}`,
    });
  }
  return ok(result.stdout);
}
