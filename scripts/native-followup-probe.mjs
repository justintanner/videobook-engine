import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exit 1 until both upstream regressions are fixed; never mutates the package.
const repository = resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(join(repository, 'package.json'));
const { DatabaseSync } = require('@dolthub/doltlite');
const { version } = require('@dolthub/doltlite/package.json');
const { mergeWithPolicy } = await import(pathToFileURL(join(repository, 'dist/merge-policy.js')));
console.log(JSON.stringify({ package: '@dolthub/doltlite', version, node: process.version, platform: process.platform, arch: process.arch }));
const root = mkdtempSync(join(tmpdir(), 'videobook-native-followups-'));
const checks = [];
function check(name, work) {
  const db = new DatabaseSync(join(root, `${name}.db`));
  try {
    const evidence = work(db);
    checks.push({ name, ...evidence });
  } catch (error) {
    checks.push({ name, pass: false, unexpectedError: String(error) });
  } finally { db.close(); }
}
const commit = (db, tables, message) => {
  for (const table of tables) db.doltAdd(table);
  db.prepare("SELECT dolt_commit('-m', ?) AS hash").get(message);
};
try {
  check('hard-reset-ignored-sequence', (db) => {
    db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items VALUES(1,'base');
      CREATE TABLE dolt_ignore(pattern TEXT NOT NULL, ignored TINYINT NOT NULL, PRIMARY KEY(pattern));
      INSERT INTO dolt_ignore VALUES('runtime_%',1),('sqlite_sequence',1);`);
    commit(db, ['items', 'dolt_ignore'], 'base');
    db.exec(`CREATE TABLE runtime_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
      CREATE INDEX runtime_jobs_label ON runtime_jobs(label);
      INSERT INTO runtime_jobs(label) VALUES('retained'),('deleted');
      DELETE FROM runtime_jobs WHERE id=2;`);
    const before = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='runtime_jobs'").get().seq;
    assert.equal(before, 2);
    db.doltReset('--hard');
    const retainedRows = db.prepare('SELECT * FROM runtime_jobs').all();
    assert.deepEqual(retainedRows, [{ id: 1, label: 'retained' }]);
    const sequenceExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get());
    let nextId = null;
    let allocationError = null;
    try { nextId = db.prepare("INSERT INTO runtime_jobs(label) VALUES('next') RETURNING id").get().id; }
    catch (error) { allocationError = String(error); }
    return { pass: sequenceExists && nextId > before, before, sequenceExists, nextId, allocationError, retainedRows };
  });
  check('wrapper-fast-forward', (db) => {
    db.exec(`CREATE TABLE engine_schema(singleton INTEGER PRIMARY KEY, version INTEGER, created_at INTEGER);
      INSERT INTO engine_schema VALUES(1,18,0);
      CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);
      INSERT INTO items VALUES(1,'base');`);
    commit(db, ['engine_schema', 'items'], 'base');
    const before = db.doltHashOf('HEAD');
    db.doltBranch('feature');
    db.doltCheckout('feature');
    db.exec("UPDATE items SET label='feature'");
    commit(db, ['items'], 'feature');
    const incoming = db.doltHashOf('HEAD');
    db.doltCheckout('main');
    assert.equal(db.doltHashOf('HEAD'), before);
    assert.notEqual(before, incoming);
    const result = mergeWithPolicy(db, 'feature');
    const after = db.doltHashOf('HEAD');
    assert.equal(after, incoming);
    assert.deepEqual(db.prepare('SELECT * FROM items').all(), [{ id: 1, label: 'feature' }]);
    return { pass: result.fastForward === true, headEqualsIncoming: after === incoming, fastForward: result.fastForward };
  });
  for (const result of checks) console.log(JSON.stringify(result));
  if (checks.some((result) => !result.pass)) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
