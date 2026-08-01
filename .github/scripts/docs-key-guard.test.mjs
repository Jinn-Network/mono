import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// Docs guard (marketplace-surfaces design §8.3): no raw private keys in any
// documentation or example. The allowlist is the standard Anvil/Hardhat dev
// account key SET — accounts #0-#9 derived from the well-known
// "test test test test test test test test test test test junk" mnemonic
// (verbatim from `anvil`'s own startup output; also in
// client/test/acceptance/_fixtures/anvil.ts:38-43 for accounts #0-#4). Every
// one of these ten keys is as burned and public as account #0 alone.
const ANVIL_DEV_KEYS = new Set([
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // #0
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // #1
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // #2
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // #3
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // #4
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // #5
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e', // #6
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356', // #7
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97', // #8
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6', // #9
]);
// 64-hex literals alone are tx hashes and digests everywhere; only flag
// them in key-shaped contexts. The first pattern is case-insensitive so it
// also catches camelCase `privateKey:` in TS/JS snippets, not just the
// SCREAMING_CASE env-var form.
const KEY_CONTEXTS = [
  /(?:private[-_ ]?key|PRIVATE_KEY)\s*[=: ]\s*["'`]?(0x[0-9a-fA-F]{64})/gi,
  /privateKeyToAccount\(\s*["'`](0x[0-9a-fA-F]{64})/g,
  /--private-key\s+["'`]?(0x[0-9a-fA-F]{64})/g,
];
const SCAN_ROOTS = ['docs', 'examples', 'spec', 'client/README.md', 'README.md', 'CLAUDE.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function markdownAndExampleFiles(path, out = []) {
  if (!statSync(path, { throwIfNoEntry: false })) return out;
  if (statSync(path).isFile()) { out.push(path); return out; }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(path, entry);
    if (statSync(full).isDirectory()) markdownAndExampleFiles(full, out);
    else if (/\.(md|mdx|ts|js|mjs|sh|json)$/.test(entry)) out.push(full);
  }
  return out;
}

function scan(paths) {
  const violations = [];
  for (const file of paths) {
    const text = readFileSync(file, 'utf8');
    for (const context of KEY_CONTEXTS) {
      for (const match of text.matchAll(context)) {
        if (!ANVIL_DEV_KEYS.has(match[1].toLowerCase())) {
          violations.push(
            `${file.slice(root.length + 1) || file}: ${match[1].slice(0, 12)}… — ` +
              'raw private keys are never allowlisted; if this is one of the standard ' +
              'burned Anvil dev keys, add it to ANVIL_DEV_KEYS in this script — otherwise ' +
              'replace the literal in the doc',
          );
        }
      }
    }
  }
  return violations;
}

test('docs and examples carry no raw private keys beyond the Anvil dev key set', () => {
  const files = SCAN_ROOTS.flatMap((p) => markdownAndExampleFiles(join(root, p)));
  assert.ok(files.length > 0, 'scan roots resolved no files — check paths');
  assert.deepEqual(scan(files), []);
});

test('self-test: a non-Anvil key in key context is flagged; Anvil accounts #0 and #1 are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-key-guard-'));
  try {
    const bad = join(dir, 'bad.md');
    const syntheticKey = `0x${'1'.repeat(64)}`;
    writeFileSync(bad,
      `PRIVATE_KEY=${syntheticKey}\n` +
      'cast send --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 ...\n' +
      'cast send --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d ...\n');
    const violations = scan([bad]);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes(syntheticKey.slice(0, 12)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
