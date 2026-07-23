/**
 * Project management: create, list, switch, and work across multiple projects.
 *
 * Run: npx tsx examples/project-management.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createFs } from "videobook-engine";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-projects-"));
const outputDir = path.join(tmpDir, "output");
await fs.mkdir(outputDir);

try {
  const cfs = createFs({
    projectsDir: outputDir,
    dataDir: path.join(tmpDir, "data"),
  });

  // --- Create projects with custom slugs ---
  const projectA = await cfs.createProject("vacation-clips");
  if (!projectA.ok) throw new Error(projectA.error.message);
  console.log(
    `Created: ${projectA.value.slug} (default: ${projectA.value.is_default})`,
  );

  const projectB = await cfs.createProject("work-demos");
  if (!projectB.ok) throw new Error(projectB.error.message);
  console.log(
    `Created: ${projectB.value.slug} (default: ${projectB.value.is_default})`,
  );

  const projectC = await cfs.createProject("music-videos");
  if (!projectC.ok) throw new Error(projectC.error.message);
  console.log(`Created: ${projectC.value.slug}`);

  // --- List all projects ---
  const projects = await cfs.listProjects();
  console.log(`\nAll projects (${projects.length}):`);
  for (const p of projects) {
    const def = p.is_default ? " (default)" : "";
    console.log(
      `  ${p.slug} — created ${new Date(p.created * 1000).toISOString()}${def}`,
    );
  }

  // --- Switch default project ---
  const switchResult = await cfs.switchProject("vacation-clips");
  if (!switchResult.ok) throw new Error(switchResult.error.message);
  console.log(`\nSwitched default to: ${switchResult.value}`);

  // --- Get project metadata ---
  const getResult = await cfs.getProject("work-demos");
  if (!getResult.ok) throw new Error(getResult.error.message);
  console.log(`\nProject "work-demos" metadata:`);
  console.log(`  slug: ${getResult.value.metadata.slug}`);
  console.log(`  path: ${getResult.value.path}`);

  // --- Create assets in specific projects via projectSlug ---
  const assetInA = await cfs.createAsset("vid", "beach day", "vacation-clips");
  if (!assetInA.ok) throw new Error(assetInA.error.message);
  console.log(`\nCreated in vacation-clips: ${assetInA.value.assetId}`);

  const assetInB = await cfs.createAsset(
    "vid",
    "product walkthrough",
    "work-demos",
  );
  if (!assetInB.ok) throw new Error(assetInB.error.message);
  console.log(`Created in work-demos: ${assetInB.value.assetId}`);

  const assetInC = await cfs.createAsset(
    "aud",
    "backing track",
    "music-videos",
  );
  if (!assetInC.ok) throw new Error(assetInC.error.message);
  console.log(`Created in music-videos: ${assetInC.value.assetId}`);

  // --- List assets per project ---
  for (const slug of ["vacation-clips", "work-demos", "music-videos"]) {
    const assets = await cfs.listAssets(slug);
    console.log(`\n${slug} assets (${assets.length}):`);
    for (const a of assets) {
      console.log(`  ${a.id} — type: ${a.type}`);
    }
  }

  console.log("\nDone!");
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
