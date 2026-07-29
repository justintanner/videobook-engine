/**
 * Basic single-book usage: initialize an engine root, create an artifact,
 * write object-backed files, and inspect semantic history.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createEngine } from "videobook-engine";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-basic-"));

try {
  const engine = createEngine({
    rootDir,
    initialBookSlug: "story",
  });
  try {
    const book = engine.book.get();
    console.log(`Opened book: ${book.slug} (${book.bookId})`);

    const scriptResult = await engine.artifacts.create({
      kind: "script",
      name: "opening draft",
    });
    if (!scriptResult.ok) throw new Error(scriptResult.error.message);
    const script = scriptResult.value;
    console.log(`Created: ${script.slug} (${script.artifactId})`);

    const write = await engine.files.write(
      script.artifactId,
      "original.md",
      "# Opening\n\nA cat watches the sunrise.",
    );
    if (!write.ok) throw new Error(write.error.message);

    const manifest = await engine.files.manifest(script.artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    console.log(`Stored files: ${manifest.value.files.map((file) => file.name).join(", ")}`);

    const sequence = engine.sequences.getPrimary();
    console.log(
      `Primary sequence: ${sequence.name} (${sequence.width}x${sequence.height}, ${sequence.tracks.length} tracks)`,
    );

    console.log("Recent revisions:");
    for (const revision of engine.history.revisions(5)) {
      console.log(`- ${revision.hash.slice(0, 10)} ${revision.operation}`);
    }
  } finally {
    engine.close();
  }
} finally {
  await fs.rm(rootDir, { recursive: true, force: true });
}
