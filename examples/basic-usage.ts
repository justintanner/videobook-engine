/**
 * Basic usage of clipfirst-fs: create a project, add assets, write/read files.
 *
 * Run: npx tsx examples/basic-usage.ts
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFs } from 'clipfirst-fs';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clipfirst-basic-'));
const projectsDir = path.join(tmpDir, 'projects');
await fs.mkdir(projectsDir);

try {
  const cfs = createFs({ projectsDir });

  // --- Create a project ---
  const projectResult = await cfs.createProject();
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  const { slug } = projectResult.value;
  console.log(`Created project: ${slug}`);

  // --- Create a video asset ---
  const videoResult = await cfs.createAsset('vid', 'beach sunset', slug);
  if (!videoResult.ok) throw new Error(videoResult.error.message);
  console.log(`Created video asset: ${videoResult.value.assetId}`);

  // --- Create an image asset ---
  const imageResult = await cfs.createAsset('img', 'thumbnail photo', slug);
  if (!imageResult.ok) throw new Error(imageResult.error.message);
  console.log(`Created image asset: ${imageResult.value.assetId}`);

  // --- Write a text file ---
  const writeTextResult = await cfs.writeFile(
    videoResult.value.assetId,
    'notes.txt',
    'Shot on location at Malibu beach.',
    slug,
  );
  if (!writeTextResult.ok) throw new Error(writeTextResult.error.message);
  console.log('Wrote notes.txt');

  // --- Write a binary file ---
  const fakeVideo = Buffer.from('fake-mp4-data-for-demo');
  const writeBinResult = await cfs.writeFile(
    videoResult.value.assetId,
    'original.mp4',
    fakeVideo,
    slug,
  );
  if (!writeBinResult.ok) throw new Error(writeBinResult.error.message);
  console.log('Wrote original.mp4');

  // --- Read files back ---
  const readTextResult = await cfs.readFile(videoResult.value.assetId, 'notes.txt', slug);
  if (!readTextResult.ok) throw new Error(readTextResult.error.message);
  console.log(`Read notes.txt: "${readTextResult.value.toString()}"`);

  const readBinResult = await cfs.readFile(videoResult.value.assetId, 'original.mp4', slug);
  if (!readBinResult.ok) throw new Error(readBinResult.error.message);
  console.log(`Read original.mp4: ${readBinResult.value.length} bytes`);

  // --- List all assets ---
  const assets = await cfs.listAssets(slug);
  console.log(`\nAssets in project (${assets.length}):`);
  for (const asset of assets) {
    console.log(`  ${asset.id} — type: ${asset.type}, status: ${asset.status}`);
  }

  // --- Get asset manifest ---
  const manifestResult = await cfs.getManifest(videoResult.value.assetId, slug);
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  console.log(`\nManifest for ${manifestResult.value.asset_id}:`);
  console.log(`  Files (${manifestResult.value.file_count}):`);
  for (const file of manifestResult.value.files) {
    console.log(`    ${file.name} — ${file.size_bytes} bytes`);
  }

  console.log('\nDone!');
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
