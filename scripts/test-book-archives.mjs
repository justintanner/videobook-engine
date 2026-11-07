import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "videobook-archive-suite-"));
try {
  const child = spawn(process.execPath, [fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json"))), "run", "tests/book-archive.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, VIDEOBOOK_ARCHIVE_TEST_ROOT: root },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
