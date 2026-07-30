import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const indexerRoot = join(root, 'packages', 'indexer');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.ponder', 'generated'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// #2296 step 1 (marketplace-surfaces design §7): the indexer's legacy-sdk
// edge is severed and must not return. Fail-by-omission: any import of the
// deprecated @jinn-network/sdk from indexer sources is a violation.
test('packages/indexer imports nothing from @jinn-network/sdk', () => {
  const offenders = [];
  for (const file of sourceFiles(indexerRoot)) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"]@jinn-network\/sdk(?:\/|['"])/.test(text) ||
        /require\(\s*['"]@jinn-network\/sdk(?:\/|['"])/.test(text)) {
      offenders.push(file.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `legacy sdk imports: ${offenders.join(', ')}`);
});

test('packages/indexer/package.json declares no @jinn-network/sdk dependency', () => {
  const manifest = JSON.parse(readFileSync(join(indexerRoot, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.equal(manifest[key]?.['@jinn-network/sdk'], undefined,
      `@jinn-network/sdk found in ${key}`);
  }
});
