import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// Docs guard (marketplace-surfaces design §8.3): no raw private keys in any
// documentation or example. The single allowlisted literal is the
// well-known Anvil dev key — the one string every reader knows is burned.
const ANVIL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// 64-hex literals alone are tx hashes and digests everywhere; only flag
// them in key-shaped contexts.
const KEY_CONTEXTS = [
  /(?:private[-_ ]?key|PRIVATE_KEY)\s*[=: ]\s*["'`]?(0x[0-9a-fA-F]{64})/g,
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
        if (match[1].toLowerCase() !== ANVIL_DEV_KEY) {
          violations.push(`${file.slice(root.length + 1) || file}: ${match[1].slice(0, 12)}…`);
        }
      }
    }
  }
  return violations;
}

test('docs and examples carry no raw private keys beyond the Anvil dev key', () => {
  const files = SCAN_ROOTS.flatMap((p) => markdownAndExampleFiles(join(root, p)));
  assert.ok(files.length > 0, 'scan roots resolved no files — check paths');
  assert.deepEqual(scan(files), []);
});

test('self-test: a non-Anvil key in key context is flagged; the Anvil key is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-key-guard-'));
  try {
    const bad = join(dir, 'bad.md');
    writeFileSync(bad,
      'PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d\n' +
      `cast send --private-key ${ANVIL_DEV_KEY} ...\n`);
    const violations = scan([bad]);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('0x59c6995e99'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
