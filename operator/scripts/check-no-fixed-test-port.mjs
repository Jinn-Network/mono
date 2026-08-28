#!/usr/bin/env node
/**
 * Lint guard: no hard-coded 127.0.0.1 port inside the OS ephemeral range in a
 * test file, and no silent retirement of the test-suite parallelism and
 * per-file process isolation that make the hazard real.
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
 * Ranges: the guarded band is 32768–65535, the UNION of the two OS defaults
 * this suite runs on — Linux's `ip_local_port_range` default (32768–60999,
 * the CI runners) and the macOS ephemeral range (49152–65535, the laptops).
 * Neither range contains the other: 32768–49151 is Linux-only and
 * 61000–65535 is macOS-only, so guarding either one alone leaves a live hole
 * on the other platform. The union costs nothing here — a census of the test
 * trees found no port-position literal anywhere inside it.
 *
 * Policy enforced here — three rules over the test trees:
 *
 *   1. No numeric literal in [32768, 65535] in a *port-shaped position* —
 *      the first argument of `.listen(`, the value of an object key whose name
 *      is port-ish (`apiPort`, `daemonPort`, `gammaPort`, `portBase`, `ports`,
 *      `port` — the same `PORTISH_NAME` test rule 1c applies to a binding
 *      name, not an enumerated list) including every element of an array
 *      literal in that position, or the initializer of a `const` / `let` /
 *      `var` whose name is port-ish (`const apiPort = 45000`, and the
 *      defaulted form `const portBase = opts.portBase ?? 45000`). The array
 *      form is matched against the whole file text rather than line by line,
 *      so a `ports: [\n  60001,\n]` spread over several lines is caught too.
 *   2. No randomly-guessed port — a `Math.random` or `randomInt(` call whose
 *      line, or whose
 *      nearest enclosing `function <name>` / `const <name> =` declaration
 *      within 10 lines, is named something port-ish. Guessing is the same race
 *      as hard-coding, just with a wider blast radius and a lower reproduction
 *      rate.
 *   3. No parallelism pin, and no isolation opt-out, in
 *      `operator/vitest.config.ts`.
 *
 * Rules 1 and 2 read CODE, not raw text: comments and string contents are
 * blanked (offsets preserved) before they run, so prose about the band and a
 * port array quoted inside a fixture string are both invisible to them. This is
 * the same treatment rule 3 has always had, and for the same reason — the
 * runbook this guard ships with actively teaches contributors to write about
 * in-band ports.
 *
 * Rules 1 and 2 deliberately test POSITION ∧ VALUE-BAND, never either alone.
 * `operator/test/**` holds ~1,900 numeric literals that fall inside the band
 * and are not ports at all — timeouts (`50000`, `60000`), Hyperliquid price
 * fixtures (`'50000'`, `'51500'`), and hex-address substrings (`33333`,
 * `55555`, `44444`) — so a value-only rule is pure noise. It also holds 61
 * legitimate fixed port literals in genuine port positions, over the distinct
 * numbers 7331, 7332, 7333, 7340, 7342, 7350, 7351, 7360, 7388, 7389, 7390,
 * 7400, 7450, 7451, 7732, 7733, 7734, 7740, 7742, 7777, 9331, 9332, 18532 and
 * 18533, plus the
 * `const API_PORT = 27331` that rule 1c sees — every one of them safely BELOW
 * the ephemeral band, so a position-only rule condemns the correct code. Only
 * the intersection names the actual hazard. The below-band fixed ports in
 * current use are registered in the header comment of
 * `operator/test/release/tier-1/T1.2-harness-readiness-contract.ts`.
 *
 * Numeric separators count. `45_000` is the same port as `45000`, and the
 * repository writes 4- and 5-digit numbers in separated form on well over a
 * thousand lines (`10_000`, `30_000`), including inside this very change. A
 * digit-run pattern that cannot cross the `_` would let one underscore walk
 * straight through every rule above while the gate stayed green, so every
 * literal is normalised (separators stripped) before its band is tested.
 *
 * "Port-ish name" is matched at a word or camelCase boundary, NOT as a bare
 * substring: `portBase`, `apiPort`, `pickPort`, `API_PORT` are port-ish;
 * `transport`, `support`, `import`, `report`, `export`, `portion` are not. A
 * bare `/port/i` would flag `const transport = …`, which is ubiquitous in a
 * viem codebase, and redden a required CI gate on unrelated PRs.
 *
 * Rule 3 exists because rules 1 and 2 are load-bearing only while the suite
 * actually runs files in parallel, each in its own process. Every switch that
 * turns one of those off is rejected here:
 *
 *   - `isolate: false` is the MOST DANGEROUS of the set, and the reason this
 *     rule is not just about wall-clock. It reuses one worker process across
 *     test files, so it does not merely slow CI down or hide the port hazard —
 *     it silently invalidates the central claim of the #1627 measurement
 *     ("cross-file module / global / `$HOME` / `$TMPDIR` leakage is
 *     structurally impossible") while leaving the suite green. Every other pin
 *     below costs time or reproduction rate; this one costs the conclusion.
 *   - `singleFork: true` / `singleThread: true` — the documented vitest switch
 *     for serializing a pool onto one reused worker. Implies `isolate: false`
 *     semantics for cross-file state and removes all cross-worker contention.
 *   - `fileParallelism: false`, `maxWorkers: 1`, `maxForks` / `minForks` /
 *     `maxThreads` / `minThreads` pinned to 1 — the worker-count off-switches.
 *     They make every cross-worker port collision disappear locally while
 *     roughly tripling CI wall-clock.
 *   - `maxConcurrency: 1` — caps concurrent tests within a file. It does not
 *     by itself serialize files, but it is a parallelism pin in the same
 *     config, and it removes the intra-file contention the load-sensitive
 *     budget rules exist to survive.
 *   - `pool:` is caught for a second reason: `pool: 'forks'` is ALREADY the
 *     resolved default, so writing it buys nothing, and the one plausible edit
 *     — flipping to `pool: 'threads'` — would break the process-level `$HOME`
 *     / `$TMPDIR` isolation that `isolate-home.ts` depends on, because a
 *     worker thread's `process.env.HOME` write never reaches `uv_os_homedir`
 *     and every "isolated" home would collapse back onto the developer's real
 *     one.
 *
 * If parallelism genuinely has to change, that is a deliberate decision that
 * should edit this guard in the same commit.
 *
 * Rule 3 reads `operator/vitest.config.ts` and that file ONLY. It never reads
 * `vitest.hermetic.config.ts`, which is deliberately sequential — the hermetic
 * gate spawns Anvil, Ponder, and real daemons against shared fixtures and must
 * not run those files concurrently. It reads that config with comments
 * stripped: today the file is roughly half prose, and the natural way to
 * record *why* `pool` and `maxWorkers` are left alone is a comment naming
 * them — which a raw line scan reports as the very pin it is explaining, on a
 * required gate, with a message that contradicts the file.
 *
 * Scope: the whole `operator/test/` tree, plus `operator/scripts/release/` and
 * the `test/` dir of each `operator/plugins/<name>` and
 * `operator/packages/<name>` workspace. `operator/test/` is deliberately a
 * SUPERSET of what `nodeInclude` in `vitest.config.ts` collects: it also holds
 * `test/e2e/**` and `test/hermetic/**`, which the default parallel suite
 * excludes. Those trees run under their own sequential entry points and so do
 * not face the cross-worker race, but they are policed anyway — a file moves
 * between trees far more easily than a reviewer notices that its fixed port
 * has just entered a parallel suite. A genuinely sequential-only fixed port in
 * the band is the case the `lint:no-fixed-test-port-allow` marker exists for.
 * The two workspace probes are ONE level deep — literally `<group>/<name>/test`
 * — whereas the vitest plugin glob is recursive under `plugins/` and would also
 * collect a `test/` dir nested deeper than one level. Today that difference is
 * inert: `operator/plugins/` has exactly one workspace with a `test/` dir and
 * none nested deeper, and `operator/packages/` does not exist at all — its
 * probe is kept for the day it does. `operator/test/fixtures/` is skipped
 * entirely: fixtures are data, not tests (vitest.config.ts already excludes
 * them), and the jinn-repo corpus fixtures embed real gold-test files from
 * other checkouts that this guard has no standing over.
 *
 * The guard fails loudly rather than passing vacuously when its subject is
 * missing: a renamed or moved `vitest.config.ts`, an absent `operator/test/`,
 * or a scan that collects zero files all exit non-zero. A guard that silently
 * polices nothing is worse than no guard, because the green check still reads
 * as coverage.
 *
 * Suppression: a line carrying the inline comment
 * `lint:no-fixed-test-port-allow` is skipped, matching the house
 * `lint:no-error-leak-allow` convention. It applies to all three rules. For
 * the multi-line array form the marker is per-ELEMENT line, not on the
 * `ports: [` header — the header line is not where the literal is reported.
 * For rule 3 the marker is read off the raw line rather than the blanked one,
 * since a marker only ever lives inside a comment. It is expected to have ZERO
 * consumers on landing: it exists for a future case nobody has met yet, not
 * for the ones this guard was written against.
 *
 * ── What this guard deliberately does NOT catch ─────────────────────────────
 *
 * Named so that the doc, the runbook, and this file agree on the size of the
 * claim. Each is a known gap, not an oversight; none has a live instance in
 * the tree today.
 *
 *   - Anything inside a comment or a string literal. Rules 1 and 2 match
 *     against comment- and string-blanked text, so a port inside a URL string
 *     (`fetch('http://127.0.0.1:45020/health')`), a port array quoted into a
 *     YAML fixture (`const yaml = 'ports: [45000]'`), and a commented-out
 *     `srv.listen(45000)` are all invisible to them. The stated invariant is
 *     about port-shaped *syntactic positions*, which neither a comment nor a
 *     string literal is; a rule that read them would flag ports behind a fully
 *     mocked `fetch` (there is one such literal in the tree today) and prose
 *     that merely discusses the band, i.e. it would condemn code carrying no
 *     hazard and redden a required gate. Rule 3 blanks comments only — its
 *     subject is one config object literal, where a pin written inside a
 *     string does not occur.
 *   - A port position inside a template literal's `${…}` interpolation. The
 *     blanking does not parse interpolations back out; the failure is a missed
 *     literal, never a spurious one.
 *   - A bare reassignment — `apiPort = 45000;` with the declaration elsewhere.
 *     Rule 1c requires the `const` / `let` / `var`, which keeps it away from
 *     every `==` / `>=` / `=>` shape a looser pattern would have to exclude.
 *   - A nested array inside a port array — rule 1d's capture is not a bracket
 *     matcher, so it stops at the first `]` and reports only the first row. A
 *     `]` inside a *string* inside the array no longer stops it, since string
 *     contents are blanked before the capture runs.
 *   - A port array longer than 400 characters between its brackets. Rule 1d's
 *     capture is bounded there so an unclosed `[` cannot swallow the rest of
 *     the file; a real port array is nowhere near that long.
 *   - A ternary default — `const apiPort = cond ? x : 45000`. Rule 1c's
 *     optional prefix covers `??` and `||` only, which are how a default port
 *     is actually written in this tree.
 *   - A quoted object key — `{ 'port': 45000 }`. The key pattern is unquoted.
 *   - An arithmetic expression whose literal does not lead — `{ apiPort: BASE +
 *     45000 }`. Rule 1b needs the literal adjacent to the key, so the
 *     order-flipped `{ apiPort: 45000 + BASE }` does fire and this one does not.
 *   - A `listen(` with no receiver dot — rule 1a anchors on `.listen(`.
 *   - A destructured declaration — `const { apiPort = 45000 } = opts`. Rule 1c
 *     wants a plain binding name.
 *   - A rule-3 pin that is not a literal in this file — imported or spread in
 *     from another module, as well as the computed and CLI-flag forms below.
 *   - A computed or non-integer pin in rule 3 — `maxWorkers: process.env.CI ? 1
 *     : 4`, `maxThreads: 1.0`, or the same flag passed to vitest from the
 *     `test` script in `package.json` rather than written in the config. Rule 3
 *     reads one file and matches literals; it is a speed bump against a silent
 *     edit, not a sandbox against a determined one.
 *   - A pin sharing a line with a regex literal containing `/` — rule 3's
 *     comment blanking does not resolve the regex/division ambiguity, so
 *     `exclude: [/a\/\//]` blanks the rest of its line. The failure is a
 *     MISSED pin, never a spurious one, and vitest's `exclude` does accept a
 *     `RegExp`; it is left unresolved because a pin and such a regex on one
 *     line does not occur in a config object literal.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the operator root from the script's location so the check works
// regardless of where it's invoked from (yarn runs with cwd=operator/, but a
// direct `node operator/scripts/...` from the repo root must work too).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OPERATOR_ROOT = join(SCRIPT_DIR, '..');
const TEST_ROOT = join(OPERATOR_ROOT, 'test');
const RELEASE_SCRIPTS_ROOT = join(OPERATOR_ROOT, 'scripts', 'release');
const FIXTURES_DIR = join(TEST_ROOT, 'fixtures');
const VITEST_CONFIG = join(OPERATOR_ROOT, 'vitest.config.ts');

// The UNION of the two ephemeral ranges this suite runs on: Linux's
// `ip_local_port_range` default (32768–60999) and macOS's (49152–65535).
// Neither contains the other — see the doc block.
export const EPHEMERAL_MIN = 32768;
export const EPHEMERAL_MAX = 65535;

export const ALLOW_MARKER = 'lint:no-fixed-test-port-allow';

// A numeric literal as JavaScript actually writes one: digits, optionally
// broken by `_` separators. The trailing `(?![\w.])` rejects a longer run and a
// decimal (`45000.5`, `1.32768`), and the leading `(?<![\w.$])` — used where
// the match is not already anchored by `(` or `:` or `=` — keeps the scan from
// biting a digit run out of the middle of a hex address or a decimal.
const NUM = '(\\d[\\d_]*)(?![\\w.])';
const NUM_FREE = `(?<![\\w.$])${NUM}`;

// An OBJECT KEY, captured by name rather than enumerated. The name is then
// filtered through `PORTISH_NAME`, exactly as rule 1c filters a binding name —
// an enumerated list left `{ daemonPort: 45000 }` and `{ gammaPort: 45001 }`
// green while `const gammaPort = 45001` fired, for the same name and the same
// value, and both keys carry a real child-process bind in
// `scripts/release/olas-rails-smoke.ts` and `scripts/release/stage1-closed-loop.ts`.
// `(?<![\w$])` rather than `\b`, because `$` is not a word character and
// `$port:` would otherwise slip the boundary.
const PORT_KEY = '(?<![\\w$])([A-Za-z_$][\\w$]*)\\s*:\\s*';
// Rule 1d's array capture is bounded. `[^\]]*` is stopped by the first `]`
// and nothing else, so an unclosed `[` — in prose, in a string, or in a
// half-written edit — swallowed the rest of the FILE and reported every in-band
// number inside it, which is the collapse into a value-only rule the doc block
// above argues is unacceptable noise. A real port array is nowhere near this
// long.
const PORT_KEY_ARRAY_MAX = 400;
const LISTEN_LITERAL = new RegExp(`\\.listen\\(\\s*${NUM}`, 'g');
const PORT_KEY_LITERAL = new RegExp(`${PORT_KEY}${NUM}`, 'g');
const PORT_KEY_ARRAY = new RegExp(`${PORT_KEY}\\[([^\\]]{0,${PORT_KEY_ARRAY_MAX}})\\]`, 'g');
const ARRAY_ELEMENT = new RegExp(NUM_FREE, 'g');
// `const apiPort = 45000` — a bound-later port that PORT_KEY misses because it
// is an assignment, not an object key. The first optional group is the TS type
// annotation (`const apiPort: number = 45000`), which is ordinary in a `.ts`
// file and otherwise breaks the name-to-`=` adjacency; the second is the
// defaulted form `const portBase = opts.portBase ?? 45000`, which is how a
// helper's default port is actually written in this tree.
const PORT_DECL_LITERAL = new RegExp(
  `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*(?:[^;\\n]*?(?:\\?\\?|\\|\\|)\\s*)?${NUM}`,
  'g',
);

// `randomInt` as well as `Math.random`: the failure text advertises this rule
// as catching a "randomly guessed" port, and `crypto.randomInt(40000, 60000)`
// is the same guess with a better RNG.
const RANDOM_CALL = /Math\.random|\brandomInt\s*\(/;
const DECLARATION = /\bfunction\s+([A-Za-z_$][\w$]*)|\bconst\s+([A-Za-z_$][\w$]*)\s*=/;
/**
 * A `port` at a word or camelCase boundary — never a bare substring.
 *
 *   alt 1  lowercase `port(s)` opening a word (`port`, `ports`, `portBase`,
 *          `_port`) and not continuing into another lowercase word, which is
 *          what excludes `portion`. The leading `[^A-Za-z]` excludes
 *          `transport`, `support`, `import`, `report`, `export`.
 *   alt 2  camelCase `Port(s)` (`apiPort`, `grpcPort`, `pickPort`), again not
 *          continuing lowercase, which excludes `Portable` / `Portion`.
 *   alt 3  SCREAMING_SNAKE `PORT(S)` (`API_PORT`). The leading `[^A-Z]`
 *          excludes `TRANSPORT` / `SUPPORT` / `IMPORT`.
 */
