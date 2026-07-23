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
    if (!notebook.ok || !character.ok) throw new Error("Entity creation failed");
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
});
