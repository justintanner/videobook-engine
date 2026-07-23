import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFs,
  type ContentStore,
  type NotebookDocument,
} from "../src/index.js";

class MemoryContentStore implements ContentStore {
  readonly objects = new Map<string, Buffer>();

  async head(key: string): Promise<{ exists: boolean; size?: number }> {
    const value = this.objects.get(key);
    return value
      ? { exists: true, size: value.length }
      : { exists: false };
  }

  async uploadFile(key: string, sourcePath: string): Promise<void> {
    this.objects.set(key, await fs.readFile(sourcePath));
  }

  async downloadFile(key: string, destinationPath: string): Promise<void> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`Missing object: ${key}`);
    await fs.writeFile(destinationPath, value);
  }
}

describe("DoltLite catalog and content-addressed storage", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("restores exact bytes as a new revision without changing another project", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-doltlite-"));
    const api = createFs({
      projectsDir: path.join(root, "projects"),
      dataDir: path.join(root, "data"),
    });
    await api.createProject("project-a");
    await api.createProject("project-b");
    const assetA = await api.createAsset("img", "subject", "project-a");
    const assetB = await api.createAsset("img", "subject", "project-b");
    if (!assetA.ok || !assetB.ok) throw new Error("Asset creation failed");

    await api.writeFile(assetA.value.assetId, "original.bin", Buffer.from([1, 2, 3]), "project-a");
    const target = (await api.getAssetHistory(assetA.value.assetId, "project-a", 1))[0]!;
    await api.writeFile(assetA.value.assetId, "original.bin", Buffer.from([4, 5, 6]), "project-a");
    await api.writeFile(assetB.value.assetId, "original.bin", Buffer.from([9, 8, 7]), "project-b");

    const rewind = await api.rewindProject(target.hash, "project-a");
    expect(rewind).toMatch(/^[a-f0-9]{40}$/);
    expect(rewind).not.toBe(target.hash);
    const restoredA = await api.readFile(assetA.value.assetId, "original.bin", "project-a");
    const currentB = await api.readFile(assetB.value.assetId, "original.bin", "project-b");
    expect(restoredA.ok && [...restoredA.value]).toEqual([1, 2, 3]);
    expect(currentB.ok && [...currentB.value]).toEqual([9, 8, 7]);
    expect((await api.getProjectHistory("project-a", 1))[0]?.operation).toBe("rewind");
    api.close();
  });

  it("publishes immutable objects and rehydrates historical bytes", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-cas-"));
    const store = new MemoryContentStore();
    const dataDir = path.join(root, "data");
    const api = createFs({
      projectsDir: path.join(root, "projects"),
      dataDir,
      objectStore: store,
    });
    await api.createProject("project-a");
    const asset = await api.createAsset("vid", "clip", "project-a");
    if (!asset.ok) throw new Error("Asset creation failed");
    await api.writeFile(asset.value.assetId, "original.bin", "version-one", "project-a");
    const revision = (await api.getAssetHistory(asset.value.assetId, "project-a", 1))[0]!;
    const synced = await api.sync();
    expect(synced.state).toBe("synced");
    expect(store.objects.size).toBeGreaterThan(0);

    await fs.rm(path.join(dataDir, "objects"), { recursive: true, force: true });
    const historical = await api.readFileAtRevision(
      asset.value.assetId,
      "original.bin",
      revision.hash,
      "project-a",
    );
    expect(historical).toEqual({ ok: true, value: "version-one" });
    api.close();
  });

  it("versions notebook graphs and reusable entities as first-class assets", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-notebook-"));
    const api = createFs({
      projectsDir: path.join(root, "projects"),
      dataDir: path.join(root, "data"),
    });
    await api.createProject("project-a");
    const notebook = await api.createNotebook("Scratch", "project-a");
    const character = await api.createEntity(
      "character",
      "Astronaut",
      "project-a",
      { prompt: "Silver suit, calm expression" },
    );
    const prompt = await api.createEntity(
      "prompt",
      "Moon garden",
      "project-a",
      { prompt: "Emerald plants beneath lunar light" },
    );
    const scene = await api.createEntity(
      "scene",
      "Arrival",
      "project-a",
      { description: "The astronaut enters the garden" },
    );
    if (!notebook.ok || !character.ok || !prompt.ok || !scene.ok) {
      throw new Error("Entity creation failed");
    }
    const changed: NotebookDocument = {
      ...notebook.value,
      cells: [
        {
          id: "cell-character",
          type: "character",
          title: "Astronaut",
          position: { x: 100, y: 80 },
          entityId: character.value.id,
        },
      ],
    };
    const written = await api.writeNotebook(changed, "project-a");
    expect(written.ok).toBe(true);
    expect((await api.listNotebooks("project-a"))[0]?.cells).toHaveLength(1);
    expect((await api.listEntities("project-a", "character"))[0]?.prompt).toContain("Silver suit");
    expect((await api.listEntities("project-a", "prompt"))[0]?.id).toBe(
      prompt.value.id,
    );
    const updated = await api.writeEntity(
      { ...scene.value, description: "Revised arrival" },
      "project-a",
    );
    expect(updated.ok).toBe(true);
    expect(
      (await api.readEntity(scene.value.id, "project-a")).ok,
    ).toBe(true);
    expect((await api.deleteEntity(prompt.value.id, "project-a")).ok).toBe(
      true,
    );
    expect(await api.listEntities("project-a", "prompt")).toHaveLength(0);
    api.close();
  });

  it("rejects overlapping project and durable-data directories", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-paths-"));
    expect(() =>
      createFs({
        projectsDir: path.join(root!, "workspace"),
        dataDir: path.join(root!, "workspace", "private"),
      }),
    ).toThrow(/must not overlap/);
  });

  it("projects lifecycle, lineage, layout, and actor lanes from one DoltLite history", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-book-"));
    const api = createFs({
      projectsDir: path.join(root, "projects"),
      dataDir: path.join(root, "data"),
    });
    await api.createProject("project-a");
    const prompt = await api.recordBookAction({
      projectSlug: "project-a",
      operation: "create_prompt",
      scope: "artifact",
      actor: "jwt",
      lane: "human",
      outputArtifactIds: ["prm-dancing-cat"],
      layout: { stage: 0, column: 0 },
      details: { prompt: "A white cat in a dance studio" },
    });
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) throw new Error(prompt.error.message);

    const imageActionId = "image-action";
    const requested = await api.recordBookAction({
      projectSlug: "project-a",
      actionId: imageActionId,
      operation: "generate_google_flow_nano_banana_pro",
      phase: "requested",
      scope: "artifact",
      actor: "agent-one",
      lane: "agent-one",
      parentActionIds: [prompt.value.action.id],
      inputArtifactIds: ["prm-dancing-cat"],
      layout: { stage: 1, column: 0 },
    });
    expect(requested.ok).toBe(true);
    const completed = await api.recordBookAction({
      projectSlug: "project-a",
      actionId: imageActionId,
      operation: "generate_google_flow_nano_banana_pro",
      phase: "completed",
      scope: "artifact",
      actor: "agent-one",
      lane: "agent-one",
      parentActionIds: [prompt.value.action.id],
      inputArtifactIds: ["prm-dancing-cat"],
      outputArtifactIds: ["img-dancing-cat"],
      targetArtifactId: "img-dancing-cat",
    });
    expect(completed.ok).toBe(true);

    const moved = await api.recordBookAction({
      projectSlug: "project-a",
      operation: "move_entry",
      scope: "layout",
      actor: "jwt",
      lane: "human",
      targetActionId: imageActionId,
      layout: { stage: 2, column: 3 },
      writeSet: [`layout:${imageActionId}`],
    });
    expect(moved.ok).toBe(true);

    const book = await api.getProjectBook("project-a", { limit: 100 });
    expect(book.ok).toBe(true);
    if (!book.ok) throw new Error(book.error.message);
    const image = book.value.actions.find(
      (action) => action.id === imageActionId,
    );
    expect(image).toMatchObject({
      phase: "completed",
      actor: "agent-one",
      lane: "agent-one",
      parentActionIds: [prompt.value.action.id],
    });
    expect(image?.events.map((event) => event.phase)).toEqual([
      "requested",
      "completed",
    ]);
    expect(image?.inputArtifacts[0]).toMatchObject({
      slug: "@prm-dancing-cat",
      kind: "prompt",
    });
    expect(image?.outputArtifacts[0]).toMatchObject({
      slug: "@img-dancing-cat",
      kind: "image",
    });
    const movedActionId = moved.ok ? moved.value.action.id : "";
    expect(
      book.value.actions.find((action) => action.id === movedActionId),
    ).toMatchObject({
      scope: "layout",
      targetActionId: imageActionId,
      layout: { stage: 2, column: 3 },
    });
    api.close();
  });

  it("rebases disjoint agent actions and rejects overlapping write sets", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "videobook-agents-"));
    const api = createFs({
      projectsDir: path.join(root, "projects"),
      dataDir: path.join(root, "data"),
    });
    await api.createProject("project-a");
    const initial = await api.getProjectBook("project-a");
    if (!initial.ok) throw new Error(initial.error.message);
    const baseRevision = initial.value.headRevision;

    const first = await api.recordBookAction({
      projectSlug: "project-a",
      operation: "edit_image",
      actor: "agent-one",
      lane: "agent-one",
      baseRevision,
      writeSet: ["artifact:img-cat"],
      targetArtifactId: "img-cat",
    });
    expect(first.ok).toBe(true);

    const disjoint = await api.recordBookAction({
      projectSlug: "project-a",
      operation: "edit_image",
      actor: "agent-two",
      lane: "agent-two",
      baseRevision,
      writeSet: ["artifact:img-dog"],
      targetArtifactId: "img-dog",
    });
    expect(disjoint.ok).toBe(true);
    if (disjoint.ok) expect(disjoint.value.action.rebasedOver).toBeTruthy();

    const conflict = await api.recordBookAction({
      projectSlug: "project-a",
      operation: "edit_image",
      actor: "agent-three",
      lane: "agent-three",
      baseRevision,
      writeSet: ["artifact:img-cat"],
      targetArtifactId: "img-cat",
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "ACTION_CONFLICT" },
    });

    const parallelBase = await api.getProjectBook("project-a");
    if (!parallelBase.ok) throw new Error(parallelBase.error.message);
    const disjointParallel = await Promise.all([
      api.recordBookAction({
        projectSlug: "project-a",
        operation: "parallel_edit",
        actor: "agent-one",
        lane: "agent-one",
        baseRevision: parallelBase.value.headRevision,
        writeSet: ["artifact:img-bird"],
        targetArtifactId: "img-bird",
      }),
      api.recordBookAction({
        projectSlug: "project-a",
        operation: "parallel_edit",
        actor: "agent-two",
        lane: "agent-two",
        baseRevision: parallelBase.value.headRevision,
        writeSet: ["artifact:img-fish"],
        targetArtifactId: "img-fish",
      }),
    ]);
    expect(disjointParallel.every((result) => result.ok)).toBe(true);

    const overlapBase = await api.getProjectBook("project-a");
    if (!overlapBase.ok) throw new Error(overlapBase.error.message);
    const overlappingParallel = await Promise.all([
      api.recordBookAction({
        projectSlug: "project-a",
        operation: "parallel_edit",
        actor: "agent-one",
        lane: "agent-one",
        baseRevision: overlapBase.value.headRevision,
        writeSet: ["artifact:img-shared"],
        targetArtifactId: "img-shared",
      }),
      api.recordBookAction({
        projectSlug: "project-a",
        operation: "parallel_edit",
        actor: "agent-two",
        lane: "agent-two",
        baseRevision: overlapBase.value.headRevision,
        writeSet: ["artifact:img-shared"],
        targetArtifactId: "img-shared",
      }),
    ]);
    expect(overlappingParallel.filter((result) => result.ok)).toHaveLength(1);
    expect(overlappingParallel.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "ACTION_CONFLICT" } },
    ]);
    api.close();
  });
});
