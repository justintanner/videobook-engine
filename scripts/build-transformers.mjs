import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import "./patch-transformers.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: repository,
  entryPoints: ["src/transformers-runtime.ts"],
  outfile: "dist/transformers-runtime.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["sharp", "onnxruntime-node", "onnxruntime-web", "onnxruntime-web/*"],
  legalComments: "external",
  sourcemap: true,
  metafile: true,
});
const engineManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports.filter((item) => item.external)) {
    if (isBuiltin(dependency.path)) continue;
    const parts = dependency.path.split("/");
    const name = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!engineManifest.dependencies[name]) {
      throw new Error(`Bundled runtime has an undeclared external dependency: ${name}`);
    }
  }
}
const notices = join(repository, "dist/third-party");
await mkdir(notices, { recursive: true });
const versions = {};
for (const name of ["@huggingface/transformers", "@huggingface/jinja", "@huggingface/tokenizers", "onnxruntime-common"]) {
  const packageRoot = join(repository, "node_modules", name);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  versions[name] = {
    licenseSourceVersion: manifest.version,
    license: manifest.license,
    ...(name === "@huggingface/transformers" ? {
      enginePatches: ["model-discovery-options-v1", "verified-model-files-v1"],
    } : {}),
    ...(name === "onnxruntime-common" ? {
      licenseSource: "https://github.com/microsoft/onnxruntime/blob/v1.29.0/LICENSE",
    } : {}),
  };
  const destination = join(notices, `${name.replaceAll("/", "-")}.LICENSE`);
  const license = name === "onnxruntime-common"
    ? join(repository, "scripts/licenses/onnxruntime-common.LICENSE")
    : join(packageRoot, "LICENSE");
  await copyFile(license, destination);
}
await writeFile(join(notices, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`);
