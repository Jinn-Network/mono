/**
 * Fixture table for the no-fixed-test-port guard.
 *
 * `check-no-fixed-test-port.mjs` is a required CI gate on the operator lane, so
 * both of its failure modes are expensive: a false negative reads as coverage
 * it does not provide, and a false positive reddens unrelated PRs. Its rules
 * are seven regexes over source text, which is exactly the shape that a
 * fixture table pins and a reviewer does not. The cases below are the ones an
 * independent review of #1627 actually found — separators walking through
 * every port rule, and prose in `vitest.config.ts` reported as the pin it was
 * explaining — plus the behaviours the guard's header promises.
 *
 * Run: `node --test scripts/check-no-fixed-test-port.test.mjs` (from operator/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOW_MARKER,
  EPHEMERAL_MAX,
  EPHEMERAL_MIN,
  blankComments,
  inBand,
  portValue,
  scanText,
  scanVitestConfig,
} from './check-no-fixed-test-port.mjs';

/** Lines the guard flagged, so a fixture reads as its own assertion. */
const flagged = (src) => scanText(src).map((v) => v.line);

test('portValue normalises separators and rejects non-port shapes', () => {
  assert.equal(portValue('45000'), 45000);
  assert.equal(portValue('45_000'), 45000, 'a separator does not change the port');
  assert.equal(portValue('7331'), 7331);
  assert.equal(portValue('450000'), null, 'six digits is not a port literal');
  assert.equal(portValue('999'), null, 'three digits is not a port literal');
  assert.equal(portValue('45_'), null, 'a trailing separator is not a numeric literal');
  assert.equal(portValue('4__5000'), null, 'a doubled separator is not a numeric literal');
});

test('inBand covers the union of the Linux and macOS ephemeral ranges', () => {
  assert.equal(EPHEMERAL_MIN, 32768);
  assert.equal(EPHEMERAL_MAX, 65535);
  assert.ok(inBand('32768'), 'the Linux floor is in band');
  assert.ok(inBand('60999'), 'the Linux ceiling is in band');
  assert.ok(inBand('65535'), 'the macOS ceiling is in band — 61000-65535 is macOS-only');
  assert.ok(!inBand('32767'), 'one below the floor is out of band');
  assert.ok(!inBand('27331'), 'a registered sub-band reservation is out of band');
});

// The blocking finding: `\d{4,5}` cannot cross a `_`, and this repository
// writes 4- and 5-digit numbers separated on well over a thousand lines. One
// underscore walked through every rule below while the gate stayed green.
test('rule 1 catches a separated literal in every port position', () => {
  assert.deepEqual(flagged('const apiPort = 45_000;'), [1], 'rule 1c, separated');
  assert.deepEqual(flagged('const a = { apiPort: 45_001 };'), [1], 'rule 1b, separated');
  assert.deepEqual(flagged('srv.listen(45_004);'), [1], 'rule 1a, separated');
  assert.deepEqual(flagged('const b = { ports: [45_002, 45_003] };'), [1], 'rule 1d, separated');
});

test('rule 1 catches the same literals written plainly', () => {
  assert.deepEqual(flagged('const apiPort = 45000;'), [1]);
  assert.deepEqual(flagged('const a = { apiPort: 45001 };'), [1]);
  assert.deepEqual(flagged("srv.listen(45004, '127.0.0.1');"), [1]);
  assert.deepEqual(flagged('await isDailyDriverRunning({ ports: [60001, 60002] });'), [1]);
});

test('rule 1c catches the defaulted-constant form', () => {
  assert.deepEqual(flagged('const portBase = opts.portBase ?? 45007;'), [1]);
  assert.deepEqual(flagged('const apiPort = opts.apiPort || 45_008;'), [1]);
  assert.deepEqual(flagged('const portBase = opts.portBase ?? 7350;'), [], 'sub-band default is fine');
});

test('rule 1d reports every element of a multi-line port array', () => {
  const src = ['const opts = {', '  ports: [', '    60001,', '    60002,', '  ],', '};'].join('\n');
  assert.deepEqual(flagged(src), [3, 4]);
});

test('rule 2 catches a guessed port, by name, within the lookback', () => {
  assert.deepEqual(flagged('function pickPort() {\n  return 40000 + Math.floor(Math.random() * 20000);\n}'), [2]);
  assert.deepEqual(flagged('function pickColor() {\n  return Math.random();\n}'), [], 'not port-ish');
});

