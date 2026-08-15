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
// API shape. It discovers exactly these two named future trees (venue-base,
// work-client) by directory existence — not arbitrary new packages — so
// the daemon-cutover and work-client sessions inherit coverage without
// editing this list.
const CUSTODY_SET = ['binding', 'pipeline', 'venue-base', 'work-client']
  .map((d) => join(root, 'packages', 'marketplace', d))
  .filter((d) => existsSync(d));
// Floor on how many files the real-tree scan visits: if a future tree moves
// its sources out of `src/` (or `sourceFiles` regresses to skip everything),
// the scan would silently pass zero files instead of failing loud.
const MIN_SCANNED_FILES = 20;

// Durable-state exemptions (C2 is about ambient AUTHORITY acquisition, not
// about persistence). A module qualifies only when it: persists operational
// state under a path its caller supplies, reads no credential/keystore/env,
// and holds no key material. Each entry is dated and justified; a module
// added here must be re-justified, never assumed. Anything that acquires
// signing authority from disk belongs in the violation list, not here.
const DURABLE_STATE_EXEMPT = new Map([
  [
    'packages/marketplace/binding/src/posting-intent-file-store.ts',
    // 2026-08-04: the transactional-outbox intent store (marketplace binding
    // design §7.4). Writes posting intents under a caller-supplied directory;
    // verified to contain no privateKey/mnemonic/keystore/process.env/signer
    // reference of any kind. Filesystem use here is persistence, not authority.
    'filesystem import',
  ],
]);

// C2: no ambient authority acquisition — no env, no filesystem, no
// process spawning, no keystore reads inside package sources.
const AMBIENT_PATTERNS = [
  [/process\.env/, 'process.env access'],
  [/from\s+['"](?:node:)?fs(?:\/promises)?['"]/, 'filesystem import'],
  [/from\s+['"](?:node:)?child_process['"]/, 'child_process import'],
  [/require\(\s*['"](?:node:)?(?:fs(?:\/promises)?|child_process)['"]\s*\)/, 'fs/child_process require'],
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
  let scannedFiles = 0;
  for (const dir of dirs) {
    const src = join(dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      scannedFiles += 1;
      const text = readFileSync(file, 'utf8');
      const relative = file.slice(root.length + 1);
      const exemptLabel = DURABLE_STATE_EXEMPT.get(relative);
      for (const [pattern, label] of [...AMBIENT_PATTERNS, ...KEY_PATTERNS]) {
        if (!pattern.test(text)) continue;
        // An exemption covers exactly one label on exactly one file: a
        // durable-state module that later acquires authority still fails.
        if (label === exemptLabel) continue;
        violations.push(`${relative}: ${label}`);
      }
    }
  }
  return { violations, scannedFiles };
}

test('every durable-state exemption still names a file that exists and still trips its pattern', () => {
  // A stale exemption is worse than no exemption: it silently pre-approves a
  // path that may later be recreated by different code. If the file is gone,
  // or no longer trips the label it was exempted for, delete the entry.
  for (const [relative, label] of DURABLE_STATE_EXEMPT) {
    const full = join(root, relative);
    assert.ok(existsSync(full), `stale custody exemption — file no longer exists: ${relative}`);
    const text = readFileSync(full, 'utf8');
    const pattern = [...AMBIENT_PATTERNS, ...KEY_PATTERNS].find(([, l]) => l === label)?.[0];
    assert.ok(pattern, `exemption names an unknown label: ${label}`);
    assert.ok(
      pattern.test(text),
      `stale custody exemption — ${relative} no longer trips "${label}"; remove the entry`,
    );
  }
});

test('custody set has no ambient authority or key-material surface', () => {
  assert.ok(CUSTODY_SET.length >= 2, 'custody set unexpectedly empty — check paths');
  const { violations, scannedFiles } = scan(CUSTODY_SET);
  assert.deepEqual(violations, []);
  assert.ok(
    scannedFiles >= MIN_SCANNED_FILES,
    `expected at least ${MIN_SCANNED_FILES} source files scanned, got ${scannedFiles} — ` +
      'a future tree may have moved sources out of src/',
  );
});

test('self-test: the scanner flags a node:fs/promises import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'custody-guard-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'bad-promises.ts'),
      "import { readFile } from 'node:fs/promises';\n" +
        'export async function poster() {\n' +
        "  return readFile('x', 'utf8');\n" +
        '}\n',
    );
    const { violations } = scan([dir]);
    assert.ok(
      violations.some((v) => v.includes('filesystem import')),
      `expected a filesystem-import violation for node:fs/promises, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const { violations } = scan([dir]);
    assert.ok(violations.some((v) => v.includes('filesystem import')));
    assert.ok(violations.some((v) => v.includes('process.env')));
    assert.ok(violations.some((v) => v.includes('key-material parameter')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
