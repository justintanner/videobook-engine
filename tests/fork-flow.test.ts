import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";
import { afterEach, describe, expect, it } from "vitest";

import { createEngine, type Engine } from "../src/engine.js";
import type { ContentStore, EngineError } from "../src/engine-types.js";
import { bootstrapFork, mergeBack } from "../src/fork.js";
import { EngineFault } from "../src/store.js";

// End-to-end fork flow: fork bootstrap from a catalog snapshot, divergent
// edits on both sides, and the dedicated merge-back integration flow.
//
// URL and snapshot bootstrap use real catalogs and object stores. Merge-back
// keeps the projection flow because native merge rejects ignored runtime
// tables; its fetch, policy, object upload, and push are exercised here.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function expectFault(work: () => Promise<unknown>): Promise<EngineError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof EngineFault) return error.error;
    throw error;
  }
  throw new Error("Expected an EngineFault");
}

function fileContentStore(root: string): ContentStore {
  return {
    async head(key) {
      try {
        const info = await stat(path.join(root, key));
        return { exists: true, size: info.size };
      } catch {
        return { exists: false };
      }
    },
    async uploadFile(key, sourcePath) {
      const destination = path.join(root, key);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
    },
    async downloadFile(key, destinationPath) {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(path.join(root, key), destinationPath);
    },
    async delete(key) {
      await rm(path.join(root, key), { force: true });
    },
  };
}

/**
 * The fork's object store in the platform model: reads fall through to the
 * upstream public store, writes land in the fork's own public store.
 * `ContentStore` stays the abstraction — the engine cannot tell this from
 * a flat store.
 */
function overlayContentStore(
  mine: ContentStore,
  upstream: ContentStore,
): ContentStore {
  return {
    async head(key) {
      const own = await mine.head(key);
      return own.exists ? own : upstream.head(key);
    },
    async uploadFile(key, sourcePath) {
      await mine.uploadFile(key, sourcePath);
    },
    async downloadFile(key, destinationPath) {
      const own = await mine.head(key);
      if (own.exists) return mine.downloadFile(key, destinationPath);
      return upstream.downloadFile(key, destinationPath);
    },
    async delete(key) {
      await mine.delete(key);
    },
  };
}

interface ForkFixture {
  root: string;
  upstreamUrl: string;
  forkUrl: string;
  upstreamData: string;
  forkData: string;
  upstreamObjects: ContentStore;
  forkObjects: ContentStore;
  upstreamObjectRoot: string;
  prefix: string;
  /** Artifact created upstream before the fork was taken. */
  baseArtifactId: string;
}

async function setupForkedCatalogs(): Promise<ForkFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "videobook-fork-flow-"));
  roots.push(root);
  const prefix = "videobook";
  const upstreamUrl = `file://${path.join(root, "upstream-catalog.db")}`;
  const forkUrl = `file://${path.join(root, "fork-catalog.db")}`;
  const upstreamData = path.join(root, "upstream-data");
  const forkData = path.join(root, "fork-data");
  const upstreamObjectRoot = path.join(root, "upstream-objects");
  const upstreamObjects = fileContentStore(upstreamObjectRoot);
  const forkObjects = fileContentStore(path.join(root, "fork-objects"));

  const upstream = createEngine({
    dataDir: upstreamData,
    workspaceDir: path.join(root, "upstream-workspace"),
    initialBookName: "fork-book",
    remoteObjects: upstreamObjects,
    objectPrefix: prefix,
    catalogBackup: { name: "origin", url: upstreamUrl },
  });
  const base = value(
    await upstream.artifacts.create({ kind: "image", label: "img-base" }),
  );
  value(
    await upstream.files.write(base.artifactId, "original.png", "base bytes"),
  );
  value(await upstream.storage.backup());
  upstream.close();

  // The platform fork hands the forker a snapshot of the catalog database;
  // bootstrapFork clones it into a new engine root.
  const fork = await bootstrapFork({
    snapshotPath: path.join(upstreamData, "videobook.db"),
    dataDir: forkData,
    workspaceDir: path.join(root, "fork-workspace"),
    remoteObjects: overlayContentStore(forkObjects, upstreamObjects),
    objectPrefix: prefix,
    catalogBackup: { name: "fork", url: forkUrl },
  });
  await fork.ready;
  fork.close();

  return {
    root,
    upstreamUrl,
    forkUrl,
    upstreamData,
    forkData,
    upstreamObjects,
    forkObjects,
    upstreamObjectRoot,
    prefix,
    baseArtifactId: base.artifactId,
  };
}

