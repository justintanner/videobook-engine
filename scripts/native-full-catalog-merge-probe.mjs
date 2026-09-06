import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RUNTIME_TABLES, SEMANTIC_TABLES } from "../dist/schema.js";

const require = createRequire(import.meta.url);
const requestedBinding = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];
const binding = requestedBinding?.startsWith(".")
  ? resolve(requestedBinding)
  : requestedBinding || "@dolthub/doltlite";
const runFile = promisify(execFile);
const value = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};

function operate(root, fixture) {
  const { DatabaseSync } = require(binding);
  let db = new DatabaseSync(join(root, "data", "videobook.db"));
  const runtimeRows = () => Object.fromEntries([...RUNTIME_TABLES, "sqlite_sequence"].map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table}`).all()
      .map((row) => JSON.stringify(row)).sort(),
  ]));
  const schemaRows = () => db.prepare(`
    SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name
  `).all();
  const allocateAndDeleteJob = () => {
    const { id } = db.prepare(`
      INSERT INTO runtime_jobs(operation_id,type,state,payload_json,enqueued_at)
      VALUES(?,'native-sequence-test','queued','{}',100) RETURNING id
    `).get(randomUUID());
    db.prepare("DELETE FROM runtime_jobs WHERE id=?").run(id);
    return id;
  };
  const deletedHighId = allocateAndDeleteJob();
  assert.ok(deletedHighId > fixture.job.id);
  const beforeRuntime = runtimeRows();
  const beforeSchema = schemaRows();
  const initialHead = db.doltHashOf("HEAD");
  const commit = (message) => {
    db.doltAdd("artifacts");
    return db.prepare("SELECT dolt_commit('-m', ?) AS hash").get(message).hash;
  };
  const fork = (name, change) => {
    db.doltBranch(name);
    db.doltCheckout(name);
    change();
    commit(name);
    db.doltCheckout("main");
    assert.deepEqual(runtimeRows(), beforeRuntime);
  };
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of ["a", "b"]) {
      fork(`full-${name}`, () => db.prepare(`
        INSERT INTO artifacts(artifact_id,kind,label,created_at)
        VALUES(?,'script',?,100)
      `).run(randomUUID(), `from ${name}`));
    }
    assert.deepEqual(db.doltStatus(), []);
    db.doltMerge("full-a");
    assert.deepEqual(runtimeRows(), beforeRuntime);
    db.doltMerge("full-b");
    assert.deepEqual(runtimeRows(), beforeRuntime);
    assert.deepEqual(db.prepare("SELECT label FROM artifacts ORDER BY label").all(), [
      { label: "base" }, { label: "from a" }, { label: "from b" },
    ]);
    assert.deepEqual(schemaRows(), beforeSchema);
    assert.deepEqual(db.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(db.doltStatus(), []);
    const acceptedHead = db.doltHashOf("HEAD");
    db.close();
    db = undefined;
    db = new DatabaseSync(join(root, "data", "videobook.db"));
    db.exec("PRAGMA foreign_keys=ON");
    assert.deepEqual(runtimeRows(), beforeRuntime);
    assert.equal(db.doltHashOf("HEAD"), acceptedHead);
    assert.deepEqual(db.prepare(`
      SELECT id FROM runtime_jobs INDEXED BY runtime_jobs_state WHERE state='queued'
    `).all(), [{ id: fixture.job.id }]);

    db.prepare("SELECT dolt_checkout('-b','commit-proof','HEAD')").get();
    const placeholders = RUNTIME_TABLES.map(() => "?").join(",");
    assert.equal(db.prepare(`
      SELECT count(*) AS n FROM sqlite_master
      WHERE type='table' AND name IN (${placeholders})
    `).get(...RUNTIME_TABLES).n, 0);
    db.doltCheckout("main");
    assert.deepEqual(runtimeRows(), beforeRuntime);

    for (const [name, label] of [["a", "accepted"], ["b", "rejected"]]) {
      fork(`conflict-${name}`, () => db.prepare(`
        UPDATE artifacts SET label=? WHERE artifact_id=?
      `).run(label, fixture.artifactId));
    }
    db.doltMerge("conflict-a");
    const conflictHead = db.doltHashOf("HEAD");
    assert.throws(() => db.doltMerge("conflict-b"), /conflicts detected/);
    assert.equal(db.doltHashOf("HEAD"), conflictHead);
    assert.deepEqual(runtimeRows(), beforeRuntime);
    assert.deepEqual(db.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const nextJobId = allocateAndDeleteJob();
    assert.ok(nextJobId > deletedHighId, "native merges must not reuse a deleted job ID");
    const nativeModules = Object.keys(require.cache).filter((path) => path.endsWith("/doltlite.node"));
    assert.equal(nativeModules.length, 1);
    return {
      nativeVersion: db.doltVersion(),
      engineTables: SEMANTIC_TABLES.length + RUNTIME_TABLES.length,
      runtimeTables: RUNTIME_TABLES.length,
      schemaObjects: beforeSchema.length,
      initialHead,
      acceptedHead,
      conflictHead,
      runtimeSequence: { deletedHighId, nextJobId },
      nativeModules,
      checks: [
        "fast-forward", "three-way", "all runtime rows", "all schema and indexes",
        "integrity", "foreign keys", "reopen", "runtime absent from HEAD",
        "conflict rollback", "sqlite_sequence preservation", "deleted job ID not reused",
      ],
    };
  } finally {
    db?.close();
  }
}

if (process.argv[3] === "--operate") {
  const root = process.argv[4];
  const fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
  console.log(JSON.stringify(operate(root, fixture)));
} else {
  const { createEngine } = await import("../dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "ve-native-full-catalog-"));
  const dataDir = join(root, "data");
  const workspaceDir = join(root, "workspace");
  const keep = process.argv.includes("--keep");
  let engine;
  try {
    engine = createEngine({ dataDir, workspaceDir, initialBookName: "Native merge fixture" });
    await engine.ready;
    const artifact = value(await engine.artifacts.create({ kind: "script", label: "base" }));
    value(await engine.files.write(artifact.artifactId, "original.md", "base content"));
    value(engine.settings.set("test.native-merge", { marker: 42 }));
    const job = engine.jobs.queue.enqueue({ type: "native-merge-test", payload: { marker: 42 } }).job;
    await writeFile(join(root, "fixture.json"), JSON.stringify({ artifactId: artifact.artifactId, job }));
    engine.close();
    engine = undefined;

    const { stdout } = await runFile(process.execPath, [
      fileURLToPath(import.meta.url), binding, "--operate", root,
    ], { maxBuffer: 10 * 1024 * 1024 });
    const report = JSON.parse(stdout);
    engine = createEngine({ dataDir, workspaceDir });
    await engine.ready;
    assert.equal(value(await engine.files.read(artifact.artifactId, "original.md")).toString(), "base content");
    assert.deepEqual(engine.artifacts.list().map((row) => row.label).sort(), ["accepted", "from a", "from b"]);
    assert.equal(engine.jobs.queue.get(job.id)?.state, job.state);
    const reopenedJob = engine.jobs.queue.enqueue({ type: "native-sequence-reopen", payload: {} }).job;
    assert.ok(reopenedJob.id > report.runtimeSequence.nextJobId);
    report.runtimeSequence.reopenedJobId = reopenedJob.id;
    assert.deepEqual(Object.keys(engine.catalogIntegrity().tableRowCounts).sort(), [
      ...SEMANTIC_TABLES, ...RUNTIME_TABLES, "dolt_ignore",
    ].sort());
    report.checks.push("published binding reopen", "published binding job ID allocation", "CAS file contents", "queued job");
    report.passed = true;
    if (keep) report.retainedRoot = root;
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    engine?.close();
    if (!keep) await rm(root, { recursive: true, force: true });
  }
}
