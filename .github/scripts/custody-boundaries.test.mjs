import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// The custody law's tripwire (marketplace-surfaces design §4.1 C2/C3),
// scoped to the signer-accepting marketplace packages — NOT the whole
// stack (the evidence repository uses node:fs by design). This guard is a
// tripwire, not the control; the control is review plus signer-object-only
// API shape. Future trees (venue-base, work-client) are picked up by
// existence, so new signer-accepting packages inherit coverage.
const CUSTODY_SET = ['binding', 'pipeline', 'venue-base', 'work-client']
  .map((d) => join(root, 'packages', 'marketplace', d))
  .filter((d) => existsSync(d));

// C2: no ambient authority acquisition — no env, no filesystem, no
// process spawning, no keystore reads inside package sources.
const AMBIENT_PATTERNS = [
  [/process\.env/, 'process.env access'],
  [/from\s+['"](?:node:)?fs['"]/, 'filesystem import'],
  [/from\s+['"](?:node:)?child_process['"]/, 'child_process import'],
  [/require\(\s*['"](?:node:)?(?:fs|child_process)['"]\s*\)/, 'fs/child_process require'],
];
// C3: signer objects only — key-construction helpers and key-material
// parameter names are refused in any position, source or public type.
const KEY_PATTERNS = [
  [/privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey/, 'key-construction helper'],
  [/\b(?:privateKey|mnemonic|seedPhrase)\s*[:?]/i, 'key-material parameter or property'],
];

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test', 'fixtures'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mts)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

function scan(dirs) {
  const violations = [];
  for (const dir of dirs) {
    const src = join(dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of [...AMBIENT_PATTERNS, ...KEY_PATTERNS]) {
        if (pattern.test(text)) violations.push(`${file.slice(root.length + 1)}: ${label}`);
      }
    }
  }
  return violations;
}

test('custody set has no ambient authority or key-material surface', () => {
  assert.ok(CUSTODY_SET.length >= 2, 'custody set unexpectedly empty — check paths');
  assert.deepEqual(scan(CUSTODY_SET), []);
});

test('self-test: the scanner flags a violating fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'custody-guard-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'bad.ts'),
      "import { readFileSync } from 'node:fs';\n" +
        "export function poster(opts: { privateKey: string }) {\n" +
        '  return readFileSync(process.env.KEYSTORE_PATH ?? "", "utf8") + opts.privateKey;\n' +
        '}\n',
    );
    const violations = scan([dir]);
    assert.ok(violations.some((v) => v.includes('filesystem import')));
    assert.ok(violations.some((v) => v.includes('process.env')));
    assert.ok(violations.some((v) => v.includes('key-material parameter')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
