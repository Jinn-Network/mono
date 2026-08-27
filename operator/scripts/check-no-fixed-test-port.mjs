#!/usr/bin/env node
/**
 * Lint guard: no hard-coded 127.0.0.1 port inside the OS ephemeral range in a
 * test file, and no silent retirement of the test-suite parallelism that makes
 * the hazard real.
 *
 * The failure class (issue #1627). `operator/vitest.config.ts` sets none of
 * `pool` / `isolate` / `fileParallelism` / `maxWorkers`, so vitest resolves its
 * defaults: `pool: 'forks'`, `isolate: true`, `fileParallelism: true`, and
 * `maxWorkers = max(availableParallelism() - 1, 1)`. `Jinn-Network/mono` is a
 * public repository, so `ubuntu-latest` is a 4-vCPU runner and CI therefore
 * runs THREE forked workers over ~850 test files.
 *
 * Those workers are well isolated in every dimension but one. Each is a real
 * child process with its own module registry, its own globals, and — via
 * `test/_support/isolate-home.ts` — its own `$HOME` and `$TMPDIR`. What they
 * cannot have their own copy of is the machine's 127.0.0.1 TCP port space:
 * that is kernel-global and shared by every worker. So a test that hard-codes
 * a port inside the ephemeral range can have that exact port handed out from
 * under it by a sibling worker's `listen(0)` between the moment it decided on
 * the number and the moment it binds. The result is an EADDRINUSE (or, worse,
 * a test that silently talks to a stranger's server) that reproduces only
 * under parallel load, only sometimes, and never on the laptop of whoever is
 * asked to debug it.
 *
 * Ranges: Linux's `ip_local_port_range` default is 32768–60999 and macOS's is
 * 49152–65535, which sits strictly inside the upper half of the Linux band.
 * Guarding 32768–60999 therefore covers both.
 *
 * Policy enforced here — three rules over the test trees:
 *
 *   1. No numeric literal in [32768, 60999] in a *bind or probe position* —
 *      the first argument of `.listen(`, or the value of a port-shaped object
 *      key (`apiPort` / `grpcPort` / `httpPort` / `portBase` / `ports` /
 *      `dailyDriverPorts` / `port`), including every element of an array
 *      literal in that position.
 *   2. No randomly-guessed port — a `Math.random` call whose line, or whose
 *      nearest enclosing `function <name>` / `const <name> =` declaration, is
 *      named something port-ish. Guessing is the same race as hard-coding,
 *      just with a wider blast radius and a lower reproduction rate.
 *   3. No parallelism pin in `operator/vitest.config.ts`.
 *
 * Rules 1 and 2 deliberately test POSITION ∧ VALUE-BAND, never either alone.
 * `operator/test/**` holds ~1,900 numeric literals that fall inside the band
 * and are not ports at all — timeouts (`50000`, `60000`), Hyperliquid price
 * fixtures (`'50000'`, `'51500'`), and hex-address substrings (`33333`,
 * `55555`, `44444`) — so a value-only rule is pure noise. It also holds ~30
 * legitimate fixed port literals in genuine port positions (7331, 7332, 7333,
 * 7340, 7342, 7360, 7400, 7450, 7451, 7732–7734, 7740–7743, 18533), every one
 * of them safely BELOW the ephemeral band, so a position-only rule condemns
 * the correct code. Only the intersection names the actual hazard.
 *
 * Rule 3 exists because rules 1 and 2 are load-bearing only while the suite
 * actually runs files in parallel. Pinning `fileParallelism: false` or
 * `maxWorkers: 1` would make every port collision disappear locally and
 * silently retire the reason this guard exists — while roughly tripling CI
 * wall-clock. Setting `pool:` is caught for a second reason: `pool: 'forks'`
 * is ALREADY the resolved default, so writing it buys nothing, and the one
 * plausible edit — flipping to `pool: 'threads'` — would break the
 * process-level `$HOME`/`$TMPDIR` isolation that `isolate-home.ts` depends on,
 * because a worker thread's `process.env.HOME` write never reaches
 * `uv_os_homedir` and every "isolated" home would collapse back onto the
 * developer's real one. If parallelism genuinely has to change, that is a
 * deliberate decision that should edit this guard in the same commit.
 *
 * Rule 3 reads `operator/vitest.config.ts` and that file ONLY. It never reads
 * `vitest.hermetic.config.ts`, which is deliberately sequential — the hermetic
 * gate spawns Anvil, Ponder, and real daemons against shared fixtures and must
 * not run those files concurrently.
 *
 * Scope: the test trees mirrored from `nodeInclude` in vitest.config.ts —
 * `operator/test/`, plus the `test/` dir of each `operator/plugins/<name>` and
 * `operator/packages/<name>` workspace.
 * `operator/test/fixtures/` is skipped entirely: fixtures are data, not tests
 * (vitest.config.ts already excludes them), and the jinn-repo corpus fixtures
 * embed real gold-test files from other checkouts that this guard has no
 * standing over.
 *
 * Suppression: a line carrying the inline comment
 * `lint:no-fixed-test-port-allow` is skipped, matching the house
 * `lint:no-error-leak-allow` convention. It is expected to have ZERO consumers
 * on landing — it exists for a future case nobody has met yet, not for the
 * ones this guard was written against.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the operator root from the script's location so the check works
// regardless of where it's invoked from (yarn runs with cwd=operator/, but a
// direct `node operator/scripts/...` from the repo root must work too).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OPERATOR_ROOT = join(SCRIPT_DIR, '..');
const TEST_ROOT = join(OPERATOR_ROOT, 'test');
const FIXTURES_DIR = join(TEST_ROOT, 'fixtures');
const VITEST_CONFIG = join(OPERATOR_ROOT, 'vitest.config.ts');

// Linux `ip_local_port_range` default. macOS's 49152–65535 sits inside it.
const EPHEMERAL_MIN = 32768;
const EPHEMERAL_MAX = 60999;

const ALLOW_MARKER = 'lint:no-fixed-test-port-allow';

const PORT_KEY = '\\b(?:apiPort|grpcPort|httpPort|portBase|ports|dailyDriverPorts|port)\\s*:\\s*';
const LISTEN_LITERAL = /\.listen\(\s*(\d{4,5})\b/g;
const PORT_KEY_LITERAL = new RegExp(`${PORT_KEY}(\\d{4,5})\\b`, 'g');
const PORT_KEY_ARRAY = new RegExp(`${PORT_KEY}\\[([^\\]]*)\\]`, 'g');
const ARRAY_ELEMENT = /\b(\d{4,5})\b/g;

const RANDOM_CALL = /Math\.random/;
const DECLARATION = /\bfunction\s+([A-Za-z_$][\w$]*)|\bconst\s+([A-Za-z_$][\w$]*)\s*=/;
const PORTISH_NAME = /port/i;

// Rule 3: a parallelism pin in vitest.config.ts. `pool:` is caught alongside
// the explicit off-switches — see the doc block.
const PARALLELISM_PINS = [
  /\bfileParallelism\s*:\s*false\b/,
  /\bmaxWorkers\s*:\s*['"]?1['"]?(?![\d.])/,
  /\bpool\s*:/,
];

function inBand(value) {
  return value >= EPHEMERAL_MIN && value <= EPHEMERAL_MAX;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      if (full === FIXTURES_DIR) continue; // fixtures are data, not tests
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The test trees vitest actually collects from. `plugins/` and `packages/` are
 * one-level workspace globs, and not every workspace has a `test/` dir, so
 * each candidate is probed rather than assumed.
 */
