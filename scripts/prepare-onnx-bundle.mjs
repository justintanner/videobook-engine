import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ONNX's npm archive contains its platform binaries. Its installer can add
// optional CUDA providers afterward; those downloads must not become part of
// the engine archive just because it was packed on a Linux machine.
export async function prepareOnnxBundle(packageRoot) {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "onnxruntime-node" || manifest.version !== "1.29.0") {
    throw new Error("Review ONNX bundle contents when changing the runtime version");
  }
  const require = createRequire(manifestPath);
  const { manifests } = require(join(packageRoot, "script/install-metadata.js"));
  const downloads = Object.entries(manifests).flatMap(([name, files]) => {
    const platform = name.split(":")[0];
    return Object.keys(files).map((file) => posix.join("bin/napi-v6", platform, file));
  });
  // In 1.29.0, the macOS binding and library both use the install name
  // @rpath/libonnxruntime.1.dylib (verified with otool). The versioned copy
  // is unused and identical. Keep the loadable filename and omit only the
  // duplicate; npm does not reliably install tar hardlinks.
  const libraries = "bin/napi-v6/darwin/arm64";
  const duplicate = posix.join(libraries, `libonnxruntime.${manifest.version}.dylib`);
  const [duplicateBytes, runtimeBytes] = await Promise.all([
    readFile(join(packageRoot, duplicate)),
    readFile(join(packageRoot, libraries, "libonnxruntime.1.dylib")),
  ]);
  if (!duplicateBytes.equals(runtimeBytes)) {
    throw new Error("ONNX macOS library copies differ; review before excluding either file");
  }
  const excluded = [...new Set([...downloads, duplicate])].sort();
  manifest.files = ["**", ...excluded.map((file) => `!${file}`)];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareOnnxBundle(fileURLToPath(new URL("../node_modules/onnxruntime-node/", import.meta.url)));
}
