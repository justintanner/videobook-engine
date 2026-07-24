/**
 * Basic usage of videobook-engine: create a project, add assets, write/read files.
 *
 * Run: npx tsx examples/basic-usage.ts
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEngine } from "videobook-engine";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-basic-"));
try {
  const engine = await createEngine({
    dataDir: path.join(tmpDir, "data"),
    workspaceDir: path.join(tmpDir, "workspace"),
  });

  const projectResult = await engine.projects.create("story");
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  const project = projectResult.value;
  console.log(`Created project: ${project.slug} (${project.projectId})`);

  const videoResult = await engine.artifacts.create({
    project: project.projectId,
    kind: "video",
    slug: "vid-beach-sunset",
  });
  if (!videoResult.ok) throw new Error(videoResult.error.message);
  const video = videoResult.value;
  console.log(`Created video: ${video.slug} (${video.artifactId})`);

  const imageResult = await engine.artifacts.create({
    project: project.projectId,
    kind: "image",
    name: "Thumbnail",
  });
  if (!imageResult.ok) throw new Error(imageResult.error.message);
  console.log(`Created image: ${imageResult.value.slug}`);

  const writeTextResult = await engine.files.write(
    video.artifactId,
    "notes.txt",
    "Shot on location at Malibu beach.",
    project.projectId,
  );
  if (!writeTextResult.ok) throw new Error(writeTextResult.error.message);

  const writeVideoResult = await engine.files.write(
    video.artifactId,
    "original.mp4",
    Buffer.from("fake-mp4-data-for-demo"),
    project.projectId,
  );
  if (!writeVideoResult.ok) {
    throw new Error(writeVideoResult.error.message);
  }

  const readTextResult = await engine.files.read(
    video.artifactId,
    "notes.txt",
    project.projectId,
  );
  if (!readTextResult.ok) throw new Error(readTextResult.error.message);
  console.log(`Read notes.txt: "${readTextResult.value.toString()}"`);

  const artifacts = engine.artifacts.list(project.projectId);
  console.log(`\nArtifacts (${artifacts.length}):`);
  for (const artifact of artifacts) {
    console.log(
      `  ${artifact.slug} — ${artifact.kind} — ${artifact.artifactId}`,
    );
  }

  const manifestResult = await engine.files.manifest(
    video.artifactId,
    project.projectId,
  );
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  console.log(`\nManifest for ${manifestResult.value.slug}:`);
  for (const file of manifestResult.value.files) {
    console.log(`  ${file.name} — ${file.sizeBytes} bytes`);
  }

  const deleted = await engine.artifacts.delete(
    video.artifactId,
    project.projectId,
  );
  if (!deleted.ok) throw new Error(deleted.error.message);
  const replacement = await engine.artifacts.create({
    project: project.projectId,
    kind: "video",
    slug: "vid-beach-sunset",
  });
  if (!replacement.ok) throw new Error(replacement.error.message);
  console.log(
    `\nReused ${replacement.value.slug} with new identity ${replacement.value.artifactId}`,
  );

  engine.close();
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
