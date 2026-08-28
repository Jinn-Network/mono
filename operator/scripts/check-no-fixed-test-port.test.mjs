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

// A TS type annotation breaks the name-to-`=` adjacency rule 1c relied on, and
// it is ordinary TypeScript in a `.ts` test file.
test('rule 1c sees through a type annotation', () => {
  assert.deepEqual(flagged('const apiPort: number = 45000;'), [1]);
  assert.deepEqual(flagged('const apiPort: number = 45_000;'), [1]);
  assert.deepEqual(flagged('const apiPort: number = opts.apiPort ?? 45000;'), [1]);
  assert.deepEqual(flagged('const apiPort: number = 7331;'), [], 'sub-band is still fine');
  assert.deepEqual(flagged('const makePort: () => number = () => 45000;'), [], 'not a binding');
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

// The port-key list was closed, so `{ daemonPort: 45000 }` and
// `{ gammaPort: 45001 }` passed while `const gammaPort = 45001` fired — same
// name, same value, opposite verdicts. Both keys carry a real child-process
// bind in scripts/release/.
test('rule 1b filters the key by name, not by an enumerated list', () => {
  for (const key of ['daemonPort', 'gammaPort', 'rpcPort', 'apiPort', 'portBase', 'ports']) {
    assert.deepEqual(flagged(`const o = { ${key}: 45000 };`), [1], `${key} is port-ish`);
  }
  for (const key of ['transport', 'support', 'report', 'portal', 'importedAt']) {
    assert.deepEqual(flagged(`const o = { ${key}: 45000 };`), [], `${key} is not port-ish`);
  }
  assert.deepEqual(flagged('const o = { daemonPorts: [45000, 45001] };'), [1], 'rule 1d too');
  assert.deepEqual(flagged('const o = { transports: [45000, 45001] };'), [], 'rule 1d, not port-ish');
});

// Rules 1 and 2 scanned raw text, so prose about the band was reported as the
// violation it was describing — a false positive on a required gate, and the
// runbook this guard ships with teaches contributors to write exactly that
// prose. Rule 1d's unbounded capture made it worse: an unclosed `[` in a
// comment swallowed the rest of the file.
test('rules 1 and 2 do not read comments or strings as code', () => {
  assert.deepEqual(flagged('// we used to write ports: [45000, 45001] here'), []);
  assert.deepEqual(flagged('// const apiPort = 45000; // removed'), []);
  assert.deepEqual(flagged('/* srv.listen(45000) was the old form */'), []);
  assert.deepEqual(flagged("const yaml = 'ports: [45000]';"), []);
  assert.deepEqual(flagged('const doc = `ports: [45000]`;'), [], 'template literal too');
  assert.deepEqual(
    flagged(['// reserved ports: [', 'const timeoutMs = 45000;', 'const other = 60000;'].join('\n')),
    [],
    'an unclosed [ in prose cannot swallow the rest of the file',
  );
  assert.deepEqual(
    flagged(['const apiPort = 45000; // ports: [60001]', 'const b = 1;'].join('\n')),
    [1],
    'the code on a line carrying a comment is still scanned',
  );
  assert.deepEqual(
    flagged("function pickPort() {\n  // Math.random() is what this used to do\n  return 1;\n}"),
    [],
    'rule 2 does not fire on a comment either',
  );
});

test('blankComments with strings blanks contents and keeps the quotes', () => {
  const src = "const a = 'ports: [45000]';\n";
  const out = blankComments(src, { strings: true });
  assert.equal(out.length, src.length, 'byte offsets are preserved');
  assert.ok(!out.includes('45000'), 'the string contents are blanked');
  assert.equal(out.indexOf("'"), src.indexOf("'"), 'the opening quote survives in place');
  assert.equal(out.lastIndexOf("'"), src.lastIndexOf("'"), 'and so does the closing one');
  assert.ok(blankComments(src).includes('45000'), 'the default still leaves strings intact');
});

test('rule 2 catches a guessed port, by name, within the lookback', () => {
  assert.deepEqual(flagged('function pickPort() {\n  return 40000 + Math.floor(Math.random() * 20000);\n}'), [2]);
  assert.deepEqual(flagged('function pickColor() {\n  return Math.random();\n}'), [], 'not port-ish');
  // The failure text advertises "randomly guessed"; a better RNG is the same guess.
  assert.deepEqual(flagged('function pickPort() {\n  return randomInt(40000, 60000);\n}'), [2]);
  assert.deepEqual(flagged('const apiPort = crypto.randomInt(40000, 60000);'), [1]);
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

// A code-POINT split would run one slot short of a code-UNIT index here, blank
// past the end of the comment, eat the newline, and shift rule 3's line
// numbers — or chew the first character of a real pin and miss it outright.
test('blankComments stays aligned across a surrogate pair', () => {
  const src = "const e = '\u{1F600}';\n// pool: 'threads'\nisolate: false,\n";
  const out = blankComments(src);
  assert.equal(out.length, src.length, 'code-unit offsets are preserved');
  assert.equal(out.split('\n').length, src.split('\n').length, 'line numbers are preserved');
  assert.ok(!out.includes('threads'), 'the comment is fully blanked');
  const found = scanVitestConfig(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3, 'the real pin is still reported on its own line');
});

// The marker only ever lives inside a comment, and rule 3 matches against
// blanked text — so it has to be read off the raw line or the hatch is dead.
test('the allow marker suppresses a rule-3 pin, and reports the raw line', () => {
  const marked = `export default { test: {\n  maxWorkers: 1, // ${ALLOW_MARKER}\n} };`;
  assert.deepEqual(scanVitestConfig(marked), []);
  const unmarked = 'export default { test: {\n  maxWorkers: 1, // deliberate\n} };';
  const found = scanVitestConfig(unmarked);
  assert.equal(found.length, 1);
  assert.equal(found[0].snippet, 'maxWorkers: 1, // deliberate', 'the reader sees the real line');
});

// These are the gaps the guard's header names explicitly. Pinning them keeps
// the header honest: closing one should be a deliberate edit here, not a
// silent change of scope.
test('documented non-catches stay documented', () => {
  assert.deepEqual(flagged("await fetch('http://127.0.0.1:45020/health');"), [], 'URL string');
  assert.deepEqual(flagged('apiPort = 45000;'), [], 'bare reassignment');
  const nested = ['const o = {', '  ports: [', '    [45004],', '    45005,', '  ],', '};'].join('\n');
  assert.deepEqual(flagged(nested), [3], 'rule 1d stops at the first ], so row 4 is the gap');
  assert.deepEqual(
    flagged(`const o = { ports: [${'0, '.repeat(200)}45004] };`),
    [],
    'an array longer than the 400-char bound is not captured',
  );
  assert.deepEqual(flagged('const apiPort = cond ? x : 45000;'), [], 'ternary default');
  assert.deepEqual(flagged("const o = { 'port': 45000 };"), [], 'quoted key');
  assert.deepEqual(scanVitestConfig('test: { maxWorkers: 1.0 }'), [], 'non-integer pin');
  assert.deepEqual(
    scanVitestConfig('test: { maxWorkers: process.env.CI ? 1 : 4 }'),
    [],
    'computed pin',
  );
  assert.deepEqual(flagged('const o = { apiPort: BASE + 45000 };'), [], 'literal does not lead');
  assert.deepEqual(flagged('listen(45000);'), [], 'no receiver dot');
  assert.deepEqual(flagged('const { apiPort = 45000 } = opts;'), [], 'destructured');
  assert.deepEqual(
    scanVitestConfig('exclude: [/a\\/\\//], isolate: false,'),
    [],
    'a regex literal containing / blanks the rest of its line',
  );
  // The order-flipped form DOES fire, which is what makes the one above a gap
  // rather than a policy.
  assert.deepEqual(flagged('const o = { apiPort: 45000 + BASE };'), [1]);
});
