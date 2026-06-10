import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSandbox, type Sandbox } from "./helpers/sandbox.js";
import { createFs } from "../src/index.js";
import { closeAllStateDbs, getStateDb } from "../src/db/client.js";
import { withGitLock } from "../src/git/mutex.js";
import {
  commitAndFinalizeOperation,
  runOperation,
} from "../src/db/run-operation.js";
import { QueueRunner } from "../src/queue/runner.js";

const execFileAsync = promisify(execFile);

const BAD_GIT = "/nonexistent/git-binary";

describe("commit failures surface as GIT_ERROR (audit H1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
    await sandbox.fs.createAsset("vid", "clip", "test-proj");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  function badGitFs(): ReturnType<typeof createFs> {
    return createFs({ projectsDir: sandbox.projectsDir, gitPath: BAD_GIT });
  }

  it("writeFile returns GIT_ERROR when the commit fails", async () => {
    const result = await badGitFs().writeFile(
      "vid-clip",
      "data.txt",
      "hello",
      "test-proj",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");
  });

  it("writeFile still succeeds when there is nothing to commit", async () => {
    const first = await sandbox.fs.writeFile(
      "vid-clip",
      "data.txt",
      "same content",
      "test-proj",
    );
    expect(first.ok).toBe(true);
    // Identical rewrite produces no diff — must be ok, not GIT_ERROR
    const second = await sandbox.fs.writeFile(
      "vid-clip",
      "data.txt",
      "same content",
      "test-proj",
    );
    expect(second.ok).toBe(true);
  });

  it("deleteFile returns GIT_ERROR when the commit fails", async () => {
    await sandbox.fs.writeFile("vid-clip", "doomed.txt", "x", "test-proj");
    const result = await badGitFs().deleteFile(
      "vid-clip",
      "doomed.txt",
      "test-proj",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");
  });

  it("renameFile returns GIT_ERROR when the commit fails", async () => {
    await sandbox.fs.writeFile("vid-clip", "old.txt", "x", "test-proj");
    const result = await badGitFs().renameFile(
      "vid-clip",
      "old.txt",
      "new.txt",
      "test-proj",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");
  });

  it("copyFile returns GIT_ERROR when the commit fails", async () => {
    await sandbox.fs.writeFile("vid-clip", "src.txt", "x", "test-proj");
    const result = await badGitFs().copyFile(
      "vid-clip",
      "src.txt",
      "vid-clip",
      "copy.txt",
      "test-proj",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");
  });

  it("createAsset returns GIT_ERROR when the commit fails", async () => {
    const result = await badGitFs().createAsset("img", "broken", "test-proj");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");
  });
});

describe("journal finalization on clean commit (audit M1)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("marks the journal complete when the commit is a no-op", async () => {
    const dir = (await sandbox.fs.resolveProjectDir("test-proj"))!;

    const result = await runOperation(dir, {
      intent: "write_project_meta",
      scope: "project",
      subject: "noop operation",
      work: () => {},
    });

    // Bring the tree to a clean state so the paired commit has no diff.
    const gitEnv = { ...process.env, HOME: sandbox.dir };
    await execFileAsync("git", ["-C", dir, "add", "-A"], { env: gitEnv });
    await execFileAsync(
      "git",
      ["-C", dir, "commit", "--allow-empty", "-m", "test: flush"],
      { env: gitEnv },
    );

    const commit = await commitAndFinalizeOperation(dir, result, {
      operation: "write",
    });
    expect(commit.status).toBe("clean");

    const row = getStateDb(dir)
      .prepare("SELECT status FROM recovery_journal WHERE operation_id = ?")
      .get(result.operationId) as { status: string };
    expect(row.status).toBe("complete");
  });
});

describe("withGitLock chain survives acquisition failure (audit H2)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-mutex-"));
  });

  afterEach(async () => {
    await fs.chmod(baseDir, 0o755).catch(() => {});
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("later callers proceed after a failed acquisition", async () => {
    const projectDir = path.join(baseDir, "proj");
    await fs.mkdir(projectDir);
    // Read-only project dir makes the .videocity mkdir inside withGitLock throw
    await fs.chmod(projectDir, 0o555);

    await expect(withGitLock(projectDir, async () => "ran")).rejects.toThrow();

    await fs.chmod(projectDir, 0o755);

    // Pre-fix this awaited a chain promise that never settles
    const second = await Promise.race([
      withGitLock(projectDir, async () => "ran"),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
    ]);
    expect(second).toBe("ran");
  });
});

