/**
 * Git integration: track changes, view history, and restore to a previous state.
 *
 * Run: npx tsx examples/git-history.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFs } from "vc-engine";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "videocity-git-"));
const outputDir = path.join(tmpDir, "output");
await fs.mkdir(outputDir);

try {
  const cfs = createFs({ outputDir });

  // --- Setup: create project and asset ---
  const projectResult = await cfs.createProject("git-demo");
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  const slug = projectResult.value.slug;

  const assetResult = await cfs.createAsset("vid", "interview clip", slug);
  if (!assetResult.ok) throw new Error(assetResult.error.message);
  const assetId = assetResult.value.assetId;
  console.log(`Project: ${slug}, Asset: ${assetId}\n`);

  // --- Write version 1 ---
  const w1 = await cfs.writeFile(
    assetId,
    "script.txt",
    "Version 1: rough draft",
    slug,
  );
  if (!w1.ok) throw new Error(w1.error.message);
  console.log("Wrote script.txt v1");

  // --- Write version 2 ---
  const w2 = await cfs.writeFile(
    assetId,
    "script.txt",
    "Version 2: revised and polished",
    slug,
  );
  if (!w2.ok) throw new Error(w2.error.message);
  console.log("Wrote script.txt v2");

  // --- Write another file ---
  const w3 = await cfs.writeFile(
    assetId,
    "notes.txt",
    "Some production notes",
    slug,
  );
  if (!w3.ok) throw new Error(w3.error.message);
  console.log("Wrote notes.txt");

  // --- Project-level history ---
  const projectHistory = await cfs.getHistory(slug);
  console.log(`\nProject history (${projectHistory.length} commits):`);
  for (const commit of projectHistory) {
    console.log(`  ${commit.hash.slice(0, 7)} — ${commit.message}`);
  }

  // --- Asset-level history ---
  const assetHistory = await cfs.getAssetHistory(assetId, slug);
  console.log(
    `\nAsset history for ${assetId} (${assetHistory.length} commits):`,
  );
  for (const commit of assetHistory) {
    console.log(`  ${commit.hash.slice(0, 7)} — ${commit.message}`);
  }

  // --- Find the commit with version 1 of script.txt ---
  // History is newest-first. The write commits are:
  //   [0] notes.txt write, [1] script.txt v2, [2] script.txt v1, [3] create
  // We want the script.txt v1 commit — second-to-last (before create).
  const v1Commit = assetHistory[assetHistory.length - 2];
  if (!v1Commit) throw new Error("No commits found");

  // Verify current content is v2
  const currentRead = await cfs.readFile(assetId, "script.txt", slug);
  if (!currentRead.ok) throw new Error(currentRead.error.message);
  console.log(`\nCurrent script.txt: "${currentRead.value.toString()}"`);

  // --- Restore to version 1 ---
  console.log(
    `\nRestoring ${assetId} to commit ${v1Commit.hash.slice(0, 7)}...`,
  );
  const restoreHash = await cfs.restoreAsset(assetId, v1Commit.hash, slug);
  if (!restoreHash) throw new Error("Restore failed");
  console.log(`Restore committed as ${restoreHash.slice(0, 7)}`);

  // --- Verify restored content ---
  const restoredRead = await cfs.readFile(assetId, "script.txt", slug);
  if (!restoredRead.ok) throw new Error(restoredRead.error.message);
  console.log(`Restored script.txt: "${restoredRead.value.toString()}"`);

  // --- Final history shows the restore commit ---
  const finalHistory = await cfs.getHistory(slug, 3);
  console.log(`\nFinal history (last 3):`);
  for (const commit of finalHistory) {
    console.log(`  ${commit.hash.slice(0, 7)} — ${commit.message}`);
  }

  console.log("\nDone!");
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
