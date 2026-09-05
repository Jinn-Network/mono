/**
 * Fixture table for the no-fixed-test-port guard.
 *
 * `check-no-fixed-test-port.mjs` is a required CI gate on the operator lane, so
 * both of its failure modes are expensive: a false negative reads as coverage
 * it does not provide, and a false positive reddens unrelated PRs. Its rules
 * are a stack of regexes over source text, which is exactly the shape that a
 * fixture table pins and a reviewer does not. The cases below are the ones an
 * independent review of #1627 actually found — separators walking through
 * every port rule, and prose in `vitest.config.ts` reported as the pin it was
 * explaining — plus the behaviours the guard's header promises.
 *
 * The traversal and the failure-mode plumbing (`walk`, `scanRoots`, the bail
 * paths and the exit codes) are driven over throwaway directory trees, never
 * over the real one: those paths carry the guard's central safety claim — that
 * it fails loudly rather than passing vacuously when its subject is missing —
 * and a refactor turning one of them into a silent pass would otherwise leave
 * both the required gate and this table green.
 *
 * Run: `node --test scripts/check-no-fixed-test-port.test.mjs` (from operator/).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ALLOW_MARKER,
  EPHEMERAL_MAX,
  EPHEMERAL_MIN,
  blankComments,
  inBand,
  portValue,
  runGuard,
  scanRoots,
  scanText,
  scanVitestConfig,
  walk,
} from './check-no-fixed-test-port.mjs';

/** Lines the guard flagged, so a fixture reads as its own assertion. */
const flagged = (src) => scanText(src).map((v) => v.line);

/**
 * A throwaway directory tree, removed when the case ends. Keys are
 * root-relative paths; a key with no `/` and file content makes a plain file,
 * so a case can put something that is NOT a directory where a scan root is
 * expected.
 */
function makeTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'no-fixed-test-port-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

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

// A regex literal IS tracked now, so a `'` or `"` inside one no longer opens a
// "string" the machine never sees closed. The newline bound on the `'` and `"`
// states stays as the backstop for whatever the regex heuristic misreads:
// without it, the classification stays inverted -- real code blanked and never
// scanned, string contents scanned as code -- until the next matching quote
// anywhere in the file.
test('a quote inside a regex literal desyncs at most its own line', () => {
  const src = [
    "const re = /from ['\"]intents/;",
    'const apiPort = 45000;',
    "const yaml = 'ports: [45000]';",
  ].join('\n');
  assert.deepEqual(flagged(src), [2], 'the next line is still scanned as code');
  const out = blankComments(src, { strings: true });
  assert.ok(out.includes('const apiPort = 45000;'), 'real code past the regex is not blanked');
  assert.ok(!out.split('\n')[2].includes('45000'), 'and a real string past it is still blanked');
});

// A backtick legitimately spans lines, so it keeps the old behaviour.
test('a template literal still spans lines', () => {
  const out = blankComments('const t = `a\nports: [45000]\n`;\n', { strings: true });
  assert.ok(!out.includes('45000'), 'the multi-line template contents are blanked');
});

// The `\\` branch consumes the newline before the newline test sees it, so a
// backslash-newline line continuation still holds the string open.
test('a backslash-newline continuation still holds a string open', () => {
  const out = blankComments("const a = 'x\\\nports: [45000]';\n", { strings: true });
  assert.ok(!out.includes('45000'), 'the continued string is blanked');
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
  assert.deepEqual(flagged('const ports = opts.ports ?? [45000];'), [], 'defaulted array initializer');
  assert.deepEqual(
    flagged('const apiPort = 7331;\nobj.x = Math.random();'),
    [],
    'rule 2 does not reach across a completed statement',
  );
  // The order-flipped form DOES fire, which is what makes the one above a gap
  // rather than a policy.
  assert.deepEqual(flagged('const o = { apiPort: 45000 + BASE };'), [1]);
});

// The header names two residual FALSE positives — the expensive direction on a
// required gate — so they are pinned too. Both resolve with the allow marker.
test('documented false positives stay documented', () => {
  assert.deepEqual(
    flagged('function pickPort() {\n  return 1;\n}\nobj.x = Math.random();'),
    [4],
    'rule 2 still reaches a port-ish block that has already closed',
  );
  assert.deepEqual(
    flagged('function pickPort() {\n  return 1;\n}\nobj.x = Math.random(); // ' + ALLOW_MARKER),
    [],
    'and the marker is the resolution',
  );
  assert.deepEqual(
    flagged('if (x) /apiPort: 45000/.test(y);'),
    [1],
    'a `)` reads as division, so that pattern body is scanned as code',
  );
  assert.deepEqual(
    flagged('const re = /apiPort: 45000/.test(y);'),
    [],
    'and the same pattern after an `=` is correctly read as a regex',
  );
});