describe("acquireLock conditional stale delete (audit H3)", () => {
  let projectsDir: string;
  let projectDir: string;
  let assetDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-lockrace-"));
    projectDir = path.join(projectsDir, "proj");
    assetDir = path.join(projectDir, "vid-test");
    await fs.mkdir(assetDir, { recursive: true });
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("a failed acquire never deletes a live lock row", async () => {
    const cfs = createFs({ projectsDir });
    const db = getStateDb(projectDir);
    const createdAt = Date.now() / 1000;
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", process.pid, createdAt, createdAt + 3600);

    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("LOCKED");

    const row = db
      .prepare("SELECT created_at FROM locks WHERE asset_id = ?")
      .get("vid-test") as { created_at: number };
    expect(row.created_at).toBe(createdAt);
  });

  it("an expired lock row is still reaped and taken over", async () => {
    const cfs = createFs({ projectsDir });
    const db = getStateDb(projectDir);
    db.prepare(
      `INSERT INTO locks (asset_id, pid, created_at, timeout_at)
       VALUES (?, ?, ?, ?)`,
    ).run("vid-test", process.pid, 1000, 2000);

    const result = await cfs.acquireLock(assetDir, { durationMs: 60_000 });
    expect(result.ok).toBe(true);
  });
});

describe("QueueRunner.waitFor tolerates corrupt terminal columns (audit M2)", () => {
  let projectsDir: string;
  let cfs: ReturnType<typeof createFs>;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-runner-"));
    cfs = createFs({ projectsDir });
    const created = await cfs.createProject("p");
    expect(created.ok).toBe(true);
  });

  afterEach(async () => {
    closeAllStateDbs();
    await fs.rm(projectsDir, { recursive: true, force: true });
  });

  it("throws a clean error instead of a SyntaxError on corrupt result JSON", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    await cfs.queue.enqueue("p", { type: "noop", payload: {} });
    const { id } = db.prepare("SELECT id FROM pending_jobs LIMIT 1").get() as {
      id: number;
    };
    db.prepare(
      "UPDATE pending_jobs SET state = 'done', result = '{corrupt' WHERE id = ?",
    ).run(id);

    const runner = new QueueRunner(db, {
      concurrency: 1,
      resolveHandler: () => null,
    });
    await expect(runner.waitFor(id, 2_000)).rejects.toThrow(/corrupt JSON/);
  });

  it("falls back to the raw error column when it is not JSON", async () => {
    const dir = (await cfs.resolveProjectDir("p"))!;
    const db = getStateDb(dir);
    await cfs.queue.enqueue("p", { type: "noop", payload: {} });
    const { id } = db.prepare("SELECT id FROM pending_jobs LIMIT 1").get() as {
      id: number;
    };
    db.prepare(
      "UPDATE pending_jobs SET state = 'failed', error = 'boom{' WHERE id = ?",
    ).run(id);

    const runner = new QueueRunner(db, {
      concurrency: 1,
      resolveHandler: () => null,
    });
    await expect(runner.waitFor(id, 2_000)).rejects.toThrow(/failed: boom\{/);
  });
});

describe("action log control-char sanitization (audit M3)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("round-trips a payload containing newlines and separator bytes", async () => {
    const payload = "line one\nline two\x1fwith separator";
    const result = await sandbox.fs.logAction("chat", payload, "test-proj");
    expect(result.ok).toBe(true);

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("chat");
    // Newlines survive in the body; the \x1f field separator is collapsed
    expect(log[0]!.payload).toBe("line one\nline two with separator");
  });

  it("keeps the subject parseable when the payload starts with newlines", async () => {
    const result = await sandbox.fs.logAction(
      "chat",
      "\n\nstarts with blank lines",
      "test-proj",
    );
    expect(result.ok).toBe(true);

    const log = await sandbox.fs.getActionLog(undefined, "test-proj");
    expect(log).toHaveLength(1);
    expect(log[0]!.action).toBe("chat");
  });
});

