import { spawn } from "node:child_process";

/**
 * Bulk-seed a git repo with `count` commits using git fast-import.
 * ~100K+ commits/sec vs ~2 commits/sec via the library API.
 *
 * Commit distribution (deterministic, based on i % 10):
 *   0   → target asset commit: modifies {targetAssetId}/file.txt
 *   1   → action log commit: empty commit with [action:bench-op] subject
 *   2–9 → regular commit: modifies vid-other-{i % 8}/file.txt
 */
export async function seedHistory(
  projectDir: string,
  count: number,
  targetAssetId: string,
): Promise<void> {
  const BASE_EPOCH = 1_700_000_000;
  const AUTHOR = "Bench User <bench@clipfirst.test>";

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("git", ["fast-import", "--quiet"], {
      cwd: projectDir,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git fast-import exited ${code}: ${stderr}`));
      }
    });

    const stdin = proc.stdin;
    let mark = 0;

    function nextMark(): number {
      mark++;
      return mark;
    }

    function writeWithBackpressure(data: string): Promise<void> {
      const canContinue = stdin.write(data);
      if (canContinue) return Promise.resolve();
      return new Promise<void>((res) => stdin.once("drain", res));
    }

    async function generate(): Promise<void> {
      // Gitignore blob — used in the first commit
      const gitignoreMark = nextMark();
      const gitignoreContent = ".lock\n";
      const gitignoreBytes = Buffer.byteLength(gitignoreContent);
      await writeWithBackpressure(
        `blob\nmark :${gitignoreMark}\ndata ${gitignoreBytes}\n${gitignoreContent}\n`,
      );

      let prevCommitMark: number | null = null;

      for (let i = 0; i < count; i++) {
        const bucket = i % 10;
        const timestamp = BASE_EPOCH + i;
        const commitMark = nextMark();

        // Create the blob for file-modifying commits
        let blobMark: number | null = null;
        let filePath: string;
        let isActionLog = false;

        if (bucket === 0) {
          // Target asset commit
          const content = `v${i}`;
          blobMark = nextMark();
          const len = Buffer.byteLength(content);
          await writeWithBackpressure(
            `blob\nmark :${blobMark}\ndata ${len}\n${content}\n`,
          );
          filePath = `${targetAssetId}/file.txt`;
        } else if (bucket === 1) {
          // Action log commit — empty commit (no file changes)
          isActionLog = true;
          filePath = "";
        } else {
          // Regular commit on a different asset
          const content = `v${i}`;
          blobMark = nextMark();
          const len = Buffer.byteLength(content);
          await writeWithBackpressure(
            `blob\nmark :${blobMark}\ndata ${len}\n${content}\n`,
          );
          filePath = `vid-other-${i % 8}/file.txt`;
        }

        // Build commit command
        const subject = isActionLog
          ? `[action:bench-op] iteration ${i}`
          : `commit ${i}`;
        const body = isActionLog ? `{"i":${i}}` : "";
        const message = body ? `${subject}\n\n${body}` : subject;
        const messageBytes = Buffer.byteLength(message);

        let commitCmd = `commit refs/heads/main\n`;
        commitCmd += `mark :${commitMark}\n`;
        commitCmd += `author ${AUTHOR} ${timestamp} +0000\n`;
        commitCmd += `committer ${AUTHOR} ${timestamp} +0000\n`;
        commitCmd += `data ${messageBytes}\n${message}\n`;

        if (prevCommitMark !== null) {
          commitCmd += `from :${prevCommitMark}\n`;
        }

        if (i === 0) {
          // First commit includes .gitignore
          commitCmd += `M 644 :${gitignoreMark} .gitignore\n`;
        }

        if (blobMark !== null) {
          commitCmd += `M 644 :${blobMark} ${filePath}\n`;
        }

        commitCmd += `\n`;

        await writeWithBackpressure(commitCmd);
        prevCommitMark = commitMark;
      }

      stdin.end();
    }

    generate().catch(reject);
  });
}