test('a sub-band literal in a port position is the sanctioned form, not a violation', () => {
  assert.deepEqual(flagged('const API_PORT = 27331;'), []);
  assert.deepEqual(flagged('await fs.writeFile(cfg, minimalCfg(7732));'), []);
  assert.deepEqual(flagged('const running = await isDailyDriverRunning({ ports: [9331, 9332] });'), []);
});

test('a port-ish name is matched at a boundary, never as a substring', () => {
  // A bare /port/i here would redden the gate across a viem codebase.
  for (const name of ['transport', 'support', 'importPath', 'report', 'exportedAt', 'portion']) {
    assert.deepEqual(flagged(`const ${name} = 45000;`), [], `${name} is not port-ish`);
  }
  for (const name of ['apiPort', 'portBase', 'API_PORT', 'httpPorts']) {
    assert.deepEqual(flagged(`const ${name} = 45000;`), [1], `${name} is port-ish`);
  }
});

test('a decimal is not a port literal', () => {
  assert.deepEqual(flagged('const ratio = { port: 1.32768 };'), [], 'the fraction is not the port');
  assert.deepEqual(flagged('srv.listen(45000.5);'), [], 'not an integer port literal');
});

test('a longer digit run is not sliced into a port', () => {
  assert.deepEqual(flagged('const apiPort = 450000;'), [], 'six digits is not in band');
  assert.deepEqual(flagged("const addr = { port: 0x4500033333 };"), []);
});

test('the allow marker suppresses its own line, including one array element', () => {
  assert.deepEqual(flagged(`const apiPort = 45000; // ${ALLOW_MARKER}`), []);
  const src = ['const o = {', '  ports: [', `    60001, // ${ALLOW_MARKER}`, '    60002,', '  ],', '};'].join('\n');
  assert.deepEqual(flagged(src), [4], 'the unmarked element still reports');
});

// The second blocking finding: vitest.config.ts is roughly half prose, and the
// natural way to record why `pool` and `maxWorkers` are left alone is a comment
// naming them. A raw line scan reported that comment as the pin it explained.
test('rule 3 does not fire on a comment that merely names a pin', () => {
  const src = [
    'export default defineConfig({',
    "  // We deliberately do NOT set pool: 'threads' — a worker thread's",
    '  // process.env.HOME write never reaches uv_os_homedir.',
    '  /* Nor maxWorkers: 1, which would triple wall-clock. */',
    '  test: { isolate: true },',
    '});',
  ].join('\n');
  assert.deepEqual(scanVitestConfig(src), []);
});

test('rule 3 fires on every real pin and isolation opt-out', () => {
  const cases = [
    'isolate: false,',
    'poolOptions: { forks: { singleFork: true } },',
    'poolOptions: { threads: { singleThread: true } },',
    'fileParallelism: false,',
    'maxWorkers: 1,',
    "maxWorkers: '1',",
    'poolOptions: { forks: { maxForks: 1, minForks: 1 } },',
    'maxConcurrency: 1,',
    "pool: 'forks',",
  ];
  for (const line of cases) {
    const found = scanVitestConfig(`export default defineConfig({ test: {\n  ${line}\n} });`);
    assert.ok(found.length > 0, `expected a rule-3 violation for: ${line}`);
    assert.equal(found[0].line, 2);
    assert.ok(found[0].why.length > 0, 'every pin explains itself in the failure output');
  }
});

test('rule 3 leaves an unpinned config alone', () => {
  const src = 'export default defineConfig({ test: { maxWorkers: 4, setupFiles: [] } });';
  assert.deepEqual(scanVitestConfig(src), []);
});

test('blankComments preserves offsets and leaves string contents intact', () => {
  const src = "const a = 1; // pool: 'threads'\nconst b = '// not a comment';\n";
  const out = blankComments(src);
  assert.equal(out.length, src.length, 'byte offsets are preserved');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers are preserved');
  assert.ok(!out.includes('threads'), 'the comment is blanked');
  assert.ok(out.includes('// not a comment'), 'a string is not a comment');
});

// These are the gaps the guard's header names explicitly. Pinning them keeps
// the header honest: closing one should be a deliberate edit here, not a
// silent change of scope.
test('documented non-catches stay documented', () => {
  assert.deepEqual(flagged("await fetch('http://127.0.0.1:45020/health');"), [], 'URL string');
  assert.deepEqual(flagged('apiPort = 45000;'), [], 'bare reassignment');
  assert.deepEqual(flagged("const o = { ports: [']', 45004] };"), [], "a ] inside a string");
});