function scanRoots() {
  const roots = [];
  if (existsSync(TEST_ROOT)) roots.push(TEST_ROOT);
  for (const group of ['plugins', 'packages']) {
    const groupDir = join(OPERATOR_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const candidate = join(groupDir, entry, 'test');
      if (existsSync(candidate) && statSync(candidate).isDirectory()) roots.push(candidate);
    }
  }
  return roots;
}

/** Rule 2: the name this `Math.random` line belongs to, or null. */
function enclosingName(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const m = DECLARATION.exec(lines[i]);
    if (m) return m[1] ?? m[2];
  }
  return null;
}

const violations = [];
const parallelismViolations = [];

for (const root of scanRoots()) {
  for (const file of walk(root)) {
    const rel = relative(OPERATOR_ROOT, file).split('\\').join('/');
    const display = `operator/${rel}`;
    const lines = readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, idx) => {
      if (line.includes(ALLOW_MARKER)) return;

      const flagged = [];

      // Rule 1a — bind position: `.listen(<port>, …)`.
      for (const m of line.matchAll(LISTEN_LITERAL)) {
        if (inBand(Number(m[1]))) flagged.push(m[1]);
      }
      // Rule 1b — port-key position, bare literal.
      for (const m of line.matchAll(PORT_KEY_LITERAL)) {
        if (inBand(Number(m[1]))) flagged.push(m[1]);
      }
      // Rule 1b — port-key position, array literal: EVERY element counts.
      for (const m of line.matchAll(PORT_KEY_ARRAY)) {
        for (const el of m[1].matchAll(ARRAY_ELEMENT)) {
          if (inBand(Number(el[1]))) flagged.push(el[1]);
        }
      }
      // Rule 2 — a guessed port is the same race, harder to reproduce.
      if (RANDOM_CALL.test(line)) {
        const name = enclosingName(lines, idx);
        if (name && PORTISH_NAME.test(name)) flagged.push('Math.random');
      }

      if (flagged.length > 0) {
        violations.push({ file: display, line: idx + 1, snippet: line.trim() });
      }
    });
  }
}

