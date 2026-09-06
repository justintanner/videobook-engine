const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require(process.argv[2] || '@dolthub/doltlite');

const root = mkdtempSync(join(tmpdir(), 'doltlite-ignored-merge-'));
const db = new DatabaseSync(join(root, 'repro.db'));
const runtime = !process.argv.includes('--without-runtime');
const index = !process.argv.includes('--without-index');
try {
  db.exec(`
    CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO items VALUES(1, 'base');
    CREATE TABLE dolt_ignore(
      pattern TEXT NOT NULL, ignored TINYINT NOT NULL, PRIMARY KEY(pattern)
    );
    INSERT INTO dolt_ignore VALUES('runtime_%', 1);
  `);
  db.doltAdd('items');
  db.doltAdd('dolt_ignore');
  db.prepare("SELECT dolt_commit('-m', 'base')").get();
  if (runtime) {
    db.exec(`
      CREATE TABLE runtime_jobs(id INTEGER PRIMARY KEY, kind TEXT);
      INSERT INTO runtime_jobs VALUES(1, 'keep');
    `);
    if (index) db.exec('CREATE INDEX runtime_jobs_kind ON runtime_jobs(kind)');
  }
  db.doltBranch('feature');
  db.doltCheckout('feature');
  db.exec("UPDATE items SET label='feature'");
  db.doltAdd('items');
  db.prepare("SELECT dolt_commit('-m', 'feature')").get();
  db.doltCheckout('main');
  db.doltReset('--hard');
  console.log(JSON.stringify({ runtime, index, status: db.doltStatus() }));
  if (runtime) {
    assert.deepEqual(db.prepare('SELECT * FROM runtime_jobs').all(), [
      { id: 1, kind: 'keep' },
    ]);
  }
  db.doltMerge('feature');
  assert.deepEqual(db.prepare('SELECT * FROM items').all(), [
    { id: 1, label: 'feature' },
  ]);
  if (runtime) {
    assert.deepEqual(db.prepare('SELECT * FROM runtime_jobs').all(), [
      { id: 1, kind: 'keep' },
    ]);
  }
  console.log('PASS');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
