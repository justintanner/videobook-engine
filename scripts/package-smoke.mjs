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
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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
const engineRequire = createRequire(import.meta.resolve("videobook-engine"));
const transformersPath = engineRequire.resolve("@huggingface/transformers");
const transformersRequire = createRequire(transformersPath);
const sharpPath = engineRequire.resolve("sharp");
assert.equal(realpathSync(sharpPath), realpathSync(transformersRequire.resolve("sharp")),
  "Engine and Transformers must resolve one Sharp binary");
const { default: sharp } = await import(pathToFileURL(sharpPath));
const transformers = await import(pathToFileURL(transformersPath));
const RawImage = transformers.RawImage ?? transformers.default.RawImage;
const pixels = await sharp({ create: {
  width: 16, height: 12, channels: 3, background: { r: 220, g: 20, b: 20 },
} }).png().toBuffer();
const decoded = await RawImage.fromBlob(new Blob([pixels]));
assert.equal(decoded.width, 16);
assert.equal(decoded.height, 12);
console.log("Packaged README quick start and catalog reopen passed");
`);
  const result = await run(process.execPath, [join(root, "smoke.mjs")], {
    cwd: root, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  assert.doesNotMatch(result.stderr,
    /Class .+ is implemented in both|GNotificationCenterDelegate|duplicate.*libvips/i,
    "Media smoke must not load competing native image libraries");
  process.stderr.write(result.stderr);
  const resolutions = await run(npm, ["ls", "sharp", "--all", "--parseable"], {
    cwd: root, env: installEnv,
  });
  assert.equal(resolutions.stdout.trim().split(/\r?\n/).filter(Boolean).length, 1,
    "Clean installation must contain one Sharp resolution");
  process.stdout.write("Single Sharp resolution and media decode passed\n");
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
