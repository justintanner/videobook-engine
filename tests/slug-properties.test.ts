import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  artifactSlug,
  createEngine,
  type ArtifactKind,
} from "../src/index.js";

const reusableKinds: ArtifactKind[] = [
  "video",
  "image",
  "audio",
  "script",
  "character",
  "prompt",
  "scene",
  "notebook",
];

describe("active slug properties", () => {
  it("always releases an explicit slug and isolates the replacement", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...reusableKinds),
        fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
        async (kind, name) => {
          const root = await mkdtemp(
            path.join(tmpdir(), "videobook-slug-property-"),
          );
          const engine = await createEngine({
            dataDir: path.join(root, "data"),
            workspaceDir: path.join(root, "workspace"),
          });
          try {
            const project = await engine.projects.create("property");
            if (!project.ok) throw new Error(project.error.message);
            const slug = artifactSlug(kind, name);
            const first = await engine.artifacts.create({
              project: project.value.projectId,
              kind,
              slug,
            });
            if (!first.ok) throw new Error(first.error.message);
            const written = await engine.files.write(
              first.value.artifactId,
              "private.txt",
              first.value.artifactId,
              project.value.projectId,
            );
            if (!written.ok) throw new Error(written.error.message);
            const deleted = await engine.artifacts.delete(
              first.value.artifactId,
              project.value.projectId,
            );
            if (!deleted.ok) throw new Error(deleted.error.message);
            const second = await engine.artifacts.create({
              project: project.value.projectId,
              kind,
              slug,
            });
            if (!second.ok) throw new Error(second.error.message);
            expect(second.value.slug).toBe(slug);
            expect(second.value.artifactId).not.toBe(
              first.value.artifactId,
            );
            expect(second.value.path).not.toBe(first.value.path);
            const manifest = await engine.files.manifest(
              second.value.artifactId,
              project.value.projectId,
            );
            if (!manifest.ok) throw new Error(manifest.error.message);
            expect(manifest.value.files).toEqual([]);
          } finally {
            engine.close();
            await rm(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
