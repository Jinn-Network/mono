// The repository-wide spawn-site temp-directory scan (#3098), and the scan's own regression
// coverage (#3097, #3099).
//
// A child handed an explicit `env:` allowlist that names no temp directory falls back to the
// platform default and writes outside the root its parent was confined to — the same class of leak
// `vitest-tmp-isolation.test.mjs` holds for test suites, one layer down at the spawn site. The
// check began inside `packages/benchmark-product/core` and could only see that package's `src`, so
// a launch plan added in `packages/task-execution` was covered by two point assertions and nothing
// else. It lives here instead of being copied per package because the heuristics are subtle enough
// that two copies would drift, and because a repository-wide gate is what this directory is for.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { scanRoots, sourceFiles, unhandledSites } from './child-temp-env-scan.mjs';

const root = resolve(import.meta.dirname, '../..');

/**
 * Source roots the scan governs, discovered by directory existence so a package that moves or
 * arrives does not silently drop out of coverage. `benchmark-product/core` is where the scan began;
 * the `task-execution` trees are the ones it could not previously see.
 */
const ROOTS = [
  'packages/benchmark-product/core/src',
  'packages/task-execution/backend/src',
  'packages/task-execution/backend-local/assembly/src',
  'packages/task-execution/backend-local/launchers/src',
  'packages/task-execution/backend-local/supervisor/src',
  'packages/task-execution/backend-local/workspace/src',
  'packages/task-execution/evaluation-harness/src',
  'packages/task-execution/evaluator-adapters/src',
  'packages/task-execution/oci-grader/src',
  'packages/task-execution/profiles/src',
  'packages/task-execution/protocol/src',
  'packages/task-execution/testing/src',
].map((path) => join(root, path)).filter((path) => existsSync(path));

/** Floor on the real-tree walk: a `sourceFiles` regression must fail loud, not pass over nothing. */
const MIN_SCANNED_FILES = 250;

const SITE = 'const built = build();\nspawn(exe, args, { env: { ...built, HOME: home } });\n';

test('reads what a spread resolves to rather than accepting the spread itself', () => {
  const carrier = 'function build() { return { ...scopedTempEnv(root), PATH: "" }; }\n';
  const bare = 'function build() { return { PATH: "" }; }\n';
  assert.deepEqual(unhandledSites(carrier + SITE), []);
  assert.equal(unhandledSites(bare + SITE).length, 1);
});

test('does not read prose about a temp variable as proof one is set', () => {
  const bare = 'function build() { return { PATH: "" }; }\n';
  assert.equal(unhandledSites(`// Sets TMPDIR.\n${bare}${SITE}`).length, 1);
  assert.equal(unhandledSites(`/** Sets TMPDIR. */\n${bare}${SITE}`).length, 1);
});

test('does not let a site borrow proof it did not earn', () => {
  const neighbour = 'function build() { return { PATH: "" }; }\nfunction other() { return scopedTempEnv(d); }\n';
  assert.equal(unhandledSites(neighbour + SITE).length, 1);
  assert.equal(unhandledSites('spawn(exe, args, { env: { HOME: home, KEY: tokenFor(k) } });\n').length, 1);
});

// #3097 (1): the boundary that ends a definition's window used to match only at column zero, so an
// indented delegate ran to the next top-level declaration. Every unrelated call in the enclosing
// function then supplied the carriage — including, at `agent/login.ts`, the whole `try` block the
// scan exists to protect.
test('bounds a nested definition at its own statement, not its enclosing function', () => {
  const source = [
    'function buildEnv() { return { PATH: "" }; }',
    'function scratchDir(d) { return scopedTempEnv(d); }',
    'export function run(root) {',
    '  const env = buildEnv();',
    '  const scratch = scratchDir(root);',
    '  spawn(exe, args, { env: { ...env, HOME: home } });',
    '}',
    '',
  ].join('\n');
  assert.equal(unhandledSites(source).length, 1);
});

