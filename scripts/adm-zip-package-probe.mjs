import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Resolve from the real ONNX installer, not an unrelated direct ZIP dependency.
const engineRequire = createRequire(resolve(process.argv[2], "package.json"));
const onnxRequire = createRequire(engineRequire.resolve("onnxruntime-node/package.json"));
const installerRequire = createRequire(onnxRequire.resolve("./script/install-utils.js"));
const AdmZip = installerRequire("adm-zip");
const manifest = installerRequire("adm-zip/package.json");
assert.equal(manifest.version, "0.6.1", "ONNX must use the patched bundled ZIP package");

const root = await mkdtemp(join(tmpdir(), "videobook-zip-security-"));
try {
  const normal = new AdmZip();
  normal.addFile("nested/file.txt", Buffer.from("safe extraction"));
  for (const mode of ["all", "async", "entry"]) {
    const target = join(root, `normal-${mode}`);
    await mkdir(join(target, "nested"), { recursive: true });
    await writeFile(join(target, "nested/file.txt"), "old contents");
    if (mode === "all") normal.extractAllTo(target, true);
    else if (mode === "async") await normal.extractAllToAsync(target, true);
    else normal.extractEntryTo("nested/file.txt", target, true, true);
    assert.equal(await readFile(join(target, "nested/file.txt"), "utf8"), "safe extraction");
  }

  // A directory junction also exercises the attack on Windows without requiring
  // permission to create file symlinks. Unix additionally checks a symlink leaf.
  const kinds = process.platform === "win32" ? ["directory"] : ["directory", "file"];
  for (const mode of ["all", "async", "entry"]) {
    for (const kind of kinds) {
      const target = join(root, `${mode}-${kind}`);
      const outside = join(root, `outside-${mode}-${kind}`);
      await mkdir(target);
      await mkdir(outside);
      const victim = join(outside, "victim.txt");
      await writeFile(victim, "original contents");
      await symlink(kind === "directory" ? outside : victim, join(target, "link"),
        kind === "directory" ? "junction" : "file");
      const entry = kind === "directory" ? "link/victim.txt" : "link";
      const zip = new AdmZip();
      zip.addFile(entry, Buffer.from("must not overwrite outside the extraction root"));
      if (mode === "async") await assert.rejects(zip.extractAllToAsync(target, true));
      else assert.throws(() => mode === "all"
        ? zip.extractAllTo(target, true)
        : zip.extractEntryTo(entry, target, true, true));
      assert.equal(await readFile(victim, "utf8"), "original contents");
    }
  }
  process.stdout.write(`Installed ONNX ZIP ${manifest.version}: normal extraction and ${3 * kinds.length} symlink overwrite regressions passed\n`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
