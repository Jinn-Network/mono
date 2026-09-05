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
 *      `var` whose name is port-ish — scalar (`const apiPort = 45000`), the
 *      defaulted form (`const portBase = opts.portBase ?? 45000`), or an array
 *      (`const ports = [60001, 60002]`, every element). The `.listen(` and
 *      array forms are matched against the WHOLE FILE TEXT rather than line by
 *      line, because both are routinely written across lines: `ports: [\n
 *      60001,\n]` and `srv.listen(\n  45007,\n)` are ordinary formatter
 *      output, and a per-line scan can never see across those newlines.
 *   2. No randomly-guessed port — a `Math.random` or `randomInt(` call whose
 *      own line, or whose nearest enclosing `function <name>` / `const <name>
 *      =` declaration within 10 lines, is named something port-ish. The walk
 *      up stops at a declaration whose line already ENDED IN `;`: a completed
 *      statement cannot contain a call written below it, so a correct sub-band
 *      reservation no longer adopts an unrelated `Math.random` nearby.
 *      Guessing is the same race as hard-coding, just with a wider blast
 *      radius and a lower reproduction rate.
 *   2b. No in-band literal RETURNED from that same port-ish block —
 *      `function pickPort() { return 45000; }`. Rule 2 caught that function
 *      when it computed the number and rule 1c caught the number when it was
 *      bound to a name, so the one form that escaped both was the constant
 *      handed straight back: the identical fixed port, one `return` away from
 *      a shape two other rules already reject (#3580). Same bounded
 *      enclosing-declaration walk as rule 2, so it inherits both of that
 *      walk's protections — the port-ish name filter and the stop at a
 *      completed statement — and both of its residual false positives below.
 *   3. No parallelism pin, and no isolation opt-out, in
 *      `operator/vitest.config.ts`.
 *
 * Rules 1 and 2 read CODE, not raw text: comments, string contents and regex
 * bodies are blanked (offsets preserved) before they run, so prose about the
 * band, a port array quoted inside a fixture string, and a port shape written
 * into a pattern are all invisible to them. This is the same treatment rule 3
 * has always had, and for the same reason — the runbook this guard ships with
 * actively teaches contributors to write about in-band ports.
 *
 * Rules 1 and 2 deliberately test POSITION ∧ VALUE-BAND, never either alone.
 * `operator/test/**` holds ~1,900 numeric literals that fall inside the band
 * and are not ports at all — timeouts (`50000`, `60000`), Hyperliquid price
 * fixtures (`'50000'`, `'51500'`), and hex-address substrings (`33333`,
 * `55555`, `44444`) — so a value-only rule is pure noise. It also holds 62
 * legitimate fixed port literals in genuine port positions, over the distinct
 * numbers 7331, 7332, 7333, 7340, 7342, 7350, 7351, 7360, 7388, 7389, 7390,
 * 7400, 7450, 7451, 7732, 7733, 7734, 7740, 7742, 7777, 9331, 9332, 17398,
 * 18532 and 18533, plus the
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
 * literal is normalised (separators stripped) before its band is tested. Rule
 * 3's worker-count pins get the same treatment, for the opposite failure: a
 * pin spelled `1` could not cross the `_` either, so `maxWorkers: 1_0` — ten
 * workers — matched the one-worker pin, on a required gate, with a message
 * that contradicted the value it was reading.
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
 * Inside a root, the walk collects `.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
 * `.jsx`, `.mjs` and `.cjs`, minus declaration files (`.d.ts` and friends).
 * The ROOT decides what is policed; an extension filter that quietly drops a
 * file inside a root the guard did successfully find is the same silent
 * under-scan as a moved test tree, one level down, and it is the one form of
 * it with no failure path. Collecting `.ts` alone skipped exactly two files —
 * `test/acceptance/_fixtures/spa-harness.tsx` and
 * `scripts/release/post-check-run-verdict.mjs` — neither of which holds an
 * in-band literal today; `.tsx` is the one that could bite, since the
 * acceptance tree already holds a React fixture and a `.tsx` harness binding a
 * fixed port is not an exotic shape.
 *
 * The guard fails loudly rather than passing vacuously when its subject is
 * missing: a renamed or moved `vitest.config.ts`, an absent `operator/test/`,
 * an `operator/test/` that is not a directory, or a scan that collects zero
 * files all exit non-zero. A guard that silently polices nothing is worse than
 * no guard, because the green check still reads as coverage. `runGuard` takes
 * the operator root as an argument and returns its exit code and output rather
 * than calling `process.exit` itself, so those paths and both exit codes are
 * pinned in `check-no-fixed-test-port.test.mjs` over throwaway directory trees.
 * The root is an argument and NOT an env override on purpose: an env override
 * would be a way to make a required gate vacuous from a workflow edit, which
 * is precisely what these paths exist to stop.
 *
 * Suppression: a line carrying the inline comment
 * `lint:no-fixed-test-port-allow` is skipped, matching the house
 * `lint:no-error-leak-allow` convention. It applies to all three rules. For
 * every form written across lines — a multi-line array, a multi-line
 * `.listen(` — the marker goes on the LITERAL's line, not on the `ports: [` or
 * `.listen(` line above it, because the literal is where the violation is
 * reported.
 * For rule 3 the marker is read off the raw line rather than the blanked one,
 * since a marker only ever lives inside a comment. It is expected to have ZERO
 * consumers on landing: it exists for a future case nobody has met yet, not
 * for the ones this guard was written against.
 *
 * ── What this guard deliberately does NOT catch ─────────────────────────────
 *
 * Named so that the doc, the runbook, and this file agree on the size of the
 * claim. Each is a known gap, not an oversight; none has a live instance in
 * the tree today. The FALSE POSITIVES block at the end of the list is the one
 * that costs a contributor time rather than coverage, so it is named too —
 * this list used to enumerate false negatives only, which understated the
 * shape of the residual risk on a required gate.
 *
 *   - Anything inside a comment, a string literal, or a regex literal. Rules 1
 *     and 2 match against comment-, string- and regex-blanked text, so a port
 *     inside a URL string (`fetch('http://127.0.0.1:45020/health')`), a port
 *     array quoted into a YAML fixture (`const yaml = 'ports: [45000]'`), a
 *     commented-out `srv.listen(45000)` and a `/apiPort: 45000/` pattern are
 *     all invisible to them. The stated invariant is about port-shaped
 *     *syntactic positions*, which none of those is; a rule that read them
 *     would flag ports behind a fully mocked `fetch` (there is one such
 *     literal in the tree today) and prose that merely discusses the band,
 *     i.e. it would condemn code carrying no hazard and redden a required
 *     gate. Rule 3 blanks comments and regex bodies but not string contents —
 *     its subject is one config object literal, where `exclude: [/…/]` is an
 *     ordinary idiom and a pin written inside a string is not.
 *   - A port position inside a template literal's `${…}` interpolation. The
 *     blanking does not parse interpolations back out; the failure is a missed
 *     literal, never a spurious one.
 *   - A returned in-band literal whose enclosing declaration is not port-ish
 *     and does not become so within the 10-line lookback — `function make() {
 *     return 45000; }` handed to a `.listen(` elsewhere. Rule 2b filters on
 *     the same name test as rules 1 and 2, and a value-only rule over every
 *     `return` in the tree is the noise the POSITION ∧ VALUE-BAND design
 *     exists to avoid.
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
 *   - A defaulted ARRAY initializer — `const ports = opts.ports ?? [45000]`.
 *     Rule 1e wants the `[` adjacent to the `=`, where rule 1c's `??` / `||`
 *     prefix applies to a scalar only.
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
 *
 * ── …and the false positives it can still produce ───────────────────────────
 *
 * Neither has a live instance either, and `lint:no-fixed-test-port-allow` on
 * the reported line is the resolution for both. They are named because a
 * failure on a required gate that points at a line carrying no port sends a
 * contributor looking for a bug that is not there.
 *
 *   - Rule 2 attributing a random call by PROXIMITY. The walk up now stops at
 *     a declaration that already ended in `;`, which is the class that used to
 *     hit a correct sub-band reservation. What remains is a port-ish
 *     declaration whose block has already CLOSED within the 10-line lookback —
 *     `function pickPort() { … }` followed by an unrelated `Math.random()`.
 *     Closing that needs brace tracking, which is more machine than a
 *     heuristic rule warrants. Rule 2b shares the walk and therefore this
 *     gap: an unrelated in-band `return` under a closed port-ish block reads
 *     the same way.
 *   - A regex literal read as division. `blankComments` decides from the
 *     preceding significant character, so `if (x) /re/.test(y)` reads as
 *     division and the pattern body is scanned as code. It takes an in-band
 *     literal in a port shape INSIDE such a pattern to bite. The reverse
 *     mistake — division read as a regex — only blanks, so it can only miss.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the operator root from the script's location so the check works
// regardless of where it's invoked from (yarn runs with cwd=operator/, but a
// direct `node operator/scripts/...` from the repo root must work too).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OPERATOR_ROOT = join(SCRIPT_DIR, '..');

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
const PORT_DECL = `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*`;
const PORT_DECL_LITERAL = new RegExp(
  `${PORT_DECL}(?:[^;\\n]*?(?:\\?\\?|\\|\\|)\\s*)?${NUM}`,
  'g',
);
// Rule 1e — `const ports = [45000, 45001]`, where rule 1c's initializer and
// rule 1d's array meet. Neither reached it: the `[` stops 1c's literal, and a
// `const` binding is not the `name:` object key 1d wants. Hoisting a `ports:
// [...]` argument to a named const above the call is an ordinary refactor, so
// this is the shape a future author writes naturally rather than an exotic
// one. Same whole-file treatment and same 400-character bound as 1d, for the
// same reasons.
const PORT_DECL_ARRAY = new RegExp(`${PORT_DECL}\\[([^\\]]{0,${PORT_KEY_ARRAY_MAX}})\\]`, 'g');

// `randomInt` as well as `Math.random`: the failure text advertises this rule
// as catching a "randomly guessed" port, and `crypto.randomInt(40000, 60000)`
// is the same guess with a better RNG.
const RANDOM_CALL = /Math\.random|\brandomInt\s*\(/;
// Rule 2b — `return 45000` from inside a port-ish declaration. The same fixed
// port as `const apiPort = 45000` (rule 1c), one `return` away from it, and
// the shape rule 2 stops one step short of: it catches `pickPort()` when the
// number is guessed, not when it is written down. Shares rule 2's bounded
// enclosing-declaration walk, so `function pickTransport()` is filtered out by
// name and a completed statement stops the attribution, exactly as there.
const RETURN_LITERAL = new RegExp(`\\breturn\\s+${NUM}`, 'g');
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

// A worker-count pin as vitest actually accepts it: a bare or quoted integer.
// The literal is CAPTURED rather than spelled `1`, because `\d` cannot cross a
// separator and `1_0` — ten workers — otherwise matched the one-worker pin, on
// a required gate, with a message contradicting the value it was reading.
// Rules 1 and 2 have normalised separators since the first round of review;
// this is the same treatment, applied where it was missed.
const PIN_COUNT = `['"]?${NUM}['"]?`;

// Rule 3: a parallelism pin or isolation opt-out in vitest.config.ts. Each
// pattern carries the sentence that explains why it is rejected — see the doc
// block for the long form. A pin carrying `pinnedValue` matches only when its
// captured literal NORMALISES to that value.
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
    re: new RegExp(`\\bmaxWorkers\\s*:\\s*${PIN_COUNT}`),
    pinnedValue: 1,
    why: '`maxWorkers: 1` leaves a single worker, which is `fileParallelism: false` by another name.',
  },
  {
    re: new RegExp(`\\b(?:maxForks|minForks|maxThreads|minThreads)\\s*:\\s*${PIN_COUNT}`),
    pinnedValue: 1,
    why: '`maxForks` / `minForks` / `maxThreads` / `minThreads` pinned to 1 is the pool-level worker-count off switch — same effect as `maxWorkers: 1`, one nesting level down under `poolOptions`.',
  },
  {
    re: new RegExp(`\\bmaxConcurrency\\s*:\\s*${PIN_COUNT}`),
    pinnedValue: 1,
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
/** The digits of a numeric literal as written, separators stripped, or null. */
function literalValue(raw) {
  if (!/^\d(?:_?\d)*$/.test(raw)) return null;
  return raw.replace(/_/g, '');
}

export function portValue(raw) {
  const digits = literalValue(raw);
  if (digits === null || digits.length < 4 || digits.length > 5) return null;
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
 * occur.
 *
 * REGEX LITERALS are tracked, and their bodies are blanked in BOTH modes — a
 * pattern is data, like a string, and a port shape or a rule-3 pin written
 * inside one is not the thing either rule is looking for. Tracking them is not
 * cosmetic: an untracked regex leaks its own delimiters into the machine. A
 * `'` or `"` inside one opened a string state, and a BACKTICK inside one
 * opened a template state that nothing bounded — a template literal may span
 * lines, so the span ran to the next backtick anywhere in the file and every
 * line between was blanked and never scanned. That was live in the tree, over
 * four real lines. A regex literal, unlike a template literal, cannot contain
 * a raw newline, so tracking it bounds the state by construction.
 *
 * The regex/division ambiguity is resolved by the preceding significant
 * character (see `REGEX_CANNOT_FOLLOW`), and it is resolved in the SAFE
 * direction: reading a division as a regex start blanks the rest of that line,
 * which can only MISS a port position, while the newline bound stops any
 * mistake escaping the line that made it. Reading a regex as division is the
 * behaviour this function had all along.
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
      // A `'` or `"` literal cannot contain a raw newline, so an apparent
      // opener that reaches one was never a string: it is a `'` or `"` inside
      // something this machine misread — a regex whose opening `/` was taken
      // for division, say. Regex literals ARE tracked now, so this is a
      // backstop rather than the primary defence, but it stays: it bounds any
      // such desync to the line that started it instead of inverting
      // code/string classification for the rest of the file. A
      // backslash-newline line continuation still works: the `\\` branch above
      // consumes the newline before this test ever sees it.
      if (ch === '\n' && quote !== '`') {
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
    // A regex literal, but only where one may begin. Both comment forms are
    // tested first, exactly as the lexer does: `//` after an `=` is a line
    // comment, not an empty regex, and a regex cannot start with `*`.
    if (ch === '/' && regexMayStartAt(out, i)) {
      const end = regexEnd(text, i);
      if (end !== -1) {
        // Blanked in both modes: `exclude: [/…/]` is a real vitest idiom, so a
        // rule-3 pin written inside a pattern is a shape that actually occurs.
        // The delimiters are kept, as a string's quotes are.
        for (let k = i + 1; k < end; k += 1) out[k] = ' ';
        i = end + 1;
        while (i < text.length && /[a-z]/.test(text[i])) i += 1; // flags
        continue;
      }
      // Unterminated before the newline, so it was never a regex literal
      // (a stray `/`, JSX's `</`, a half-written edit). Read it as code and
      // let the scan carry on down the line.
    }
    i += 1;
  }
  return out.join('');
}

// Characters after which a `/` is DIVISION, not the start of a regex literal:
// the end of a value. Everything else — an operator, `(`, `,`, `:`, `=>`, the
// start of the file — may be followed by one. `)` and `]` are listed with the
// value characters, so `if (x) /re/.test(y)` reads as division; that is the
// pre-existing behaviour and it errs towards scanning, not towards blanking.
const REGEX_CANNOT_FOLLOW = /[\w$)\]'"`]/;
// …except after a keyword, which ends in word characters but is not a value.
const REGEX_MAY_FOLLOW_KEYWORD =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/** Whether the `/` at `at` opens a regex literal, judged from what precedes it. */
function regexMayStartAt(out, at) {
  let j = at - 1;
  while (j >= 0 && /\s/.test(out[j])) j -= 1;
  if (j < 0) return true; // the start of the file
  if (!REGEX_CANNOT_FOLLOW.test(out[j])) return true;
  if (!/[\w$]/.test(out[j])) return false; // `)`, `]`, or a closing quote
  // A word: a keyword may precede a regex, an identifier may not. Only the
  // trailing word is read — slicing the whole prefix here would make the scan
  // quadratic in a file with many division operators.
  let start = j;
  while (start >= 0 && /[\w$]/.test(out[start])) start -= 1;
  if (start >= 0 && out[start] === '.') return false; // `obj.in`, a property
  return REGEX_MAY_FOLLOW_KEYWORD.test((start >= 0 ? out[start] : '') + out.slice(start + 1, j + 1).join(''));
}

/**
 * The offset of the `/` closing the regex literal opened at `at`, or -1 if the
 * line ends first — a regex literal cannot contain a raw newline, which is what
 * bounds every mistake this machine can make about one.
 */
function regexEnd(text, at) {
  let inClass = false;
  for (let j = at + 1; j < text.length; j += 1) {
    const c = text[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      if (text[j + 1] === '\n' || j + 1 >= text.length) return -1;
      j += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '/') return j;
  }
  return -1;
}

/**
 * Rule 2: the name this `Math.random` line belongs to, or null.
 *
 * The walk up is bounded (an unbounded one attributes a random call to the
 * file's first declaration), and it stops at a declaration whose line already
 * ENDED IN `;`. Proximity alone was enough before, so a correct sub-band
 * reservation — `const apiPort = 7331;` — adopted any unrelated `Math.random`
 * written within ten lines below it and reddened a required gate on a line
 * that has nothing to do with a port. A completed statement cannot contain
 * something written after it; an unterminated one (`function pickPort() {`,
 * `const pickPort = () => {`, a continued `const apiPort =`) still can, which
 * is every shape this rule is actually aimed at.
 */
function enclosingName(lines, idx) {
  const own = DECLARATION.exec(lines[idx]);
  if (own) return own[1] ?? own[2];
  const floor = Math.max(0, idx - DECLARATION_LOOKBACK_LINES);
  for (let i = idx - 1; i >= floor; i -= 1) {
    const m = DECLARATION.exec(lines[i]);
    if (!m) continue;
    if (lines[i].trimEnd().endsWith(';')) return null;
    return m[1] ?? m[2];
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

  // Report a violation at the line holding the offset, honouring the marker on
  // that line. Used by every rule that matches over the whole file text: the
  // literal, not the shape that introduced it, is where the marker goes.
  const reportAt = (offset) => {
    const lineNo = lineNumberAt(code, offset);
    const snippet = lines[lineNo - 1] ?? '';
    if (snippet.includes(ALLOW_MARKER)) return;
    violations.push({ line: lineNo, snippet: snippet.trim() });
  };

  codeLines.forEach((line, idx) => {
    const raw = lines[idx] ?? '';
    if (raw.includes(ALLOW_MARKER)) return;

    let flagged = false;

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
    // Rule 2b — a written-down port returned from the same port-ish block.
    if (!flagged) {
      for (const m of line.matchAll(RETURN_LITERAL)) {
        if (!inBand(m[1])) continue;
        const name = enclosingName(codeLines, idx);
        if (name && PORTISH_NAME.test(name)) flagged = true;
      }
    }

    if (flagged) violations.push({ line: idx + 1, snippet: raw.trim() });
  });

  // Rule 1a — bind position: `.listen(<port>, …)`. Run over the whole file
  // text for the same reason rules 1d and 1e are: `srv.listen(\n  45007,\n)`
  // is ordinary formatter output, and a per-line scan can never see across the
  // newline between the call and its argument.
  for (const m of code.matchAll(LISTEN_LITERAL)) {
    if (inBand(m[1])) reportAt(m.index + m[0].length - m[1].length);
  }

  // Rules 1d and 1e — an array literal in a port position: EVERY element
  // counts. Both capture the name in group 1 and the bracket contents in
  // group 2, so one loop drives them: 1d from a port-ish object key, 1e from a
  // port-ish `const` / `let` / `var` binding.
  for (const re of [PORT_KEY_ARRAY, PORT_DECL_ARRAY]) {
    for (const m of code.matchAll(re)) {
      if (!PORTISH_NAME.test(m[1])) continue;
      // The match ends `[` + group 2 + `]`, so the contents start there. An
      // `indexOf('[')` would find the wrong bracket in `const ports: number[]
      // = [45000]` and in a nested `ports: [[45004], …]`.
      const contentStart = m.index + m[0].length - m[2].length - 1;
      for (const el of m[2].matchAll(ARRAY_ELEMENT)) {
        if (inBand(el[1])) reportAt(contentStart + el.index);
      }
    }
  }

  // One report line per line, however many rules fired on it, and in file
  // order — three of the rules run over the whole file after the per-line
  // pass, so insertion order is not reading order.
  const seen = new Set();
  return violations
    .sort((a, b) => a.line - b.line)
    .filter((v) => {
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
        for (const m of line.matchAll(new RegExp(pin.re, 'g'))) {
          // Check every count: a non-pin such as maxForks: 10 must not hide
          // a later minForks: 1 on the same line.
          if (pin.pinnedValue !== undefined && Number(literalValue(m[1])) !== pin.pinnedValue) continue;
          found.push({ line: idx + 1, snippet: (raw[idx] ?? line).trim(), why: pin.why });
          break; // One report per pin rule per line.
        }
      }
    });
  return found;
}

// Every extension the TypeScript/JavaScript toolchain compiles, minus
// declaration files. The SCAN ROOT decides what is policed; an extension
// filter that quietly drops a file inside a root the guard did successfully
// find is the same silent under-scan the bail paths below exist to prevent,
// one level down. `.ts` alone skipped `test/acceptance/_fixtures/spa-harness.tsx`
// and `scripts/release/post-check-run-verdict.mjs`, both inside declared roots.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const DECLARATION_EXTENSIONS = ['.d.ts', '.d.mts', '.d.cts'];

function isSourceFile(entry) {
  if (DECLARATION_EXTENSIONS.some((ext) => entry.endsWith(ext))) return false;
  return SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext));
}

function isDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every source file under `dir`, skipping `skipDir` entirely. Exported so the
 * fixture table can drive it over a throwaway tree.
 */
export function walk(dir, skipDir = null, out = []) {
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
      if (full === skipDir) continue; // fixtures are data, not tests
      walk(full, skipDir, out);
    } else if (isSourceFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The test trees vitest actually collects from, under `operatorRoot`.
 * `plugins/` and `packages/` are workspace globs and not every workspace has a
 * `test/` dir, so each candidate is probed rather than assumed;
 * `scripts/release/` is probed the same way. Exported for the fixture table.
 */
export function scanRoots(operatorRoot) {
  const roots = [];
  const testRoot = join(operatorRoot, 'test');
  if (isDirectory(testRoot)) roots.push(testRoot);
  // `scripts/release/**/*.test.ts` is in `nodeInclude` too — five real test
  // files in the default suite — so the guard has to look there as well.
  const releaseRoot = join(operatorRoot, 'scripts', 'release');
  if (isDirectory(releaseRoot)) roots.push(releaseRoot);
  for (const group of ['plugins', 'packages']) {
    const groupDir = join(operatorRoot, group);
    if (!isDirectory(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const candidate = join(groupDir, entry, 'test');
      if (isDirectory(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

/**
 * The whole guard over one operator root, as data: `{ exitCode, stdout,
 * stderr }`. `main` is a print-and-exit wrapper over this, so the fixture
 * table can drive every bail path and both exit codes over a throwaway tree
 * instead of the real one — those paths carry the guard's central safety claim
 * and were the only part of it with no regression guard.
 *
 * Taking the root as an argument rather than reading an env override is
 * deliberate: an env override would be a way to make a required gate vacuous
 * from a workflow edit, which is exactly what the bail paths exist to stop.
 */
export function runGuard(operatorRoot) {
  const stdout = [];
  const stderr = [];
  /** The guard is useless if it cannot find what it polices. Say so, loudly. */
  const bail = (...message) => {
    stderr.push(...message);
    return { exitCode: 1, stdout, stderr };
  };

  const testRoot = join(operatorRoot, 'test');
  const vitestConfig = join(operatorRoot, 'vitest.config.ts');
  const roots = scanRoots(operatorRoot);

  if (!existsSync(testRoot)) {
    return bail(
      '✗ operator/test/ does not exist, so this guard scanned nothing.',
      '  That is the tree it exists to police. If the test tree moved,',
      '  move the paths in scanRoots() in operator/scripts/check-no-fixed-test-port.mjs',
      '  with it. Failing loudly rather than reporting a vacuous pass. See issue #1627.',
    );
  }
  if (!isDirectory(testRoot)) {
    return bail(
      '✗ operator/test/ is not a directory, so the primary test tree was not scanned.',
      '  Other scan roots cannot substitute for that tree. See issue #1627.',
    );
  }

  const violations = [];
  let scannedFiles = 0;

  for (const root of roots) {
    for (const file of walk(root, join(testRoot, 'fixtures'))) {
      scannedFiles += 1;
      const rel = relative(operatorRoot, file).split('\\').join('/');
      const display = `operator/${rel}`;
      for (const v of scanText(readFileSync(file, 'utf8'))) {
        violations.push({ file: display, ...v });
      }
    }
  }

  if (scannedFiles === 0) {
    return bail(
      '✗ This guard walked its scan roots and collected zero source files.',
      `  Roots walked: ${roots.map((r) => relative(operatorRoot, r)).join(', ')}`,
      '  A green check from a guard that policed nothing reads as coverage it did',
      '  not provide, so this is a failure. See issue #1627.',
    );
  }

  // Rule 3 — vitest.config.ts only. vitest.hermetic.config.ts is deliberately
  // sequential and is never read here.
  if (!existsSync(vitestConfig)) {
    return bail(
      '✗ operator/vitest.config.ts not found, so the parallelism rule (rule 3)',
      '  checked nothing. That file IS the subject of rule 3: the port rules are',
      '  load-bearing only while it leaves parallelism and isolation at their',
      '  defaults. If the config was renamed or moved, move the vitest.config.ts',
      '  path in runGuard() in operator/scripts/check-no-fixed-test-port.mjs with',
      '  it. See issue #1627.',
    );
  }
  const parallelismViolations = scanVitestConfig(readFileSync(vitestConfig, 'utf8')).map((v) => ({
    file: 'operator/vitest.config.ts',
    ...v,
  }));

  if (violations.length === 0 && parallelismViolations.length === 0) {
    stdout.push('✓ No fixed ephemeral-range test ports, and suite parallelism is unpinned.');
    return { exitCode: 0, stdout, stderr };
  }

  if (violations.length > 0) {
    stderr.push(
      '✗ Fixed (or randomly guessed) 127.0.0.1 port inside the OS ephemeral',
      '  range 32768–65535 detected in a test file. That band is the union of the',
      '  Linux ip_local_port_range default (32768–60999) and the macOS ephemeral',
      '  range (49152–65535). Vitest runs ~850 test files across 3 forked workers',
      '  on CI, and those workers share one kernel-global port space, so a',
      "  sibling's listen(0) can take this port between the moment the test picks",
      '  it and the moment it binds. See issue #1627.\n',
      '  Use one of the three sanctioned forms instead:',
      "    1. The TEST ITSELF binds it: `listen(0, '127.0.0.1')`, then read the",
      '       assigned port off `server.address().port`. This is atomic — there is',
      '       no allocate-then-rebind window for a sibling worker to win. Always',
      '       preferred where it is available.',
      '    2. A CHILD PROCESS binds it (Anvil, Ponder, a spawned daemon): either a',
      '       fixed port BELOW 32768, reserved in the port registry in',
      '       test/release/tier-1/T1.2-harness-readiness-contract.ts (no window at',
      '       all, but the number must be unique repo-wide), or',
      "       `await allocateAnvilPort()` from '@test/chain/port-allocator.js' when",
      '       a fixed reservation is impractical (many ports, or several instances',
      '       inside one file) — that has a narrow allocate-then-rebind window.',
      '    3. The assertion is "NOTHING is listening here": use a fixed port BELOW',
      '       32768, with a comment saying why that port is expected to be free.\n',
      '  Violations:',
      ...violations.map((v) => `    ${v.file}:${v.line}  ${v.snippet}`),
    );
  }

  if (parallelismViolations.length > 0) {
    if (violations.length > 0) stderr.push('');
    stderr.push(
      '✗ Test-suite parallelism or per-file process isolation is pinned in',
      '  operator/vitest.config.ts.',
      '  The port rules above are load-bearing only while vitest actually runs test',
      '  files in parallel, each in its own fresh process. Turning either off makes',
      '  every cross-worker collision vanish locally and silently retires the reason',
      '  those rules exist. If parallelism genuinely must change, that is a',
      '  deliberate decision that should edit this guard in the same commit.',
      '  See issue #1627.\n',
      '  Violations:',
    );
    for (const v of parallelismViolations) {
      stderr.push(`    ${v.file}:${v.line}  ${v.snippet}`, `      → ${v.why}`);
    }
  }

  return { exitCode: 1, stdout, stderr };
}

function main() {
  const { exitCode, stdout, stderr } = runGuard(OPERATOR_ROOT);
  for (const line of stdout) console.log(line);
  for (const line of stderr) console.error(line);
  process.exit(exitCode);
}

// Run only when invoked as the CLI, so the test file can import the rules.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