async function openFork(fixture: ForkFixture): Promise<Engine> {
  const fork = createEngine({
    dataDir: fixture.forkData,
    workspaceDir: path.join(fixture.root, "fork-workspace"),
    remoteObjects: overlayContentStore(
      fixture.forkObjects,
      fixture.upstreamObjects,
    ),
    objectPrefix: fixture.prefix,
    catalogBackup: { name: "fork", url: fixture.forkUrl },
  });
  await fork.ready;
  return fork;
}

async function openUpstream(fixture: ForkFixture): Promise<Engine> {
  const upstream = createEngine({
    dataDir: fixture.upstreamData,
    workspaceDir: path.join(fixture.root, "upstream-workspace"),
    remoteObjects: fixture.upstreamObjects,
    objectPrefix: fixture.prefix,
    catalogBackup: { name: "origin", url: fixture.upstreamUrl },
  });
  await upstream.ready;
  return upstream;
}

describe("fork bootstrap", () => {
  it("clones a catalog snapshot and reads upstream objects lazily", async () => {
    const fixture = await setupForkedCatalogs();
    const fork = await openFork(fixture);
    // The bootstrap copied only the catalog database; the object bytes are
    // fetched from the public store on first read (ensureLocal).
    const base = value(fork.artifacts.get(fixture.baseArtifactId));
    expect(
      value(await fork.files.read(base.artifactId, "original.png")).toString(),
    ).toBe("base bytes");

    // The fork is a full citizen: it commits on its own main and backs up
    // to its own catalog remote.
    const mine = value(
      await fork.artifacts.create({ kind: "video", label: "vid-fork" }),
    );
    value(
      await fork.files.write(mine.artifactId, "original.mp4", "fork bytes"),
    );
    expect(value(await fork.storage.backup()).state).toBe("backed_up");
    fork.close();
  });

  it("clones a complete catalog from its URL and reopens it with intact history", async () => {
    const fixture = await setupForkedCatalogs();
    const options = {
      dataDir: path.join(fixture.root, "url-clone-data"),
      workspaceDir: path.join(fixture.root, "url-clone-workspace"),
      remoteObjects: fixture.upstreamObjects,
      objectPrefix: "videobook",
    };
    const fork = await bootstrapFork({ ...options, upstreamUrl: fixture.upstreamUrl });
    let head: string;
    try {
      await fork.ready;
      expect(value(fork.artifacts.get(fixture.baseArtifactId)).label).toBe("img-base");
      expect(value(await fork.files.read(fixture.baseArtifactId, "original.png")).toString()).toBe("base bytes");
      expect(fork.catalogIntegrity().tableRowCounts.artifacts).toBe(1);
      const artifact = value(await fork.artifacts.create({ kind: "script", label: "from URL" }));
      value(await fork.files.write(artifact.artifactId, "original.md", "after clone"));
      head = fork.head;
      expect(fork.history.revisions().length).toBeGreaterThan(2);
    } finally {
      fork.close();
    }
    const reopened = createEngine(options);
    try {
      await reopened.ready;
      expect(reopened.head).toBe(head);
      expect(reopened.artifacts.list().map((artifact) => artifact.label).sort()).toEqual(["from URL", "img-base"]);
      expect(reopened.catalogIntegrity().tableRowCounts.artifacts).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("rejects an unavailable catalog URL with a typed bootstrap error", async () => {
    const fixture = await setupForkedCatalogs();
    const error = await expectFault(() => bootstrapFork({
      upstreamUrl: `file://${path.join(fixture.root, "missing-catalog.db")}`,
      dataDir: path.join(fixture.root, "missing-url-data"),
      workspaceDir: path.join(fixture.root, "missing-url-workspace"),
    }));
    expect(error.code).toBe("FEATURE_UNAVAILABLE");
    expect(error.message).toContain("snapshotPath");
    expect(error.details?.cause).toEqual(expect.any(String));
  });
});

describe("merge-back integration flow", () => {
  it("lands a forward integration commit on main and moves fork objects upstream", async () => {
    const fixture = await setupForkedCatalogs();

    // Fork diverges: new artifact with new object, published to the fork's
    // own stores.
    const fork = await openFork(fixture);
    const forkArtifact = value(
      await fork.artifacts.create({ kind: "video", label: "vid-fork" }),
    );
    value(
      await fork.files.write(
        forkArtifact.artifactId,
        "original.mp4",
        "fork bytes",
      ),
    );
    const forkManifest = value(
      await fork.files.manifest(forkArtifact.artifactId),
    );
    const forkObjectHash = forkManifest.files[0]?.objectHash;
    if (!forkObjectHash) throw new Error("missing fork object hash");
    value(await fork.storage.backup());
    fork.close();

    // Upstream moves ahead too.
    const upstream = await openUpstream(fixture);
    const upstreamArtifact = value(
      await upstream.artifacts.create({ kind: "audio", label: "aud-upstream" }),
    );
    value(
      await upstream.files.write(
        upstreamArtifact.artifactId,
        "original.mp3",
        "upstream audio",
      ),
    );
    value(await upstream.storage.backup());
    const upstreamHead = upstream.head;
    upstream.close();

    // The fork's new object is not upstream yet.
    await expect(
      stat(
        path.join(
          fixture.upstreamObjectRoot,
          fixture.prefix,
          forkObjectHash.slice(0, 2),
          forkObjectHash,
        ),
      ),
    ).rejects.toThrow();

    const result = await mergeBack({
      upstreamDbPath: path.join(fixture.upstreamData, "videobook.db"),
      forkRemote: { url: fixture.forkUrl },
      upstreamObjects: fixture.upstreamObjects,
      forkObjects: fixture.forkObjects,
      objectPrefix: fixture.prefix,
      keepWorkDir: true,
    });
    roots.push(result.workDir!);

    expect(result.alreadyIntegrated).toBe(false);
    expect(result.oursRevision).toBe(upstreamHead);
    expect(result.integrationCommit).not.toBe(upstreamHead);
    expect(result.uploadedObjects).toEqual([forkObjectHash]);

    // The fork's object is upstream now, and it moved before the catalog
    // ref did (objects-before-push ordering, as in storage.backup).
    await expect(
      stat(
        path.join(
          fixture.upstreamObjectRoot,
          fixture.prefix,
          forkObjectHash.slice(0, 2),
          forkObjectHash,
        ),
      ),
    ).resolves.toBeDefined();

    // The merge workspace holds the forward integration commit on main with
    // the fork head recorded in the merged-revision trailer, and the merged
    // catalog contains both sides' rows.
    const merged = new DatabaseSync(
      path.join(result.workDir!, "videobook.db"),
      { readOnly: true },
    );
    const log = merged.doltLog({ limit: 3 });
    expect(log[0]?.commit_hash).toBe(result.integrationCommit);
    expect(log[0]?.message).toContain("merge_back");
    expect(log[0]?.message).toContain(
      `merged-revision: ${result.theirsRevision}`,
    );
    expect(log[0]?.message).toContain(`base-revision: ${result.baseRevision}`);
    // The integration commit carries a write-set trailer so edit conflict
    // detection sees integrated changes like locally committed ones.
    expect(log[0]?.message).toContain("write-set: ");
    expect(log[0]?.message).toContain(`object:${forkObjectHash}`);
    expect(log[1]?.commit_hash).toBe(upstreamHead);
    const labels = (
      merged
        .prepare("SELECT label FROM artifacts ORDER BY label")
        .all() as Array<{ label: string }>
    ).map((row) => row.label);
    expect(labels).toEqual(["aud-upstream", "img-base", "vid-fork"]);
    merged.close();

    // The integration commit landed on the upstream remote: a fresh fetch
    // sees origin/main at the integration commit with both sides' rows.
    const verifyDir = await mkdtemp(path.join(tmpdir(), "videobook-verify-"));
    roots.push(verifyDir);
    await copyFile(
      path.join(fixture.upstreamData, "videobook.db"),
      path.join(verifyDir, "videobook.db"),
    );
    const verify = new DatabaseSync(path.join(verifyDir, "videobook.db"));
    verify.prepare("SELECT dolt_fetch('origin') AS result").get();
    // doltHashOf returns content hashes; resolve the commit hash through a
    // local branch pointer on the fetched ref.
    verify.doltBranch("verify", "origin/main");
    expect(
      verify.doltBranches().find((branch) => branch.name === "verify")?.hash,
    ).toBe(result.integrationCommit);
    const remoteLabels = (
      verify
        .prepare(
          "SELECT label FROM dolt_at_artifacts('origin/main') ORDER BY label",
        )
        .all() as Array<{ label: string }>
    ).map((row) => row.label);
    expect(remoteLabels).toEqual(["aud-upstream", "img-base", "vid-fork"]);
    verify.close();

    // Re-running the flow against the integrated catalog (the merge
    // workspace is a healthy copy whose main carries the integration
    // commit) integrates nothing new but stays green.
    const second = await mergeBack({
      upstreamDbPath: path.join(result.workDir!, "videobook.db"),
      forkRemote: { url: fixture.forkUrl },
      upstreamObjects: fixture.upstreamObjects,
      forkObjects: fixture.forkObjects,
      objectPrefix: fixture.prefix,
    });
    expect(second.alreadyIntegrated).toBe(true);
    expect(second.integrationCommit).toBe(result.integrationCommit);
    expect(second.uploadedObjects).toEqual([]);
  });

  it("merges independent takedowns of the same object", async () => {
    const fixture = await setupForkedCatalogs();
    const readForgottenAt = (dbPath: string, hash: string): number | null => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare("SELECT forgotten_at FROM objects WHERE object_hash=?")
        .get(hash) as unknown as { forgotten_at: number | null } | undefined;
      db.close();
      return row?.forgotten_at ?? null;
    };

    // The fork applies the takedown first (earlier wall clock)…
    const fork = await openFork(fixture);
    const manifest = value(await fork.files.manifest(fixture.baseArtifactId));
    const hash = manifest.files[0]?.objectHash;
    if (!hash) throw new Error("missing base object hash");
    value(
      await fork.storage.deleteObject(hash, { force: true, remote: false }),
    );
    value(await fork.storage.backup());
    fork.close();
    const forkForgottenAt = readForgottenAt(
      path.join(fixture.forkData, "videobook.db"),
      hash,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // …then upstream applies the same takedown independently.
    const upstream = await openUpstream(fixture);
    value(
      await upstream.storage.deleteObject(hash, { force: true, remote: false }),
    );
    value(await upstream.storage.backup());
    upstream.close();
    const upstreamForgottenAt = readForgottenAt(
      path.join(fixture.upstreamData, "videobook.db"),
      hash,
    );
    expect(forkForgottenAt).not.toBeNull();
    expect(upstreamForgottenAt).not.toBeNull();
    expect(forkForgottenAt!).toBeLessThan(upstreamForgottenAt!);

    // Same-cell different-value on objects.forgotten_at must not wedge the
    // merge: forget wins and the earlier stamp is kept.
    const result = await mergeBack({
      upstreamDbPath: path.join(fixture.upstreamData, "videobook.db"),
      forkRemote: { url: fixture.forkUrl },
      upstreamObjects: fixture.upstreamObjects,
      forkObjects: fixture.forkObjects,
      objectPrefix: fixture.prefix,
      keepWorkDir: true,
    });
    roots.push(result.workDir!);
    expect(result.alreadyIntegrated).toBe(false);
    expect(
      readForgottenAt(path.join(result.workDir!, "videobook.db"), hash),
    ).toBe(forkForgottenAt);
  });

  it("merges identically-named artifacts created on both sides", async () => {
    const fixture = await setupForkedCatalogs();

    const fork = await openFork(fixture);
    const forkArtifact = value(
      await fork.artifacts.create({ kind: "video", label: "vid-cat" }),
    );
    value(await fork.storage.backup());
    fork.close();

    const upstream = await openUpstream(fixture);
    const upstreamArtifact = value(
      await upstream.artifacts.create({ kind: "video", label: "vid-cat" }),
    );
    value(await upstream.storage.backup());
    upstream.close();

    // Artifact identity is artifact_id (UUIDv7): the same display label on
    // both sides is not a conflict class, so the merge-back succeeds and
    // keeps both rows.
    const result = await mergeBack({
      upstreamDbPath: path.join(fixture.upstreamData, "videobook.db"),
      forkRemote: { url: fixture.forkUrl },
      upstreamObjects: fixture.upstreamObjects,
      forkObjects: fixture.forkObjects,
      objectPrefix: fixture.prefix,
      keepWorkDir: true,
    });
    roots.push(result.workDir!);
    expect(result.alreadyIntegrated).toBe(false);

    const merged = new DatabaseSync(
      path.join(result.workDir!, "videobook.db"),
      { readOnly: true },
    );
    const rows = merged
      .prepare(
        "SELECT artifact_id, label FROM artifacts WHERE label='vid-cat' ORDER BY artifact_id",
      )
      .all() as Array<{ artifact_id: string; label: string }>;
    merged.close();
    expect(rows.map((row) => row.artifact_id)).toEqual(
      [forkArtifact.artifactId, upstreamArtifact.artifactId].sort(),
    );
    expect(rows[0]?.artifact_id).not.toBe(rows[1]?.artifact_id);
    expect(rows.map((row) => row.label)).toEqual(["vid-cat", "vid-cat"]);
  });

  it("points a diverged backup into the merge-back flow", async () => {
    const fixture = await setupForkedCatalogs();

    // A second machine bootstraps from the upstream catalog and works
    // directly on the upstream remote; upstream moves after it cloned.
    const secondMachine = await bootstrapFork({
      snapshotPath: path.join(fixture.upstreamData, "videobook.db"),
      dataDir: path.join(fixture.root, "machine2-data"),
      workspaceDir: path.join(fixture.root, "machine2-workspace"),
      remoteObjects: fixture.upstreamObjects,
      objectPrefix: fixture.prefix,
      catalogBackup: { name: "origin", url: fixture.upstreamUrl },
    });
    await secondMachine.ready;

    const upstream = await openUpstream(fixture);
    value(
      await upstream.artifacts.create({ kind: "audio", label: "aud-moved" }),
    );
    value(await upstream.storage.backup());
    upstream.close();

    value(
      await secondMachine.artifacts.create({
        kind: "image",
        label: "img-local",
      }),
    );
    const backup = await secondMachine.storage.backup();
    expect(backup.ok).toBe(false);
    if (backup.ok) throw new Error("expected DIVERGED");
    expect(backup.error.code).toBe("DIVERGED");
    expect(backup.error.message).toContain("merge-back");
    expect(backup.error.message).toContain("mergeBack");
    expect(secondMachine.storage.status().state).toBe("diverged");
    secondMachine.close();
  });
});
