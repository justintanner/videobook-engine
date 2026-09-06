import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const file = new URL("../src/model-checksums.json", import.meta.url);
const previous = JSON.parse(await readFile(file, "utf8"));
const snapshots = {};
for (const snapshot of Object.keys(previous)) {
  const slash = snapshot.lastIndexOf("/");
  const model = snapshot.slice(0, slash);
  const revision = snapshot.slice(slash + 1);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Model checksum snapshots require exact revisions");
  const tree = JSON.parse(execFileSync("hf", ["models", "list", model, "--recursive", "--revision", revision, "--format", "json"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, HF_HUB_DISABLE_IMPLICIT_TOKEN: "1" },
  }));
  const files = new Map();
  for (const entry of tree) {
    if (!entry.blob_id) continue;
    const algorithm = entry.lfs ? "sha256" : "git-sha1";
    const digest = entry.lfs?.sha256 ?? entry.blob_id;
    if (!(algorithm === "sha256" ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(digest)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || entry.lfs && entry.lfs.size !== entry.size) throw new Error("Unsupported upstream model integrity metadata");
    files.set(entry.path, { algorithm, digest, size: entry.size });
  }
  if (files.size === 0) throw new Error("Empty upstream model snapshot");
  snapshots[snapshot] = Object.fromEntries([...files.keys()].sort().map((name) => [name, files.get(name)]));
}
await writeFile(file, JSON.stringify(snapshots, null, 2) + "\n");
console.log(`Updated ${Object.keys(snapshots).length} pinned model checksum snapshots`);
