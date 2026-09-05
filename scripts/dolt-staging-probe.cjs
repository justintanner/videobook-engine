const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require(process.argv[2] || '@dolthub/doltlite');
const root = mkdtempSync(join(tmpdir(), 'doltlite-stage-index-'));
const db = new DatabaseSync(join(root, 'repro.db'));
const tables = Array.from({ length: 12 }, (_, i) => `items_${i}`);
try {
  for (const table of tables) {
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, label TEXT UNIQUE);
      INSERT INTO ${table} VALUES ('base', 'unique-label');`);
  }
  if (process.argv.includes('--stage-all')) db.doltAdd();
  else for (const table of tables) db.doltAdd(table);
  db.prepare("SELECT dolt_commit('-m', 'initial', '--author', 'Test <test@example.test>')").get();
  for (const table of tables) {
    assert.equal(db.prepare(`SELECT id FROM ${table} WHERE label='unique-label'`).get()?.id, 'base');
  }
  db.doltBranch('feature');
  db.doltCheckout('feature');
  for (const table of tables) {
    assert.equal(db.prepare(`SELECT id FROM ${table} WHERE label='unique-label'`).get()?.id, 'base');
  }
  console.log('PASS');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