describe("deleteAsset rolls back on commit failure (vce-q39)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
    await sandbox.fs.createAsset("aud", "track", "test-proj");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  async function installFailingPreCommitHook(
    projectDir: string,
  ): Promise<string> {
    const hookPath = path.join(projectDir, ".git", "hooks", "pre-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return hookPath;
  }

  it("restores the asset dir and waveform row when the commit fails", async () => {
    const dir = (await sandbox.fs.resolveProjectDir("test-proj"))!;
    await sandbox.fs.writeFile(
      "aud-track",
      "notes.txt",
      "keep me",
      "test-proj",
    );
    const wf = await sandbox.fs.writeAudioWaveform(
      "aud-track",
      [0.1, 0.5, 0.9],
      "test-proj",
    );
    expect(wf.ok).toBe(true);

    // Hook makes `git commit` fail while add/checkout still work
    const hookPath = await installFailingPreCommitHook(dir);

    const result = await sandbox.fs.deleteAsset("aud-track", "test-proj");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("GIT_ERROR");

    // Asset dir and committed file restored from HEAD
    const restored = await fs.readFile(
      path.join(dir, "aud-track", "notes.txt"),
      "utf-8",
    );
    expect(restored).toBe("keep me");

    // Waveform row + export restored
    const record = await sandbox.fs.readAudioWaveform("aud-track", "test-proj");
    expect(record.ok).toBe(true);
    if (!record.ok) return;
    expect(record.value.peaks).toEqual([0.1, 0.5, 0.9]);

    // With the hook removed, the delete goes through
    await fs.rm(hookPath);
    const retry = await sandbox.fs.deleteAsset("aud-track", "test-proj");
    expect(retry.ok).toBe(true);
    await expect(fs.access(path.join(dir, "aud-track"))).rejects.toThrow();
  });
});

describe("withGitLock fails when the project dir vanished (vce-tvr)", () => {
  it("a waiter queued behind a rename does not recreate the old dir", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-tvr-"));
    try {
      const projectDir = path.join(baseDir, "proj");
      await fs.mkdir(projectDir);

      let releaseHolder: () => void;
      const holderGate = new Promise<void>((r) => {
        releaseHolder = r;
      });
      // Holder takes the lock; while held, simulate a rename away
      const holder = withGitLock(projectDir, async () => {
        await holderGate;
      });
      // Give the holder a beat to acquire before queueing the waiter
      await new Promise((r) => setTimeout(r, 100));
      const waiter = withGitLock(projectDir, async () => "ran");

      await fs.rename(projectDir, path.join(baseDir, "renamed"));
      releaseHolder!();

      // The holder's release outcome isn't under test (its lockfile moved
      // with the rename); only the waiter's behavior matters here.
      await holder.catch(() => {});
      await expect(waiter).rejects.toThrow(/does not exist/);
      // The stray old dir must not have been recreated by the waiter
      await expect(fs.access(projectDir)).rejects.toThrow();
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe("migration checksum guard rejects unknown applied versions (vce-32g)", () => {
  it("refuses to open a state db with a version this build does not know", async () => {
    const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), "vc-32g-"));
    try {
      const projectDir = path.join(projectsDir, "proj");
      await fs.mkdir(projectDir, { recursive: true });
      const db = getStateDb(projectDir);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(9999, "from_the_future", "deadbeef", Date.now());
      closeAllStateDbs();

      expect(() => getStateDb(projectDir)).toThrow(/unknown to this build/);
    } finally {
      closeAllStateDbs();
      await fs.rm(projectsDir, { recursive: true, force: true });
    }
  });
});

describe("commit body sanitization (vce-bju)", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.fs.createProject("test-proj");
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("control chars in details values cannot inject body lines", async () => {
    const dir = (await sandbox.fs.resolveProjectDir("test-proj"))!;
    // Dirty the tree so the commit has something to record
    await fs.writeFile(path.join(dir, "dirty.txt"), "x");
    const hash = await sandbox.fs.commitOperation(
      "write",
      undefined,
      { note: "evil\nop-id: forged-uuid" },
      "test-proj",
    );
    expect(hash).toBeTruthy();

    const { stdout } = await execFileAsync(
      "git",
      ["-C", dir, "log", "-1", "--format=%B"],
      { env: { ...process.env, HOME: sandbox.dir } },
    );
    expect(stdout).toContain("note: evil op-id: forged-uuid");
    expect(stdout).not.toMatch(/^op-id: forged-uuid$/m);
  });
});