const PORTISH_NAME = /(?:^|[^A-Za-z])ports?(?![a-z])|Ports?(?![a-z])|(?:^|[^A-Z])PORTS?(?![A-Z])/;
// Rule 2's enclosing-declaration walk is bounded: an unbounded walk runs to the
// top of the file and attributes a `Math.random` to whatever the file's first
// declaration happened to be called.
const DECLARATION_LOOKBACK_LINES = 10;

// Rule 3: a parallelism pin or isolation opt-out in vitest.config.ts. Each
// pattern carries the sentence that explains why it is rejected — see the doc
// block for the long form.
export const PARALLELISM_PINS = [
  {
    re: /\bisolate\s*:\s*false\b/,
    why: '`isolate: false` reuses one worker process across test files. It is the most dangerous entry here: the others cost wall-clock or reproduction rate, this one costs the conclusion — it silently invalidates the #1627 finding that cross-file module / global / $HOME / $TMPDIR leakage is structurally impossible, while leaving the suite green.',
  },
  {
    re: /\b(?:singleFork|singleThread)\s*:\s*true\b/,
    why: "`singleFork` / `singleThread` is vitest's documented switch for serializing a pool onto one reused worker. Same cross-file-state consequence as `isolate: false`, plus it removes all cross-worker contention.",
  },
  {
    re: /\bfileParallelism\s*:\s*false\b/,
    why: '`fileParallelism: false` is the top-level off switch: files run one after another, every cross-worker port collision disappears locally, and CI wall-clock roughly triples.',
  },
  {
    re: /\bmaxWorkers\s*:\s*['"]?1['"]?(?![\d.])/,
    why: '`maxWorkers: 1` leaves a single worker, which is `fileParallelism: false` by another name.',
  },
  {
    re: /\b(?:maxForks|minForks|maxThreads|minThreads)\s*:\s*['"]?1['"]?(?![\d.])/,
    why: '`maxForks` / `minForks` / `maxThreads` / `minThreads` pinned to 1 is the pool-level worker-count off switch — same effect as `maxWorkers: 1`, one nesting level down under `poolOptions`.',
  },
  {
    re: /\bmaxConcurrency\s*:\s*['"]?1['"]?(?![\d.])/,
    why: '`maxConcurrency: 1` caps concurrent tests within a file. It does not by itself serialize files, but it is a parallelism pin in the same config and removes the intra-file contention the load-sensitive budget rules exist to survive.',
  },
  {
    re: /\bpool\s*:/,
    why: "`pool:` — `pool: 'forks'` is ALREADY the resolved default, so setting it buys nothing, and the one plausible edit (flipping to `pool: 'threads'`) breaks the process-level $HOME / $TMPDIR isolation that test/_support/isolate-home.ts depends on: a worker thread's `process.env.HOME` write never reaches uv_os_homedir, so every test's \"isolated\" home collapses back onto the developer's real one.",
  },
];

/**
 * The band test, over a literal as written. Separators are stripped before the
 * comparison (`45_000` is port 45000), and anything that does not normalise to
 * a 4- or 5-digit run is not a port-shaped literal at all.
 */
export function portValue(raw) {
  if (!/^\d(?:_?\d)*$/.test(raw)) return null;
  const digits = raw.replace(/_/g, '');
  if (digits.length < 4 || digits.length > 5) return null;
  return Number(digits);
}

export function inBand(raw) {
  const value = portValue(raw);
  return value !== null && value >= EPHEMERAL_MIN && value <= EPHEMERAL_MAX;
}

/** 1-based line number of a character offset in `text`. */
function lineNumberAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Blank out `//` and block comments, preserving every byte offset and newline
 * so line numbers and `matchAll` indices stay exact. String and template
 * literals are tracked so a `//` or `/*` inside one is not mistaken for a
 * comment; with `{ strings: true }` their CONTENTS are blanked as well, while
 * the quote characters themselves are kept so the literal keeps its shape.
 *
 * Rule 3 needs the comment blanking because `operator/vitest.config.ts`
 * explains its own defaults in prose, and a comment saying "we do NOT set
 * `pool: 'threads'`" is not a pin. Rules 1 and 2 need both: they scanned raw
 * text, so `// we used to write ports: [45000, 45001] here` and
 * `const yaml = 'ports: [45000]'` each reported a violation that did not exist
 * — a false positive on a required gate, which is the failure mode this file
 * argues against at length. Blanking strings also makes the "port inside a URL
 * string" non-catch below structural rather than incidental.
 *
 * A template literal's `${…}` interpolations are blanked along with its text.
 * The failure that buys is a MISSED port position inside an interpolation,
 * never a spurious one, and a port literal written inside `${…}` does not
 * occur. A regex/division ambiguity is not worth resolving here either: the
 * consumers are a config object literal and test source, where a regex literal
 * containing `//` or an unbalanced quote does not occur.
 */
export function blankComments(text, { strings = false } = {}) {
  // `split('')`, not `Array.from`: the latter splits by code POINT while every
  // index below (`text[i]`, `out[i]`, `indexOf`) is a code UNIT offset, so one
  // surrogate pair anywhere in the file shifts every later write by a slot —
  // blanking a newline, or eating the first character of a real pin and
  // turning rule 3 into a false negative.
  const out = text.split('');
  let i = 0;
  let quote = null; // "'" | '"' | '`'
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        if (strings) {
          out[i] = ' ';
          if (i + 1 < text.length && text[i + 1] !== '\n') out[i + 1] = ' ';
        }
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i += 1;
        continue;
      }
      if (strings && ch !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i += 1) if (text[i] !== '\n') out[i] = ' ';
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Rule 2: the name this `Math.random` line belongs to, or null. */
function enclosingName(lines, idx) {
  const floor = Math.max(0, idx - DECLARATION_LOOKBACK_LINES);
  for (let i = idx; i >= floor; i -= 1) {
    const m = DECLARATION.exec(lines[i]);
    if (m) return m[1] ?? m[2];
  }
  return null;
}

/**
 * Rules 1 and 2 over one file's text. Pure: takes the source and the name to
 * report it under, returns `{ line, snippet }` violations. Exported so
 * `check-no-fixed-test-port.test.mjs` can drive it over fixtures without a
 * filesystem.
 */
export function scanText(text) {
  const violations = [];
  // Rules 1 and 2 match against CODE — comments and string contents blanked,
  // offsets preserved. The suppression marker and every reported snippet are
  // read off the RAW line: the marker only ever lives in a comment, and a
  // blanked snippet would show the reader an empty string.
  const code = blankComments(text, { strings: true });
  const lines = text.split('\n');
  const codeLines = code.split('\n');

  codeLines.forEach((line, idx) => {
    const raw = lines[idx] ?? '';
    if (raw.includes(ALLOW_MARKER)) return;

    let flagged = false;

    // Rule 1a — bind position: `.listen(<port>, …)`.
    for (const m of line.matchAll(LISTEN_LITERAL)) if (inBand(m[1])) flagged = true;
    // Rule 1b — port-key position, bare literal, key filtered by name.
    for (const m of line.matchAll(PORT_KEY_LITERAL)) {
      if (PORTISH_NAME.test(m[1]) && inBand(m[2])) flagged = true;
    }
    // Rule 1c — `const|let|var <port-ish name> = <literal>`, plain or defaulted.
    for (const m of line.matchAll(PORT_DECL_LITERAL)) {
      if (PORTISH_NAME.test(m[1]) && inBand(m[2])) flagged = true;
    }
    // Rule 2 — a guessed port is the same race, harder to reproduce.
    if (RANDOM_CALL.test(line)) {
      const name = enclosingName(codeLines, idx);
      if (name && PORTISH_NAME.test(name)) flagged = true;
    }

    if (flagged) violations.push({ line: idx + 1, snippet: raw.trim() });
  });

  // Rule 1d — port-key position, array literal: EVERY element counts. Run
  // over the whole file text, not line by line, because the array form is
  // routinely written multi-line and a per-line scan can never see across
  // the newline between the `ports: [` and its elements.
  for (const m of code.matchAll(PORT_KEY_ARRAY)) {
    if (!PORTISH_NAME.test(m[1])) continue;
    const contentStart = m.index + m[0].indexOf('[') + 1;
    for (const el of m[2].matchAll(ARRAY_ELEMENT)) {
      if (!inBand(el[1])) continue;
      const lineNo = lineNumberAt(code, contentStart + el.index);
      const snippet = lines[lineNo - 1] ?? '';
      if (snippet.includes(ALLOW_MARKER)) continue;
      violations.push({ line: lineNo, snippet: snippet.trim() });
    }
  }

  // One report line per line, however many rules fired on it.
  const seen = new Set();
  return violations.filter((v) => {
    if (seen.has(v.line)) return false;
    seen.add(v.line);
    return true;
  });
}

/**
 * Rule 3 over one config's text. Pins are matched against the comment-blanked
 * text; the suppression marker is read off the RAW line, because the marker
 * only ever lives *in* a comment and blanking would make the check
 * unreachable. The reported snippet is the raw line too — a blanked one would
 * show the reader an empty string.
 */
export function scanVitestConfig(text) {
  const raw = text.split('\n');
  const found = [];
  blankComments(text)
    .split('\n')
    .forEach((line, idx) => {
      if ((raw[idx] ?? '').includes(ALLOW_MARKER)) return;
      for (const pin of PARALLELISM_PINS) {
        if (!pin.re.test(line)) continue;
        found.push({ line: idx + 1, snippet: (raw[idx] ?? line).trim(), why: pin.why });
      }
    });
  return found;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `lstatSync`, not `statSync`: a symlinked directory under the test tree
    // would otherwise be followed, and one pointing at an ancestor recurses
    // until this process dies. A symlink is never something this guard needs
    // to read — whatever it points at is either already in the walk or outside
    // the tree we are policing.
    const s = lstatSync(full);
    if (s.isSymbolicLink()) continue;
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
 * workspace globs and not every workspace has a `test/` dir, so each candidate
 * is probed rather than assumed; `scripts/release/` is probed the same way.
 */
function scanRoots() {
  const roots = [];
  if (existsSync(TEST_ROOT)) roots.push(TEST_ROOT);
  // `scripts/release/**/*.test.ts` is in `nodeInclude` too — five real test
  // files in the default suite — so the guard has to look there as well.
  if (existsSync(RELEASE_SCRIPTS_ROOT)) roots.push(RELEASE_SCRIPTS_ROOT);
  for (const group of ['plugins', 'packages']) {
    const groupDir = join(OPERATOR_ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const candidate = join(groupDir, entry, 'test');
      if (existsSync(candidate) && lstatSync(candidate).isDirectory()) roots.push(candidate);
    }
  }
  return roots;
}

/** The guard is useless if it cannot find what it polices. Say so, loudly. */
function bail(...message) {
  for (const line of message) console.error(line);
  process.exit(1);
}

function main() {
  const roots = scanRoots();
  if (!existsSync(TEST_ROOT)) {
    bail(
      '✗ operator/test/ does not exist, so this guard scanned nothing.',
      '  That is the tree it exists to police. If the test tree moved,',
      '  move TEST_ROOT in operator/scripts/check-no-fixed-test-port.mjs with it.',
      '  Failing loudly rather than reporting a vacuous pass. See issue #1627.',
    );
  }
  if (roots.length === 0) {
    bail(
      '✗ This guard found no test tree to scan.',
      '  A green check from a guard that policed nothing reads as coverage it did',
      '  not provide, so this is a failure. See issue #1627.',
    );
  }

  const violations = [];
  let scannedFiles = 0;

  for (const root of roots) {
    for (const file of walk(root)) {
      scannedFiles += 1;
      const rel = relative(OPERATOR_ROOT, file).split('\\').join('/');
      const display = `operator/${rel}`;
      for (const v of scanText(readFileSync(file, 'utf8'))) {
        violations.push({ file: display, ...v });
      }
    }
  }

  if (scannedFiles === 0) {
    bail(
      '✗ This guard walked its scan roots and collected zero .ts files.',
      `  Roots walked: ${roots.map((r) => relative(OPERATOR_ROOT, r)).join(', ')}`,
      '  A green check from a guard that policed nothing reads as coverage it did',
      '  not provide, so this is a failure. See issue #1627.',
    );
  }

  // Rule 3 — vitest.config.ts only. vitest.hermetic.config.ts is deliberately
  // sequential and is never read here.
  if (!existsSync(VITEST_CONFIG)) {
    bail(
      '✗ operator/vitest.config.ts not found, so the parallelism rule (rule 3)',
      '  checked nothing. That file IS the subject of rule 3: the port rules are',
      '  load-bearing only while it leaves parallelism and isolation at their',
      '  defaults. If the config was renamed or moved, move VITEST_CONFIG in',
      '  operator/scripts/check-no-fixed-test-port.mjs with it. See issue #1627.',
    );
  }
  const parallelismViolations = scanVitestConfig(readFileSync(VITEST_CONFIG, 'utf8')).map((v) => ({
    file: 'operator/vitest.config.ts',
    ...v,
  }));

  if (violations.length === 0 && parallelismViolations.length === 0) {
    console.log('✓ No fixed ephemeral-range test ports, and suite parallelism is unpinned.');
    process.exit(0);
  }

  if (violations.length > 0) {
    console.error('✗ Fixed (or randomly guessed) 127.0.0.1 port inside the OS ephemeral');
    console.error('  range 32768–65535 detected in a test file. That band is the union of the');
    console.error('  Linux ip_local_port_range default (32768–60999) and the macOS ephemeral');
    console.error('  range (49152–65535). Vitest runs ~850 test files across 3 forked workers');
    console.error('  on CI, and those workers share one kernel-global port space, so a');
    console.error("  sibling's listen(0) can take this port between the moment the test picks");
    console.error('  it and the moment it binds. See issue #1627.\n');
    console.error('  Use one of the three sanctioned forms instead:');
    console.error('    1. The TEST ITSELF binds it: `listen(0, \'127.0.0.1\')`, then read the');
    console.error('       assigned port off `server.address().port`. This is atomic — there is');
    console.error('       no allocate-then-rebind window for a sibling worker to win. Always');
    console.error('       preferred where it is available.');
    console.error('    2. A CHILD PROCESS binds it (Anvil, Ponder, a spawned daemon): either a');
    console.error('       fixed port BELOW 32768, reserved in the port registry in');
    console.error('       test/release/tier-1/T1.2-harness-readiness-contract.ts (no window at');
    console.error('       all, but the number must be unique repo-wide), or');
    console.error("       `await allocateAnvilPort()` from '@test/chain/port-allocator.js' when");
    console.error('       a fixed reservation is impractical (many ports, or several instances');
    console.error('       inside one file) — that has a narrow allocate-then-rebind window.');
    console.error('    3. The assertion is "NOTHING is listening here": use a fixed port BELOW');
    console.error('       32768, with a comment saying why that port is expected to be free.\n');
    console.error('  Violations:');
    for (const v of violations) {
      console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
    }
  }

  if (parallelismViolations.length > 0) {
    if (violations.length > 0) console.error('');
    console.error('✗ Test-suite parallelism or per-file process isolation is pinned in');
    console.error('  operator/vitest.config.ts.');
    console.error('  The port rules above are load-bearing only while vitest actually runs test');
    console.error('  files in parallel, each in its own fresh process. Turning either off makes');
    console.error('  every cross-worker collision vanish locally and silently retires the reason');
    console.error('  those rules exist. If parallelism genuinely must change, that is a');
    console.error('  deliberate decision that should edit this guard in the same commit.');
    console.error('  See issue #1627.\n');
    console.error('  Violations:');
    for (const v of parallelismViolations) {
      console.error(`    ${v.file}:${v.line}  ${v.snippet}`);
      console.error(`      → ${v.why}`);
    }
  }

  process.exit(1);
}

// Run only when invoked as the CLI, so the test file can import the rules.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
