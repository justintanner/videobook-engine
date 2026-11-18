import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/index.js";

// An artifact-work lease belongs to its owner until that owner completes or
// fails it (or the lease expires). Media writes made while the lease is held
// record files and hydrate the workspace; they never hand the artifact back.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{ engine: Engine; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-artifact-work-"));
  roots.push(root);
  const engine = createEngine({ rootDir: root, initialBookName: "leases" });
  await engine.ready;
  return { engine, root };
}

function value<T>(
  result:
    | { ok: true; value: T; revision?: string }
    | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROCESS = { kind: "process", ownerKind: "job", durationMs: 60_000 } as const;

function claim(engine: Engine, artifactId: string): { ownerId: string } {
  const lease = engine.jobs.artifactWork.begin(artifactId, PROCESS);
  if (!lease) throw new Error("could not begin artifact work");
  return lease;
}

async function expectOwned(
  engine: Engine,
  artifactId: string,
  ownerId: string,
): Promise<void> {
  expect(value(engine.jobs.artifactWork.read(artifactId))).toMatchObject({
    status: "working",
    ownerId,
    ownerKind: "job",
  });
  expect(value(await engine.status.get(artifactId))).toBe("processing");
  expect(engine.jobs.artifactWork.renew(artifactId, ownerId, 60_000)).toBe(true);
  expect(engine.jobs.artifactWork.begin(artifactId, PROCESS)).toBeNull();
}

function expectReleased(engine: Engine, artifactId: string): void {
  expect(value(engine.jobs.artifactWork.read(artifactId))).toMatchObject({
    status: "ready",
    ownerId: null,
    ownerKind: null,
    deadlineAt: null,
  });
}

type WritePath = "write" | "writeFromPath" | "copy" | "ingestWorkspace";

async function writeVariant(
  engine: Engine,
  root: string,
  how: WritePath,
  artifactId: string,
  filename: string,
  bytes: string,
): Promise<void> {
  switch (how) {
    case "write":
      value(await engine.files.write(artifactId, filename, bytes));
      return;
    case "writeFromPath": {
      const source = path.join(root, `source-${filename}`);
      await writeFile(source, bytes);
      value(await engine.files.writeFromPath(artifactId, filename, source));
      return;
    }
    case "copy": {
      const donor = value(await engine.artifacts.create("image", `donor ${filename}`));
      value(await engine.files.write(donor.artifactId, "donor.png", bytes));
      value(await engine.files.copy(donor.artifactId, "donor.png", artifactId, filename));
      return;
    }
    case "ingestWorkspace": {
      const workspace = value(await engine.workspaces.resolveArtifact(artifactId));
      await writeFile(path.join(workspace, filename), bytes);
      value(await engine.files.ingestWorkspace(artifactId, [filename]));
      return;
    }
  }
}

describe("artifact-work leases across media file writes", () => {
  it("keeps one owner through the several variant writes of an image job", async () => {
    const { engine } = await setup();
    const image = value(await engine.artifacts.create("image", "lease image"));
    const { artifactId } = image;
    const lease = claim(engine, artifactId);
    expect(engine.jobs.artifactWork.begin(artifactId, PROCESS)).toBeNull();

    value(await engine.files.write(artifactId, "original.png", "original"));
    await expectOwned(engine, artifactId, lease.ownerId);
    for (const variant of ["landscape", "portrait", "square"]) {
      value(await engine.files.write(artifactId, `${variant}.png`, variant));
      await expectOwned(engine, artifactId, lease.ownerId);
    }
    value(await engine.files.write(artifactId, "thumbnail.jpg", "thumbnail"));
    await expectOwned(engine, artifactId, lease.ownerId);

    expect(engine.jobs.artifactWork.complete(artifactId, lease.ownerId)).toBe(true);
    expectReleased(engine, artifactId);
    expect(engine.jobs.artifactWork.renew(artifactId, lease.ownerId, 60_000)).toBe(false);
    expect(value(await engine.status.get(artifactId))).toBe("ready");
    expect(
      value(await engine.files.read(artifactId, "thumbnail.jpg")).toString(),
    ).toBe("thumbnail");

    const next = claim(engine, artifactId);
    expect(next.ownerId).not.toBe(lease.ownerId);
    expect(engine.jobs.artifactWork.complete(artifactId, next.ownerId)).toBe(true);
    engine.close();
  });

  it.each<WritePath>(["write", "writeFromPath", "copy", "ingestWorkspace"])(
    "preserves an active lease across engine.files.%s",
    async (how) => {
      const { engine, root } = await setup();
      const image = value(await engine.artifacts.create("image", `lease ${how}`));
      const { artifactId } = image;
      const lease = claim(engine, artifactId);

      await writeVariant(engine, root, how, artifactId, "original.png", `${how}-1`);
      await expectOwned(engine, artifactId, lease.ownerId);
      await writeVariant(engine, root, how, artifactId, "thumbnail.png", `${how}-2`);
      await expectOwned(engine, artifactId, lease.ownerId);

      expect(engine.jobs.artifactWork.complete(artifactId, lease.ownerId)).toBe(true);
      expectReleased(engine, artifactId);
      expect(
        value(await engine.files.read(artifactId, "thumbnail.png")).toString(),
      ).toBe(`${how}-2`);
      const competitor = claim(engine, artifactId);
      expect(engine.jobs.artifactWork.complete(artifactId, competitor.ownerId)).toBe(true);
      engine.close();
    },
  );

  it("releases a written artifact through the owner's failure path", async () => {
    const { engine } = await setup();
    const image = value(await engine.artifacts.create("image", "lease failure"));
    const { artifactId } = image;
    const lease = claim(engine, artifactId);
    value(await engine.files.write(artifactId, "original.png", "original"));
    await expectOwned(engine, artifactId, lease.ownerId);

    expect(
      await engine.jobs.artifactWork.fail(artifactId, lease.ownerId, {
        message: "variant encoder crashed",
      }),
    ).toBe(true);
    expect(value(engine.jobs.artifactWork.read(artifactId))).toMatchObject({
      status: "error",
      ownerId: null,
    });
    expect(engine.jobs.artifactWork.renew(artifactId, lease.ownerId, 60_000)).toBe(false);
    engine.close();
  });

  it("still marks unleased writes ready with usable media", async () => {
    const { engine, root } = await setup();
    for (const how of ["write", "writeFromPath", "copy", "ingestWorkspace"] as const) {
      const image = value(await engine.artifacts.create("image", `unleased ${how}`));
      expect(value(engine.jobs.artifactWork.read(image.artifactId))?.status).toBe(
        "pending",
      );
      await writeVariant(engine, root, how, image.artifactId, "original.png", how);
      expectReleased(engine, image.artifactId);
      expect(value(await engine.status.get(image.artifactId))).toBe("ready");
      expect(
        value(await engine.files.read(image.artifactId, "original.png")).toString(),
      ).toBe(how);
      const lease = claim(engine, image.artifactId);
      expect(engine.jobs.artifactWork.complete(image.artifactId, lease.ownerId)).toBe(true);
    }
    engine.close();
  });

  it("does not preserve an expired lease that the reaper has not collected", async () => {
    const { engine } = await setup();
    const image = value(await engine.artifacts.create("image", "expired lease"));
    const { artifactId } = image;
    const stale = engine.jobs.artifactWork.begin(artifactId, {
      ...PROCESS,
      durationMs: 1,
    });
    if (!stale) throw new Error("could not begin artifact work");
    await sleep(20);

    value(await engine.files.write(artifactId, "original.png", "original"));
    expectReleased(engine, artifactId);
    expect(engine.jobs.artifactWork.renew(artifactId, stale.ownerId, 60_000)).toBe(false);
    const next = claim(engine, artifactId);
    expect(engine.jobs.artifactWork.complete(artifactId, next.ownerId)).toBe(true);
    engine.close();
  });
});
