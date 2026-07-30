import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const indexerRoot = join(root, 'packages', 'indexer');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.ponder', 'generated', '.yarn'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// Static `from`/`export ... from` (also matches re-exports), require(...),
// dynamic import(...), and bare side-effect `import '...'` (no `from`) — the
// four ways a module specifier can appear in source.
const SDK_SPECIFIER_PATTERNS = [
  /from\s+['"]@jinn-network\/sdk(?:\/|['"])/,
  /require\(\s*['"]@jinn-network\/sdk(?:\/|['"])/,
  /\bimport\s*\(\s*['"]@jinn-network\/sdk(?:\/|['"])/,
  /\bimport\s+['"]@jinn-network\/sdk(?:\/|['"])/,
];

// #2296 step 1 (marketplace-surfaces design §7): the indexer's legacy-sdk
// edge is severed and must not return. Fail-by-omission: any import of the
// deprecated @jinn-network/sdk from indexer sources is a violation.
test('packages/indexer imports nothing from @jinn-network/sdk', () => {
  const offenders = [];
  for (const file of sourceFiles(indexerRoot)) {
    const text = readFileSync(file, 'utf8');
    if (SDK_SPECIFIER_PATTERNS.some((pattern) => pattern.test(text))) {
      offenders.push(file.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `legacy sdk imports: ${offenders.join(', ')}`);
});

test('packages/indexer package manifests declare no @jinn-network/sdk dependency', () => {
  const manifestPaths = [
    join(indexerRoot, 'package.json'),
    join(indexerRoot, 'explorer', 'package.json'),
  ];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const relativePath = manifestPath.slice(root.length + 1);
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      assert.equal(manifest[key]?.['@jinn-network/sdk'], undefined,
        `@jinn-network/sdk found in ${relativePath} ${key}`);
    }
  }
});