// #3097 (2): the name used to resolve to the first matching declaration in the whole file, so a
// later same-named local borrowed an earlier one's proof.
test('resolves a delegated name to the nearest preceding definition', () => {
  const source = [
    'export function pinned(d) {',
    '  const built = scopedTempEnv(d);',
    '  spawn(exe, args, { env: { ...built } });',
    '}',
    'export function bare() {',
    '  const built = { PATH: "" };',
    '  spawn(exe, args, { env: { ...built, HOME: home } });',
    '}',
    '',
  ].join('\n');
  assert.equal(unhandledSites(source).length, 1);
});

// #3097 (3): a `class` between two helpers was not a boundary, so the earlier helper's window
// spilled into a method that does carry.
test('treats a class declaration as a definition boundary', () => {
  const source = [
    'function build() { return { PATH: "" }; }',
    'class Scratch {',
    '  dir(d) { return scopedTempEnv(d); }',
    '}',
    SITE,
  ].join('\n');
  assert.equal(unhandledSites(source).length, 1);
});

// #3099: the marker gathered the comment lines within 8 lines above the site without requiring them
// to be contiguous with it, so a marker written about one thing exempted anything just below it.
test('accepts a temp-env: marker only when it is contiguous with the site', () => {
  const preamble = 'function build() { return { PATH: "" }; }\n';
  const marker = '// temp-env: this other spawn deliberately inherits nothing.\n';
  const attached = `${preamble}${marker}spawn(exe, args, { env: { HOME: home } });\n`;
  const detached = `${preamble}${marker}const a = 1;\nconst b = 2;\nspawn(exe, args, { env: { HOME: home } });\n`;
  assert.deepEqual(unhandledSites(attached), []);
  assert.equal(unhandledSites(detached).length, 1);
});

// A cast is how `process.env` is spread in TypeScript that types the result; reading only the bare
// spelling reported the supervisor's own shim spawn as an omission.
test('reads a cast process.env spread as carriage', () => {
  const source = 'spawn(exe, args, { env: { ...(process.env as Record<string, string>), HOME: home } });\n';
  assert.deepEqual(unhandledSites(source), []);
});

// Delegation across a relative import: a launcher builds its allowlist in one documented helper in
// a sibling module, which is the shape the scan must follow rather than force inlined per call.
test('follows a delegated name through a relative import', () => {
  const directory = mkdtempSync(join(tmpdir(), 'child-temp-env-'));
  try {
    writeFileSync(join(directory, 'planning.ts'),
      'export function baseEnv(paths) { return { ...scopedTempEnv(paths.tmp) }; }\n');
    writeFileSync(join(directory, 'bare.ts'), 'export function baseEnv(paths) { return { PATH: "" }; }\n');
    const site = (module) =>
      `import { baseEnv } from "./${module}.js";\nspawn(exe, args, { env: { ...baseEnv(paths), HOME: home } });\n`;
    const carrier = join(directory, 'carrier.ts');
    const bare = join(directory, 'omission.ts');
    writeFileSync(carrier, site('planning'));
    writeFileSync(bare, site('bare'));
    assert.deepEqual(unhandledSites(readFileSync(carrier, 'utf8'), carrier), []);
    assert.equal(unhandledSites(readFileSync(bare, 'utf8'), bare).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('names the temp variables at every spawn site in the repository, or says why not', () => {
  const scanned = ROOTS.flatMap((directory) => sourceFiles(directory));
  assert.ok(
    scanned.length >= MIN_SCANNED_FILES,
    `the scan visited ${scanned.length} files, below the ${MIN_SCANNED_FILES} floor — did a source root move?`,
  );
  const unhandled = scanRoots(ROOTS).map((site) => relative(root, site));
  assert.deepEqual(
    unhandled,
    [],
    'spawn sites whose env allowlist names no temp directory and gives no reason:\n' +
      `  ${unhandled.join('\n  ')}\n` +
      'Spread inheritedTempEnv() (child writes where the caller writes), spread scopedTempEnv(dir) ' +
      '(child is pinned at dir), or say inline why the child must not inherit them.',
  );
});
