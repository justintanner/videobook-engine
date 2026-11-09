import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// Does Engine.close() release the catalog's files before it returns? Exits 1
// while the installed DoltLite binding keeps them open until the garbage
// collector finalizes the last statement (dolthub/doltlite-node#11; see
// patches/doltlite-node/deterministic-close.md). Never mutates the package.
// Usage: npm run build, then node scripts/close-handle-probe.mjs [repository]
const repository = resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(join(repository, 'package.json'));
const { version } = require('@dolthub/doltlite/package.json');
const addon = join(
  require.resolve('@dolthub/doltlite/package.json'), '..',
  'prebuilds', `${process.platform}-${process.arch}`, 'doltlite.node',
);
const addonSha256 = existsSync(addon)
  ? createHash('sha256').update(readFileSync(addon)).digest('hex')
  : null;
const { createEngine } = await import(pathToFileURL(join(repository, 'dist/index.js')));
console.log(JSON.stringify({
  package: '@dolthub/doltlite', version, addonSha256,
  node: process.version, platform: process.platform, arch: process.arch,
}));

setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc');
setFlagsFromString('--no-expose-gc');

/**
 * Paths under `directory` that this process holds open, or null where they
 * cannot be listed. On Windows, the failed deletion below is the evidence.
 */
function openFilesUnder(directory) {
  let paths;
  if (process.platform === 'linux') {
    paths = [];
    for (const fd of readdirSync('/proc/self/fd')) {
      try {
        paths.push(readlinkSync(join('/proc/self/fd', fd)));
      } catch { /* The descriptor closed while listing. */ }
    }
  } else if (process.platform === 'darwin') {
    const listing = execFileSync('lsof', ['-n', '-P', '-p', String(process.pid), '-Fn'], {
      encoding: 'utf8',
    });
    paths = listing.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  } else {
    return null;
  }
  return paths
    .filter((target) => target.startsWith(directory + sep))
    .map((target) => target.slice(directory.length + 1))
    .sort();
}

/**
 * Removes what is in the directory but not the directory itself, so that a
 * late native close could still create a file there and be noticed.
 */
function emptyDirectory(directory) {
  try {
    for (const name of readdirSync(directory)) {
      rmSync(join(directory, name), { recursive: true });
    }
    return 'emptied';
  } catch (error) {
    return String(error.code ?? error);
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'videobook-close-handles-')));
let pass = false;
try {
  const engine = createEngine({ rootDir: root, initialBookName: 'probe' });
  const created = await engine.artifacts.create({ kind: 'script', label: 'draft' });
  if (!created.ok) throw new Error(created.error.message);
  const written = await engine.files.write(created.value.artifactId, 'draft.md', '# Draft');
  if (!written.ok) throw new Error(written.error.message);
  const manifest = await engine.files.manifest(created.value.artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const openBeforeClose = openFilesUnder(root);
  engine.close();
  const openAfterClose = openFilesUnder(root);
  // Windows refuses to delete a file that is still open.
  const emptyAfterClose = emptyDirectory(root);
  for (let round = 0; round < 3; round += 1) {
    collectGarbage();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const openAfterGc = openFilesUnder(root);
  // Close-marker safety: the deferred native close must not write afterwards.
  const leftAfterGc = readdirSync(root, { recursive: true }).sort();
  pass = emptyAfterClose === 'emptied'
    && (openAfterClose === null || openAfterClose.length === 0)
    && leftAfterGc.length === 0;
  console.log(JSON.stringify({
    pass, openBeforeClose, openAfterClose, emptyAfterClose, openAfterGc, leftAfterGc,
  }, null, 2));
} finally {
  // Windows: whatever is still open is released by the collections above.
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(pass ? 0 : 1);