// ── Regex literals (#3268) ──────────────────────────────────────────────────
// A `'`, `"` or backtick inside a regex used to open a quote state the machine
// never saw closed. The quote forms were bounded at the newline; the backtick
// form was not, because a template literal legitimately spans lines. So one
// backtick in a pattern blanked every line up to the next backtick anywhere in
// the file — four real lines in
// `test/harnesses/impls/learner/candidate-prompt-discipline.test.ts`, which
// scanned as prose and were never checked for a port. Tracking the regex
// literal removes the desync at its source: a regex cannot contain a raw
// newline, so the state is bounded by construction.
test('a backtick inside a regex literal cannot open a template span', () => {
  const src = ['const p = /a`b/;', 'const apiPort = 45000;', 'const z = 1;'].join('\n');
  assert.deepEqual(flagged(src), [2], 'the line after the regex is scanned as code');
  const live = ["  { name: 'x', pattern: /implStateDir\\/(?!\\*\\*`\\))[A-Za-z.<]/ },", 'const apiPort = 45000;'].join('\n');
  assert.deepEqual(flagged(live), [2], 'the shape of the live instance in the tree');
});

test('a regex literal is data: its contents are blanked, its delimiters are not', () => {
  assert.deepEqual(flagged('const re = /apiPort: 45000/;'), [], 'a port shape inside a pattern is not code');
  assert.deepEqual(flagged("const re = /don't/; const s = 'ports: [45000]';"), [], 'the quote in the pattern no longer eats the string');
  const out = blankComments('const re = /a`b/;\n', { strings: true });
  assert.equal(out.length, 'const re = /a`b/;\n'.length, 'byte offsets are preserved');
  assert.ok(!out.includes('a`b'), 'the pattern body is blanked');
  assert.equal((out.match(/\//g) ?? []).length, 2, 'both delimiters survive in place');
});

test('a division is not mistaken for a regex literal', () => {
  assert.deepEqual(flagged('const apiPort = total / count; const b = 45000;'), [], 'no port position here');
  assert.deepEqual(flagged('const half = n / 2;\nconst apiPort = 45000;'), [2], 'code after a division is still scanned');
  assert.deepEqual(flagged('const apiPort = (a + b) / 2 / 3;\nsrv.listen(45000);'), [2], 'a paren-closed division too');
});

test('an unterminated slash cannot blank past its own line', () => {
  assert.deepEqual(flagged('const el = <div className="x">;\nconst apiPort = 45000;'), [2]);
  assert.deepEqual(flagged('const s = a / b;\nconst apiPort = 45000;'), [2]);
});

// Now that the regex/division ambiguity is resolved, a rule-3 pin sharing a
// line with a regex is reachable. It used to be a documented non-catch.
test('rule 3 sees a pin sharing a line with a regex literal', () => {
  const found = scanVitestConfig('exclude: [/a\\/\\//], isolate: false,');
  assert.equal(found.length, 1, 'the regex no longer blanks the rest of the line');
  assert.ok(found[0].why.includes('isolate: false'));
  assert.deepEqual(scanVitestConfig('exclude: [/maxWorkers: 1/],'), [], 'and a pin written inside a pattern is not a pin');
});

// ── Rule 3 separators (#3269) ───────────────────────────────────────────────
// Rules 1 and 2 normalise separators before testing a literal's band. Rule 3's
// pins did not, so `1_0` — ten workers — matched the one-worker pin, on a
// required gate, with a message contradicting the value it was reading.
test('rule 3 normalises separators before comparing a pin value', () => {
  for (const key of ['maxWorkers', 'maxForks', 'minForks', 'maxThreads', 'minThreads', 'maxConcurrency']) {
    const nested = `export default { test: { poolOptions: { forks: { ${key}: VALUE } } } };`;
    assert.deepEqual(scanVitestConfig(nested.replace('VALUE', '1_0')), [], `${key}: 1_0 is ten, not a pin`);
    assert.deepEqual(scanVitestConfig(nested.replace('VALUE', '10')), [], `${key}: 10 is not a pin`);
    assert.equal(scanVitestConfig(nested.replace('VALUE', '1')).length, 1, `${key}: 1 is still a pin`);
  }
  assert.equal(scanVitestConfig("test: { maxWorkers: '1' }").length, 1, 'the quoted form still pins');
  assert.deepEqual(scanVitestConfig('test: { maxWorkers: 1.0 }'), [], 'a non-integer pin is still a non-catch');
});

test('rule 3 checks later pool counts on the same line', () => {
  for (const config of [
    'poolOptions: { forks: { maxForks: 10, minForks: 1 } }',
    'poolOptions: { threads: { maxThreads: 1_0, minThreads: 1 } }',
  ]) {
    const found = scanVitestConfig(config);
    assert.equal(found.length, 1, 'a non-pin must not hide a later one-worker pin');
    assert.ok(found[0].why.includes('pool-level'));
  }
  assert.deepEqual(scanVitestConfig('poolOptions: { forks: { maxForks: 10, minForks: 2 } }'), []);
});

// ── Rule 1a over whole-file text (#3270) ────────────────────────────────────
// Rule 1d was moved to whole-file text so a multi-line `ports: [` array is
// caught; rule 1a was left per-line and the header did not say so.
test('rule 1a sees a .listen( whose port is on the next line', () => {
  assert.deepEqual(flagged('srv.listen(\n  45007,\n);'), [2], 'reported at the literal, where the marker goes');
  assert.deepEqual(flagged('srv.listen(\n  7331,\n);'), [], 'sub-band is still fine');
  assert.deepEqual(flagged('srv.listen(\n  45007, // ' + ALLOW_MARKER + '\n);'), [], 'the marker is read at the literal line');
});

// ── Rule 1e: a port-ish const bound to an array (#3270, #3541) ──────────────
// Rule 1c's scalar initializer and rule 1d's object key meet here, and neither
// covered it: `[` stops 1c, and a `const` is not the `name:` form 1d wants.
// Hoisting `isDailyDriverRunning({ ports: [60001, 60002] })`'s array to a named
// const is an ordinary refactor that used to silently unguard the band.
test('rule 1e catches a port-ish const bound to an array literal', () => {
  assert.deepEqual(flagged('const dailyDriverPorts = [60001, 60002];'), [1]);
  assert.deepEqual(flagged('const ports: number[] = [45000];'), [1], 'through a type annotation');
  assert.deepEqual(flagged('let ports = [45_000];'), [1], 'separated, and `let` too');
  assert.deepEqual(flagged('const ports = [\n  60001,\n  60002,\n];'), [2, 3], 'every element, multi-line');
  assert.deepEqual(flagged('const ports = [9331, 9332];'), [], 'sub-band is the sanctioned form');
  assert.deepEqual(flagged('const transports = [45000];'), [], 'the name is filtered like every other rule');
  assert.deepEqual(flagged('const ports = [60001]; // ' + ALLOW_MARKER), [], 'the marker suppresses it');
});

// ── Rule 2 attribution (#3542) ─────────────────────────────────────────────
// The bounded walk attributed a random call to whatever declaration was within
// ten lines. A correct sub-band reservation followed by an unrelated
// `Math.random` therefore reddened a required gate on a line that has nothing
// to do with a port. A declaration whose line already ended in `;` is a
// completed statement, so nothing written below it is inside it.
test('rule 2 does not attribute a random call across a completed statement', () => {
  const src = ['const apiPort = 7331;', 'a();', 'b();', 'c();', 'd();', 'e();', 'f();', 'g();', 'obj.x = Math.random();'].join('\n');
  assert.deepEqual(flagged(src), [], 'the sanctioned reservation does not adopt an unrelated random call');
  assert.deepEqual(flagged('const apiPort = 7331;\nobj.x = Math.random();'), [], 'not even on the very next line');
});

test('rule 2 still catches a random call inside a port-ish declaration', () => {
  assert.deepEqual(flagged('function pickPort() {\n  doThing();\n  return Math.random();\n}'), [3], 'through an intervening statement');
  assert.deepEqual(flagged('const pickPort = () => {\n  return Math.random();\n};'), [2], 'an arrow body');
  assert.deepEqual(flagged('const apiPort =\n  40000 + Math.floor(Math.random() * 20000);'), [2], 'a continued initializer');
  assert.deepEqual(flagged('const attempts = 3;\nfunction pickPort() {\n  return Math.random();\n}'), [3], 'the nearest declaration still wins');
});

// ── The walk's extension filter (#3543) ────────────────────────────────────
test('the walk collects every JS/TS source extension inside a root', (t) => {
  const root = makeTree(t, {
    'a.ts': '', 'b.tsx': '', 'c.mts': '', 'd.cts': '',
    'e.js': '', 'f.jsx': '', 'g.mjs': '', 'h.cjs': '',
    'i.d.ts': '', 'j.d.mts': '', 'k.json': '', 'l.md': '',
    'nested/m.tsx': '',
  });
  const collected = walk(root).map((f) => f.slice(root.length + 1).split('\\').join('/')).sort();
  assert.deepEqual(collected, [
    'a.ts', 'b.tsx', 'c.mts', 'd.cts', 'e.js', 'f.jsx', 'g.mjs', 'h.cjs', 'nested/m.tsx',
  ].sort(), 'declaration files and non-source files are not collected');
});

test('the walk skips node_modules, dist, symlinks and the skip dir', (t) => {
  const root = makeTree(t, {
    'keep.ts': '', 'node_modules/x.ts': '', 'dist/y.ts': '', 'fixtures/z.ts': '', 'real/w.ts': '',
  });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  const collected = walk(root, join(root, 'fixtures')).map((f) => f.slice(root.length + 1).split('\\').join('/')).sort();
  assert.deepEqual(collected, ['keep.ts', 'real/w.ts']);
});

// ── scanRoots and the bail paths (#3271) ───────────────────────────────────
test('scanRoots probes the trees the header says it probes', (t) => {
  const root = makeTree(t, {
    'test/a.ts': '', 'scripts/release/b.ts': '',
    'plugins/one/test/c.ts': '', 'plugins/two/src/d.ts': '',
    'plugins/deep/nested/test/e.ts': '', 'plugins/node_modules/test/f.ts': '',
    'packages/pkg/test/g.ts': '',
  });
  const rel = scanRoots(root).map((r) => r.slice(root.length + 1).split('\\').join('/')).sort();
  assert.deepEqual(rel, ['packages/pkg/test', 'plugins/one/test', 'scripts/release', 'test'].sort(),
    'one level deep under each workspace group, node_modules skipped, no src/ and nothing nested deeper');
});

test('runGuard is green on a clean tree and red on a violating one', (t) => {
  const clean = makeTree(t, { 'test/a.test.ts': 'const apiPort = 7331;\n', 'vitest.config.ts': 'export default {};\n' });
  const ok = runGuard(clean);
  assert.equal(ok.exitCode, 0);
  assert.ok(ok.stdout.join('\n').includes('No fixed ephemeral-range test ports'));

  const dirty = makeTree(t, { 'test/a.test.ts': 'const apiPort = 45_000;\n', 'vitest.config.ts': 'export default {};\n' });
  const bad = runGuard(dirty);
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.stderr.join('\n').includes('operator/test/a.test.ts:1'), 'the file and line are reported');

  const pinned = makeTree(t, { 'test/a.test.ts': '', 'vitest.config.ts': 'export default { test: { isolate: false } };\n' });
  const pin = runGuard(pinned);
  assert.equal(pin.exitCode, 1);
  assert.ok(pin.stderr.join('\n').includes('isolate: false'));
});

test('runGuard fails loudly rather than passing vacuously', (t) => {
  const noTestTree = makeTree(t, { 'scripts/release/a.ts': '', 'vitest.config.ts': '' });
  const missing = runGuard(noTestTree);
  assert.equal(missing.exitCode, 1, 'a moved test tree is a failure, not a pass');
  assert.ok(missing.stderr.join('\n').includes('operator/test/ does not exist'));

  const notADir = makeTree(t, { 'test': 'this is a file, not the test tree\n', 'vitest.config.ts': '' });
  const noRoots = runGuard(notADir);
  assert.equal(noRoots.exitCode, 1);
  assert.ok(noRoots.stderr.join('\n').includes('operator/test/ is not a directory'));

  const empty = makeTree(t, { 'test/.gitkeep': '', 'vitest.config.ts': '' });
  const zeroFiles = runGuard(empty);
  assert.equal(zeroFiles.exitCode, 1, 'a scan that collected zero files is a failure');
  assert.ok(zeroFiles.stderr.join('\n').includes('collected zero'));

  const noConfig = makeTree(t, { 'test/a.test.ts': '' });
  const configGone = runGuard(noConfig);
  assert.equal(configGone.exitCode, 1, 'rule 3 checking nothing is a failure');
  assert.ok(configGone.stderr.join('\n').includes('vitest.config.ts not found'));
});

test('runGuard rejects a non-directory test root even when another scan root exists', (t) => {
  const root = makeTree(t, {
    'test': 'this is a file, not the test tree\n',
    'scripts/release/a.test.ts': '',
    'vitest.config.ts': '',
  });
  const result = runGuard(root);
  assert.equal(result.exitCode, 1, 'release tests cannot substitute for the primary test tree');
  assert.ok(result.stderr.join('\n').includes('operator/test/ is not a directory'));
});

test('runGuard skips test/fixtures/ but not a fixtures dir elsewhere', (t) => {
  const root = makeTree(t, {
    'test/fixtures/corpus.ts': 'const apiPort = 45000;\n',
    'test/release/fixtures/other.ts': 'const apiPort = 45001;\n',
    'test/a.test.ts': '',
    'vitest.config.ts': '',
  });
  const result = runGuard(root);
  assert.equal(result.exitCode, 1);
  const out = result.stderr.join('\n');
  assert.ok(!out.includes('corpus.ts'), 'operator/test/fixtures/ is data, not tests');
  assert.ok(out.includes('release/fixtures/other.ts'), 'only that one exact directory is skipped');
});
