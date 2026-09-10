import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { prepareOnnxBundle } from "../scripts/prepare-onnx-bundle.mjs";

const run = promisify(execFile);

it("installs all runtime platforms without GPU downloads or the unused macOS duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "videobook-onnx-packaging-"));
  const packageRoot = join(root, "node_modules/onnxruntime-node");
  const platformFiles = [
    "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
    "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
    "bin/napi-v6/linux/x64/onnxruntime_binding.node",
    "bin/napi-v6/linux/arm64/onnxruntime_binding.node",
    "bin/napi-v6/win32/x64/onnxruntime_binding.node",
    "bin/napi-v6/win32/arm64/onnxruntime_binding.node",
    "bin/napi-v6/linux/x64/libonnxruntime.so.1",
  ];
  const duplicate = "bin/napi-v6/darwin/arm64/libonnxruntime.1.29.0.dylib";
  const downloads = [
    "libonnxruntime_providers_cuda.so",
    "libonnxruntime_providers_shared.so",
    "libonnxruntime_providers_tensorrt.so",
  ];
  try {
    await mkdir(join(packageRoot, "script"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "onnx-packaging-fixture", version: "1.0.0", private: true,
      dependencies: { "onnxruntime-node": "1.29.0" },
      bundleDependencies: ["onnxruntime-node"],
    }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "onnxruntime-node", version: "1.29.0", main: "index.js",
    }));
    await writeFile(join(packageRoot, "index.js"), "module.exports = {};\n");
    await writeFile(join(packageRoot, "script/install-metadata.js"),
      `module.exports = ${JSON.stringify({ manifests: {
        "linux/x64:cuda12": Object.fromEntries(downloads.map((file) => [`./${file}`, {}])),
      } })};\n`);
    for (const file of [...platformFiles, duplicate, ...downloads.map((file) => `bin/napi-v6/linux/x64/${file}`)]) {
      await mkdir(dirname(join(packageRoot, file)), { recursive: true });
      await writeFile(join(packageRoot, file), file.endsWith(".dylib")
        ? "identical macOS runtime bytes" : `fixture bytes for ${file}`);
    }
    await prepareOnnxBundle(packageRoot);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const env = { ...process.env };
    delete env.npm_config_allow_scripts;
    delete env.NPM_CONFIG_ALLOW_SCRIPTS;
    const { stdout } = await run(npm, ["pack", "--ignore-scripts", "--json"], { cwd: root, env });
    const packed = (JSON.parse(stdout) as Array<{
      filename: string; files: Array<{ path: string }>;
    }>)[0]!;
    const names = packed.files.map((file) => file.path);
    for (const file of platformFiles) {
      expect(names).toContain(`node_modules/onnxruntime-node/${file}`);
    }
    expect(names).toContain("node_modules/onnxruntime-node/script/install-metadata.js");
    expect(names).not.toContain(`node_modules/onnxruntime-node/${duplicate}`);
    for (const file of downloads) {
      expect(names).not.toContain(`node_modules/onnxruntime-node/bin/napi-v6/linux/x64/${file}`);
    }

    const consumer = join(root, "consumer");
    await mkdir(consumer);
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true }));
    await run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)],
      { cwd: consumer, env });
    const installed = join(consumer, "node_modules/onnx-packaging-fixture/node_modules/onnxruntime-node");
    for (const file of platformFiles) {
      expect(await readFile(join(installed, file), "utf8")).toBe(file.endsWith(".dylib")
        ? "identical macOS runtime bytes" : `fixture bytes for ${file}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
