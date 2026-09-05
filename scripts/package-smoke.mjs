import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "videobook-package-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const installEnv = { ...process.env, npm_config_userconfig: join(root, "npmrc") };
delete installEnv.npm_config_allow_scripts;
delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;

try {
  let target = process.argv[2];
  if (!target) {
    const packed = await run(npm, ["pack", "--json", "--pack-destination", root], {
      cwd: repository, maxBuffer: 16 * 1024 * 1024,
    });
    const [{ filename }] = JSON.parse(packed.stdout);
    target = join(root, filename);
  }
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "videobook-package-smoke", private: true, type: "module",
    allowScripts: {
      "@dolthub/doltlite": true,
      "onnxruntime-node": true,
      "protobufjs": true,
      "sharp": true,
      "usearch": true,
      "videobook-engine": false,
    },
  }));
  process.stdout.write(`Installing ${target} in a clean project\n`);
  await writeFile(installEnv.npm_config_userconfig, "");
  await run(npm, ["install", "--no-audit", "--no-fund", target], {
    cwd: root, env: installEnv, maxBuffer: 16 * 1024 * 1024,
  });
  const readme = await readFile(join(root, "node_modules/videobook-engine/README.md"), "utf8");
  const example = readme.match(/## Quick start\s+```ts\n([\s\S]*?)\n```/)?.[1];
  assert.ok(example, "Installed README must contain an executable quick start");
  await writeFile(join(root, "smoke.mjs"), `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
${example}
assert.equal(book.name, "My Story");
assert.equal(script.value.label, "opening draft");
assert.ok(history.length >= 2, "Artifact creation and file write appear in history");
assert.ok(existsSync(".videobook/data/videobook.db"));
const reopened = createEngine({ rootDir: ".videobook" });
try {
  assert.equal(reopened.book.get().bookId, book.bookId);
  assert.equal(reopened.artifacts.get(script.value.artifactId).value.label, "opening draft");
} finally { reopened.close(); }
console.log("Packaged README quick start and catalog reopen passed");
`);
  const result = await run(process.execPath, [join(root, "smoke.mjs")], {
    cwd: root, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