// Rule 3 — vitest.config.ts only. vitest.hermetic.config.ts is deliberately
// sequential and is never read here.
if (existsSync(VITEST_CONFIG)) {
  readFileSync(VITEST_CONFIG, 'utf8')
    .split('\n')
    .forEach((line, idx) => {
      if (line.includes(ALLOW_MARKER)) return;
      if (PARALLELISM_PINS.some((re) => re.test(line))) {
        parallelismViolations.push({
          file: 'operator/vitest.config.ts',
          line: idx + 1,
          snippet: line.trim(),
        });
      }
    });
}

if (violations.length === 0 && parallelismViolations.length === 0) {
  console.log('✓ No fixed ephemeral-range test ports, and suite parallelism is unpinned.');
  process.exit(0);
}

if (violations.length > 0) {
  console.error('✗ Fixed (or randomly guessed) 127.0.0.1 port inside the OS ephemeral');
  console.error('  range 32768–60999 detected in a test file. Vitest runs ~850 test files');
  console.error('  across 3 forked workers on CI, and those workers share one kernel-global');
  console.error("  port space, so a sibling's listen(0) can take this port between the");
  console.error('  moment the test picks it and the moment it binds. See issue #1627.\n');
  console.error('  Use one of the three sanctioned forms instead:');
  console.error('    1. A CHILD PROCESS binds it (Anvil, Ponder, a spawned daemon):');
  console.error("       `await allocateAnvilPort()` from '@test/chain/port-allocator.js'.");
  console.error('    2. The TEST ITSELF binds it: `listen(0, \'127.0.0.1\')`, then read the');
  console.error('       assigned port off `server.address().port`. This is atomic — there is');
  console.error('       no allocate-then-rebind window for a sibling worker to win.');
  console.error('    3. The assertion is "NOTHING is listening here": use a fixed port BELOW');
  console.error('       32768, with a comment saying why that port is expected to be free.\n');
  console.error('  Violations:');
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
  }
}

if (parallelismViolations.length > 0) {
  if (violations.length > 0) console.error('');
  console.error('✗ Test-suite parallelism is pinned in operator/vitest.config.ts.');
  console.error('  The port rules above are load-bearing only while vitest actually runs');
  console.error('  files in parallel. `fileParallelism: false` or `maxWorkers: 1` makes');
  console.error('  every cross-worker port collision vanish locally, silently retiring the');
  console.error('  reason those rules exist — and roughly triples CI wall-clock.\n');
  console.error("  `pool:` is rejected for a second reason: `pool: 'forks'` is ALREADY the");
  console.error('  resolved default, so setting it buys nothing, and the one plausible edit');
  console.error("  — flipping to `pool: 'threads'` — would break the process-level $HOME /");
  console.error('  $TMPDIR isolation that test/_support/isolate-home.ts depends on: a worker');
  console.error("  thread's `process.env.HOME` write never reaches uv_os_homedir, so every");
  console.error("  test's \"isolated\" home would collapse back onto the developer's real one.\n");
  console.error('  If parallelism genuinely must change, edit this guard in the same commit.');
  console.error('  See issue #1627.\n');
  console.error('  Violations:');
  for (const v of parallelismViolations) {
    console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
  }
}

process.exit(1);
