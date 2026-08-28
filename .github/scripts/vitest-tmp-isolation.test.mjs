// Holds the temp-directory sweep seam wired across every Vitest suite in the repository.
//
// The seam itself is three files in `test-support/tmp-isolation/`, shared by every suite under
// `packages/`, plus the operator's own home-plus-temp variant in `operator/test/_support/`. Both
// only work when a config names them in `setupFiles` and `globalSetup`, and a config that names
// neither leaks every directory its tests create with `mkdtemp(join(tmpdir(), …))` — measured at
// 361 directories per green `packages/layer` run before this gate existed (issues #2792, #2822).
//
// Per-suite behavioural coverage would mean one near-identical test file in fifty packages. This
// reads the configs instead: it goes red when any existing suite's wiring is removed AND when a new
// Vitest config arrives without it, which a per-suite test cannot do. The seam's own behaviour is
// covered by `test-support/tmp-isolation/tmp-isolation.test.ts`, which runs under
// `packages/benchmark-product/core`.
//
// What reading the configs cannot see is whether a wired suite still STARTS. That gap was not
// hypothetical: `packages/indexer/explorer` satisfied every assertion below while all 34 of its
// test files failed to load, because a `jsdom` suite resolves its setup files through Vite's web
// transform pipeline, which serves a module outside the Vite root under a `/@fs/` URL and refuses
// the ones `server.fs.allow` does not cover. The seam sits three levels above that package and
// Explorer's Vite root is the package directory, so every file died on
// `Cannot find module '/@fs/…/isolate-tmp.ts'`. The Node-environment suites never take that path,
// which is why the other ~50 configs take the same relative wiring and load it fine.
//
// The behavioural proof stays where it belongs — each package's own CI job runs its suite, and
// Explorer's went red. What this gate adds is the precondition check, so the NEXT non-Node config
// wired against a seam outside its own directory is caught at wiring time with the reason
// attached, rather than at whichever job happens to run that package: see
// `configs that cannot reach the seam they name` below.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

/** Directories that never hold a first-party suite this gate governs. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/**
 * The seam each root wires, as the repo-relative path its `setupFiles`/`globalSetup` entries must
 * resolve to. `packages/` shares one copy; the operator carries its own because it isolates `$HOME`
 * as well as `$TMPDIR` and names its managed roots differently.
 */
const SEAMS = [
  {
    root: 'packages',
    setup: 'test-support/tmp-isolation/isolate-tmp.ts',
    global: 'test-support/tmp-isolation/global-tmp-root.ts',
  },
  {
    root: 'operator',
    setup: 'operator/test/_support/isolate-home.ts',
    global: 'operator/test/_support/global-tmp-root.ts',
  },
];

/** Vitest configs under `directory`, repo-relative and sorted. */
export function findVitestConfigs(directory, base = root) {
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
      } else if (/^vitest\..*config\.(?:ts|mts|js|mjs)$/u.test(entry.name) || entry.name === 'vitest.config.ts') {
        found.push(relative(base, child).split('\\').join('/'));
      }
    }
  };
  walk(resolve(base, directory));
  return found.sort();
}

/**
 * The index of the character that closes the regex literal opened at `start` — its unescaped
 * closing `/`, or the newline that bounds it, or `source.length`.
 *
 * A `/` opens a regex only where a value may begin, which `regexStartsAt` decides. Inside the
 * literal a `/` in a character class does not close it, so `[...]` spans are tracked; a regex
 * literal cannot hold an unescaped newline, so one bounds the scan the same way it bounds a
 * `'`/`"` string.
 */
function regexLiteralEnd(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') return index;
    if (character === '\\') index += 1;
    else if (inClass) inClass = character !== ']';
    else if (character === '[') inClass = true;
    else if (character === '/') return index;
  }
  return source.length;
}

/** Keywords a regex literal may directly follow. */
const REGEX_PRECEDING_KEYWORDS = [
  'typeof',
  'return',
  'delete',
  'yield',
  'await',
  'void',
  'case',
  'else',
  'new',
  'in',
  'of',
  'do',
];

/** The index of the last non-whitespace character at or before `from`, or `-1`. */
function previousSignificant(source, from) {
  let back = from;
  while (back >= 0 && /\s/u.test(source[back])) back -= 1;
  return back;
}

/**
 * Whether the token ending at `back` is one of the keywords above, rather than the tail of a longer
 * identifier or a property named after one.
 *
 * Both sides need a boundary. Without the leading one `typeof` ends in `of`; without rejecting a
 * preceding `.` — or `?.`, or one written with spaces around it — `opts.in / 2` reads as `in`, and
 * every one of `in`, `of`, `new`, `delete`, `void`, `case` and `do` is a legal property name.
 * Reading one as a keyword consumes the division as a regex, which is the fail-open this whole
 * back-scan exists to prevent.
 */
function keywordEndsAt(source, back) {
  return REGEX_PRECEDING_KEYWORDS.some((keyword) => {
    if (source.slice(back - keyword.length + 1, back + 1) !== keyword) return false;
    const before = previousSignificant(source, back - keyword.length);
    return before < 0 || !/[\w$.]/u.test(source[before]);
  });
}

/**
 * Whether a value may begin at the position just after `back` — where `back` is the index of the
 * previous significant character, or `-1` at the start of the source.
 *
 * This is the usual heuristic for a scanner with no expression parser: a value may begin after an
 * operator, a separator, an opening bracket, or one of the keywords above, and not after something
 * that can end an operand. Closing brackets are read as operands, so `f(x) / 2` is division; a
 * regex directly after one — `(a + b) /re/.test(c)` — is not valid code anyway.
 *
 * Two characters are ambiguous on their own and are resolved by looking behind them:
 *
 * `--`/`++` read the wrong way round from the character alone: the trailing `-` of `x-- / 2` looks
 * like an operator. So a `+`/`-` doubled with the character before it counts as an operand end.
 *
 * `!` is both the prefix logical not, after which a regex is ordinary (`!/re/.test(x)`), and
 * TypeScript's postfix non-null assertion, after which `opts.value! / 2` is a division. Neither
 * reading is right unconditionally, so the same question is asked one token further back: a `!`
 * that itself sits where a value may begin is the prefix operator, and one that follows an operand
 * is the assertion.
 *
 * Both matter for the same reason: consuming a division as a regex takes the rest of its line —
 * including any structure and, where the line ends in a comment, the first `/` of its `//` — which
 * hands the comment's prose back as live source in miniature (#3027).
 */
function valueMayBeginAfter(source, back) {
  if (back < 0) return true;
  const character = source[back];
  if ((character === '+' || character === '-') && source[back - 1] === character) return false;
  if (character === '!') return valueMayBeginAfter(source, previousSignificant(source, back - 1));
  if ('(,=:[&|?{;+-*%~^<>'.includes(character)) return true;
  return keywordEndsAt(source, back);
}

/**
 * Whether the `/` at `index` opens a regex literal rather than a division.
 *
 * Whatever this still misreads consumes at most one line, because `regexLiteralEnd` and
 * `quotedSpanEnd` both stop at a newline. What that line costs is bounded separately by each
 * caller: `stripComments` can emit the tail of a mis-read line verbatim, and `projectEntryRanges`
 * drops the one `projects` entry whose braces that line took, not the array.
 */
function regexStartsAt(source, index) {
  return valueMayBeginAfter(source, previousSignificant(source, index - 1));
}

/**
 * The index of the character that closes the quoted span opened at `start` — the matching quote, or
 * the newline that bounds it, or `source.length`.
 *
 * A `'`/`"` string cannot hold an unescaped newline, so ending the span at one bounds any mis-read
 * to a single line. Template literals really do span lines, so only `'` and `"` take the bound.
 *
 * The hazard is a quote the scanner cannot pair off — most often one inside a regex literal,
 * `/['"]/u`. `regexStartsAt` recognizes those where a value may begin, which is every position a
 * config actually writes one; the newline bound is what backstops the rest, and it is the reason a
 * mis-read costs one line rather than the file. Unbounded, such a quote swallowed everything up to
 * the next one anywhere in the source: in `stripComments` that handed later comments back as live
 * source, and in the balanced scanners it ran past a `projects` entry's closing brace and dropped
 * every range, putting each allowance and seam path back in one scope (issues #3027, #3154).
 */
function quotedSpanEnd(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (quote !== '`' && source[index] === '\n') return index;
    index += source[index] === '\\' ? 2 : 1;
  }
  return index;
}

/**
 * `source` with line and block comments replaced by whitespace, preserving offsets and line
 * structure so the readers below can keep matching over a plain string.
 *
 * Every reader here matches the raw source, so without this a commented-out entry reads exactly
 * like a live one: prefixing `// ` to a config's `setupFiles` line left the wiring gate green while
 * the suite resumed leaking (issue #3027). Quoted text is skipped, so a `//` inside a path or URL
 * is not mistaken for a comment.
 *
 * Stripping also protects the balanced scanners below, which share this pass's quote and regex
 * awareness but not its comment awareness. These configs are prose-heavy: an apostrophe in a
 * comment inside a multi-line array opens a phantom string that swallows the closing bracket, and
 * a stray `]` in a comment closes the array early. Either one drops a real seam entry and reds a
 * correctly wired config.
 *
 * Regex literals are passed through verbatim rather than blanked: they preserve offsets either
 * way, and every reader below skips them itself, so leaving them intact keeps this pass to the one
 * job its name states. A comment marker wins over a regex — `//` never opens a regex literal, and
 * `/*` cannot start a valid one — so the comment checks run first.
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const stop = Math.min(quotedSpanEnd(source, index) + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      const stop = newline === -1 ? source.length : newline;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/gu, ' ');
      index = stop;
      continue;
    }
    if (char === '/' && regexStartsAt(source, index)) {
      const stop = Math.min(regexLiteralEnd(source, index) + 1, source.length);
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The index of the `close` that balances an `open` already consumed at `start - 1`, or `-1` when
 * the literal is never terminated. Quote- and regex-aware, so a bracket inside a quoted entry or a
 * regex character class does not close it.
 *
 * Quotes follow `stripComments`' rule, single-sourced in `quotedSpanEnd`: a `'`/`"` span ends at a
 * newline, a backtick span does not. Without that bound an unpairable quote runs past the intended
 * close and the literal comes back truncated or missing.
 */
function balancedEnd(source, start, open, close) {
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const character = source[i];
    if (character === "'" || character === '"' || character === '`') i = quotedSpanEnd(source, i);
    else if (character === '/' && regexStartsAt(source, i)) i = regexLiteralEnd(source, i);
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Each `open`…`close` literal that follows a `key:` in `source`, as `{ inner, start }` — the raw
 * inner text and the offset it begins at. The offset is what lets the readers below place a literal
 * inside or outside a `projects` entry.
 *
 * A balanced scan rather than `key:\s*\[([^\]]*)\]`, and global rather than first-match: configs
 * declare these keys more than once (a root list plus one per `projects` entry), nest arrays inside
 * them, and quote entries that contain a `]`. Every one of those shapes makes a first-match
 * non-greedy regex read a prefix of one list and call it the whole config. An unterminated literal
 * yields nothing rather than a truncated guess.
 */
function enclosedLiterals(source, key, open, close) {
  const literals = [];
  for (const opener of source.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\${open}`, 'gu'))) {
    const start = opener.index + opener[0].length;
    const end = balancedEnd(source, start, open, close);
    if (end !== -1) literals.push({ inner: source.slice(start, end), start });
  }
  return literals;
}

/**
 * The offset range of each object literal that is a direct element of a `projects` array.
 *
 * Vitest gives every `projects` entry its own Vite config, so `server.fs.allow` under one entry
 * says nothing about a seam path named under another. These ranges are how the reachability check
 * tells the two apart (issue #3123).
 *
 * An unterminated `projects: [` yields no ranges, which puts every allowance and seam path back in
 * one scope and restores the cross-entry crediting this closes. A regex literal holding a quote is
 * the ordinary construct that used to produce exactly that (issue #3154); `regexStartsAt` and the
 * newline-bounded quote span above are what keep it from doing so. That is the same fallback the other
 * scanners take on an unterminated literal, and it is bounded the same way: a config that does not
 * parse cannot load, so its own package job is red before this gate has an opinion. The quote walk
 * below is what keeps that bound honest — an unpaired `'` inside a regex literal parses and loads
 * fine, so without the newline bound the collapse would happen under a green package job.
 *
 * An entry whose own `{` never balances is skipped rather than ending the scan, so the entries
 * after it keep their ranges. `break` here was the amplifier that made a single mis-read line cost
 * the whole array: `regexStartsAt` bounds its mistakes to one line, but a line holding an entry's
 * closing brace leaves that entry unbalanced, and abandoning the array on it put every allowance
 * and seam path back in root scope — fail-open, on exactly the shape #3123 closes. Resuming
 * instead can only record ranges the balanced scan does find, and an extra or narrower range only
 * narrows a scope, which withholds crediting rather than granting it: a false red, never a false
 * green.
 *
 * The closure is literal-shaped, and that is the larger hole. A range exists only where the reader
 * can see a `{` as a direct element of the array, so an entry held in a variable — `projects:
 * [allowProject, seamProject]` — produces no ranges at all and every allowance and seam path falls
 * back to root scope, reading green on the very shape #3123 closes. The same holds for an `fs.allow`
 * living in a module-scope object spread into one entry. This is inherent to a text scanner over a
 * checkout with no dependencies installed, which is this file's stated posture, and it is no worse
 * than the pre-#3123 behavior; it is just wider than the unterminated-literal fallback above.
 *
 * The `projects:` key match is unanchored. `arrayLiterals(source, 'projects')` matches any
 * `projects:` key, not only Vitest's — an asymmetry with `fsAllowPaths`, which is deliberately
 * anchored to an enclosing `fs:` block so an unrelated `allow:` cannot be credited. A foreign
 * `projects: [{ ... }]` whose braces enclose an `fs.allow` but not the seam path would scope the
 * allowance away and red a config that loads fine. Narrowing a scope can only remove coverage, so
 * this direction fails closed — a false red, never a false green — and nothing in the tree carries
 * a stray `projects:` key today.
 */
export function projectEntryRanges(source) {
  const ranges = [];
  for (const { inner, start } of arrayLiterals(source, 'projects')) {
    for (let i = 0; i < inner.length; i += 1) {
      const character = inner[i];
      if (character === "'" || character === '"' || character === '`') i = quotedSpanEnd(inner, i);
      else if (character === '/' && regexStartsAt(inner, i)) i = regexLiteralEnd(inner, i);
      else if (character === '{') {
        const end = balancedEnd(inner, i + 1, '{', '}');
        if (end === -1) continue;
        ranges.push([start + i, start + end]);
        i = end;
      }
    }
  }
  return ranges;
}

/**
 * The scope `offset` sits in: `'root'`, or the innermost `projects` entry containing it, keyed by
 * that entry's offset so two entries never compare equal.
 */
function scopeAt(offset, ranges) {
  let innermost = null;
  for (const [start, end] of ranges) {
    if (offset < start || offset >= end) continue;
    if (innermost === null || start > innermost) innermost = start;
  }
  return innermost === null ? 'root' : `projects@${innermost}`;
}

/**
 * The scopes of the `projects` entries that set `extends: true`, as the same keys `scopeAt`
 * returns.
 *
 * Vitest does not fold the root config into a `projects` entry — an entry opts in, and this
 * repository already turns on that fact: `operator/vitest.config.ts` writes `extends: true`
 * explicitly, and both `global-tmp-root.ts` copies document the double `globalSetup` invocation it
 * causes. Without reading it, the reachability check below credits a root `server.fs.allow` to an
 * entry whose Vite server is built standalone and never sees it.
 *
 * Only the literal `true` counts. A path-valued `extends` names a different file, which this gate
 * cannot follow and must not read as inheritance of the root scope it can see. The declaration is
 * matched at the entry's own scope, so one nested inside an inner `projects` entry belongs to that
 * entry rather than this one.
 */
export function extendingScopes(source) {
  const stripped = stripComments(source);
  const ranges = projectEntryRanges(stripped);
  const extending = new Set();
  for (const match of stripped.matchAll(/\bextends\s*:\s*true\b/gu)) {
    const scope = scopeAt(match.index, ranges);
    if (scope !== 'root') extending.add(scope);
  }
  return extending;
}

/** The array literal that follows each `key:` in `source`, as raw inner text. */
function arrayLiterals(source, key) {
  return enclosedLiterals(source, key, '[', ']');
}

/**
 * The quoted entries of `literal`, resolved against `configDir` and made repo-relative, each with
 * the source offset it was read from so the caller can scope it.
 */
function resolveQuoted(literal, configDir, base, literalStart) {
  return [...literal.matchAll(/['"]([^'"]+)['"]/gu)].map((quoted) => ({
    resolved: relative(base, resolve(configDir, quoted[1])).split('\\').join('/'),
    at: literalStart + quoted.index,
  }));
}

/**
 * The paths a config's `setupFiles`/`globalSetup` entries resolve to, as repo-relative strings.
 *
 * Deliberately a scan of the quoted paths in the source rather than an import of the config: these
 * configs import `vitest/config` and per-package plugins, and this gate runs on a checkout with no
 * dependencies installed anywhere.
 */
export function wiredPaths(rawSource, configPath, base = root) {
  const configDir = dirname(resolve(base, configPath));
  const stripped = stripComments(rawSource);
  const ranges = projectEntryRanges(stripped);
  const paths = [];
  for (const key of ['setupFiles', 'globalSetup']) {
    for (const literal of arrayLiterals(stripped, key)) {
      for (const entry of resolveQuoted(literal.inner, configDir, base, literal.start)) {
        paths.push({ key, resolved: entry.resolved, scope: scopeAt(entry.at, ranges) });
      }
    }
  }
  return paths;
}

for (const seam of SEAMS) {
  test(`every Vitest config under ${seam.root}/ wires the temp-directory sweep seam`, () => {
    const configs = findVitestConfigs(seam.root);
    assert.ok(configs.length > 0, `no Vitest configs found under ${seam.root}/`);

    const unwired = [];
    for (const config of configs) {
      const wired = wiredPaths(readFileSync(resolve(root, config), 'utf8'), config);
      const missing = [];
      if (!wired.some((entry) => entry.key === 'setupFiles' && entry.resolved === seam.setup)) {
        missing.push(`setupFiles must include a path resolving to ${seam.setup}`);
      }
      if (!wired.some((entry) => entry.key === 'globalSetup' && entry.resolved === seam.global)) {
        missing.push(`globalSetup must include a path resolving to ${seam.global}`);
      }
      if (missing.length > 0) unwired.push(`${config}: ${missing.join('; ')}`);
    }

    assert.deepEqual(
      unwired,
      [],
      `Vitest suites that leak temp directories because the sweep seam is not wired:\n  ${unwired.join('\n  ')}\n` +
        'See test-support/tmp-isolation/README.md for the two lines each config needs.',
    );
  });
}

/**
 * The paths a config's `server.fs.allow` entries resolve to, as `{ resolved, scope }` — repo-relative
 * and tagged with the `projects` entry the allowance was declared in, or `'root'`.
 *
 * Same quoted-path scan as `wiredPaths`, and for the same reason: this gate runs on a checkout
 * with no dependencies installed, so it cannot import a config to ask. Every `fs.allow` list is
 * read — missing a later one reads a covered seam as unreachable — but the scope tag keeps each
 * one applied where Vite would apply it, rather than to the whole file (issue #3123).
 *
 * Anchored to an enclosing `fs:` block rather than scanning for a bare `allow:` key. Coverage is
 * what turns the reachability finding OFF, so crediting an unrelated plugin's `allow:` option would
 * reopen exactly the fail-open this reader exists to close.
 */
export function fsAllowPaths(rawSource, configPath, base = root) {
  const configDir = dirname(resolve(base, configPath));
  const stripped = stripComments(rawSource);
  const ranges = projectEntryRanges(stripped);
  const allowed = [];
  for (const block of enclosedLiterals(stripped, 'fs', '{', '}')) {
    for (const literal of arrayLiterals(block.inner, 'allow')) {
      for (const entry of resolveQuoted(literal.inner, configDir, base, block.start + literal.start)) {
        allowed.push({ resolved: entry.resolved, scope: scopeAt(entry.at, ranges) });
      }
    }
  }
  return allowed;
}

/**
 * Every `environment:` a config declares, in source order. Empty when it declares none, which is
 * Vitest's `node` default.
 *
 * A computed value (`environment: process.env.X`) reads as `'<computed>'` rather than being
 * skipped: the reachability check below turns OFF for `node` alone, so an unreadable environment
 * has to fail closed — the caller checks the config rather than trusting a value it cannot see.
 */
export function declaredEnvironments(source) {
  const found = [];
  for (const match of stripComments(source).matchAll(/\benvironment\s*:\s*(?:(['"])([^'"]*)\1|(?:[^,\s}]+))/gu)) {
    found.push(match[1] === undefined ? '<computed>' : match[2]);
  }
  return found;
}

/** True when repo-relative `path` is `ancestor` or lives inside it. */
function contains(ancestor, path) {
  const rel = relative(ancestor, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

/**
 * The `setupFiles`/`globalSetup` entries of `source` that its own Vite root does not contain and no
 * applicable `server.fs.allow` covers, as `{ key, resolved }`.
 *
 * Applicability follows Vitest's own inheritance rule, which is opt-in per `projects` entry (see
 * `extendingScopes`). Each entry gets its own Vite config, so:
 *
 * - a seam path named inside an entry is covered by that entry's own allowances, plus the root's
 *   only when the entry sets `extends: true`. Crediting a sibling entry's allowance — or the root's
 *   to an entry that never reads it — is fail-open for exactly the import failure this check
 *   predicts (issues #3123, #3136);
 * - a seam path named at root scope is loaded by every extending entry, under that entry's own
 *   server. So it is covered when the root's allowances cover it, or when every extending entry
 *   covers it with its own. A non-extending sibling never loads it, so its lack of coverage says
 *   nothing.
 *
 * A config with `projects` but no extending entry keeps the plain root-scope read. Nothing loads
 * its root-scoped seam path in that shape, so this cannot be the import failure — but the wiring
 * gate above reads scope-agnostically and would call it wired, so failing closed here is the only
 * signal left.
 */
export function unreachableWirings(source, configPath, base = root) {
  const configDir = relative(base, dirname(resolve(base, configPath))).split('\\').join('/');
  const allowed = fsAllowPaths(source, configPath, base);
  const extending = extendingScopes(source);
  const coveredBy = (path, scopes) =>
    allowed.some((allow) => scopes.includes(allow.scope) && contains(allow.resolved, path));
  const reachable = (entry) => {
    if (entry.scope !== 'root') {
      return coveredBy(entry.resolved, extending.has(entry.scope) ? ['root', entry.scope] : [entry.scope]);
    }
    if (extending.size === 0) return coveredBy(entry.resolved, ['root']);
    return [...extending].every((scope) => coveredBy(entry.resolved, ['root', scope]));
  };
  return wiredPaths(source, configPath, base)
    .filter((entry) => !contains(configDir, entry.resolved))
    .filter((entry) => !reachable(entry))
    .map((entry) => ({ key: entry.key, resolved: entry.resolved }));
}

test('configs that cannot reach the seam they name', () => {
  const unreachable = [];
  for (const seam of SEAMS) {
    for (const config of findVitestConfigs(seam.root)) {
      const source = readFileSync(resolve(root, config), 'utf8');
      // Node-environment suites load setup files through the SSR pipeline, which has no `/@fs/`
      // restriction. Only a browser-shaped environment can be blocked by `server.fs.allow`.
      // A config declaring several environments is checked unless every one of them is `node`.
      const environments = declaredEnvironments(source);
      if (environments.every((environment) => environment === 'node')) continue;
      const configDir = relative(root, dirname(resolve(root, config))).split('\\').join('/');
      for (const entry of unreachableWirings(source, config)) {
        unreachable.push(
          `${config}: ${entry.key} names ${entry.resolved}, which is outside the Vite root ` +
            `(${configDir}) and is not covered by server.fs.allow`,
        );
      }
    }
  }

  assert.deepEqual(
    unreachable,
    [],
    'Vitest suites whose environment cannot load the seam path they name, so every test file in ' +
      `them fails at import:\n  ${unreachable.join('\n  ')}\n` +
      'Add a server.fs.allow entry covering the seam — see packages/indexer/explorer/vitest.config.ts.',
  );
});

test('the seam files every config points at exist', () => {
  for (const seam of SEAMS) {
    for (const file of [seam.setup, seam.global]) {
      const absolute = resolve(root, file);
      assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `missing seam file ${file}`);
    }
  }
});

// --- reader unit tests -------------------------------------------------------------------------
//
// The three readers above are text scanners over config sources, and the shapes they have to
// survive are not all present in the tree at any one moment. These pin the shapes that a
// first-match regex reads wrongly: a computed environment, a second `environment:` under
// `projects`, a second `allow:` key, a nested array, a `]` inside a quoted entry, and a regex
// literal holding a quote.

test('declaredEnvironments reads every declaration, not the first', () => {
  assert.deepEqual(declaredEnvironments('export default { test: { globals: true } }'), []);
  assert.deepEqual(declaredEnvironments(`test: { environment: 'jsdom' }`), ['jsdom']);
  // A computed environment is unreadable as text; it must not read as the default.
  assert.deepEqual(declaredEnvironments('test: { environment: process.env.VITEST_ENV }'), [
    '<computed>',
  ]);
  // A `node` match ahead of a `projects` entry must not hide the browser-shaped one behind it.
  assert.deepEqual(
    declaredEnvironments(`test: { environment: 'node', projects: [{ test: { environment: 'jsdom' } }] }`),
    ['node', 'jsdom'],
  );
});

test('fsAllowPaths reads every fs.allow list, and only those', () => {
  const at = (source) =>
    fsAllowPaths(source, 'packages/x/vitest.config.ts').map((entry) => entry.resolved);
  assert.deepEqual(at('export default {}'), []);
  assert.deepEqual(at(`server: { fs: { allow: ['..'] } }`), ['packages']);
  // A second fs block — a root one plus a `projects` entry — is coverage too.
  assert.deepEqual(
    at(`server: { fs: { allow: ['.'] } }, projects: [{ server: { fs: { allow: ['../..'] } } }]`),
    ['packages/x', ''],
  );
  // An `allow:` outside any fs block is some other option, and must not count as coverage.
  assert.deepEqual(at(`somePlugin({ allow: ['../..'] })`), []);
  // A nested array inside the list must not truncate it at the inner `]`.
  assert.deepEqual(at(`fs: { allow: [['..'], '../..'] }`), ['packages', '']);
  // A `]` inside a quoted entry must not end the list either.
  assert.deepEqual(at(`fs: { allow: ['../a]b', '../..'] }`), ['packages/a]b', '']);
  // An apostrophe or a stray `]` in a comment inside the list must not derail the scan.
  assert.deepEqual(
    at(`fs: {\n  allow: [\n    // the seam's root, not this package's]\n    '../..',\n  ],\n}`),
    [''],
  );
  // An unterminated list yields nothing rather than a truncated guess.
  assert.deepEqual(at(`fs: { allow: ['..'`), []);

  // Each allowance is tagged with the block it was declared in: root, or one `projects` entry.
  const scoped = fsAllowPaths(
    `server: { fs: { allow: ['.'] } }, projects: [{ server: { fs: { allow: ['..'] } } }, { server: { fs: { allow: ['../..'] } } }]`,
    'packages/x/vitest.config.ts',
  );
  assert.deepEqual(
    scoped.map((entry) => entry.resolved),
    ['packages/x', 'packages', ''],
  );
  assert.equal(scoped[0].scope, 'root');
  assert.notEqual(scoped[1].scope, 'root');
  assert.notEqual(scoped[1].scope, scoped[2].scope);
});

// The newline bound in `balancedEnd`'s quote walk, under its own name. `projectEntryRanges` calls
// `balancedEnd` too, so the test below it is a second witness — but that one is named for the
// consequence at ITS site, a collapsed `projects` scope, and the consequence here is a different
// one: the enclosing literal comes back truncated, or missing entirely when the unbounded span runs
// past its close. A regex literal carrying an unpaired `'` is valid JavaScript, so the config
// parses and its own package job stays green while the literal quietly goes unread.
test('an unpaired quote in a regex literal does not truncate the literal around it', () => {
  // At the reader: the `}` that ends the fs block sits after the unpaired quote, so unbounded the
  // scan never balances it and `enclosedLiterals` yields nothing rather than the block.
  const block = `fs: {\n  a: /['"]/u,\n  allow: ['../..'],\n}`;
  assert.deepEqual(
    enclosedLiterals(block, 'fs', '{', '}').map((literal) => literal.inner.trim()),
    [`a: /['"]/u,\n  allow: ['../..'],`],
  );
  // And at the gate: the allowance inside that block is what goes missing.
  assert.deepEqual(
    fsAllowPaths(block, 'packages/x/vitest.config.ts').map((entry) => entry.resolved),
    [''],
  );
});

test('wiredPaths reads every setupFiles and globalSetup list', () => {
  const at = (source) =>
    wiredPaths(source, 'packages/x/vitest.config.ts').map(({ key, resolved }) => ({ key, resolved }));
  assert.deepEqual(
    at(`test: { setupFiles: ['./a.ts'], projects: [{ test: { setupFiles: ['./b.ts'] } }] }`),
    [
      { key: 'setupFiles', resolved: 'packages/x/a.ts' },
      { key: 'setupFiles', resolved: 'packages/x/b.ts' },
    ],
  );
  assert.deepEqual(at(`globalSetup: [['./g.ts'], './h.ts']`), [
    { key: 'globalSetup', resolved: 'packages/x/g.ts' },
    { key: 'globalSetup', resolved: 'packages/x/h.ts' },
  ]);

  // Each entry carries the `projects` entry it was named in, so coverage can be matched to it.
  const scoped = wiredPaths(
    `test: { setupFiles: ['./a.ts'], projects: [{ test: { setupFiles: ['./b.ts'] } }, { test: { setupFiles: ['./c.ts'] } }] }`,
    'packages/x/vitest.config.ts',
  );
  assert.equal(scoped[0].scope, 'root');
  assert.notEqual(scoped[1].scope, 'root');
  assert.notEqual(scoped[1].scope, scoped[2].scope);
});

test('projectEntryRanges finds one range per object entry, ordered per projects literal', () => {
  // Each range spans exactly the object entry it was read from, braces included.
  const entries = (source) =>
    projectEntryRanges(source).map(([start, end]) => source.slice(start, end + 1));

  // A glob string alongside an object entry: only the object gets a range.
  assert.deepEqual(entries(`projects: ['./p/*', { test: { name: 'a' } }]`), [
    `{ test: { name: 'a' } }`,
  ]);
  // A brace inside a quoted glob is not an entry.
  assert.deepEqual(entries(`projects: ['./{a,b}/*']`), []);
  // Call-wrapped entries are read through the wrapper.
  assert.deepEqual(entries(`projects: [defineProject({ a: 1 }), defineProject({ b: 2 })]`), [
    '{ a: 1 }',
    '{ b: 2 }',
  ]);
  // The same entry as the first case, with the list left unterminated, yields no ranges at all —
  // the documented fail-open that puts every allowance and seam path back in one scope.
  assert.deepEqual(projectEntryRanges(`projects: [{ test: { name: 'a' } }`), []);
  // An unterminated entry inside a terminated list drops that entry, keeping the ones before it.
  assert.deepEqual(entries(`projects: [{ a: 1 }, { b: 2 ]`), ['{ a: 1 }']);

  // Ordering is per `projects` literal, not global: each literal is walked to completion before the
  // next one is opened, so a nested literal's entries land after every entry of the literal that
  // encloses it — including siblings that start later in the source. Starts are not ascending.
  const unordered = `projects: [{ test: { projects: [{ x: 1 }] } }, { y: 2 }]`;
  assert.deepEqual(entries(unordered), [
    `{ test: { projects: [{ x: 1 }] } }`,
    '{ y: 2 }',
    '{ x: 1 }',
  ]);
  // And `scopeAt` reads that unordered list correctly: an offset inside `{ x: 1 }` is scoped to it,
  // not to the enclosing entry emitted first. (Innermost-by-maximum-start and a bare last-match-wins
  // agree on every reachable input — a range that contains an offset is always emitted before the
  // ranges nested inside it — so no fixture can separate them; the comparison is defensive.)
  const unorderedRanges = projectEntryRanges(unordered);
  const [outerRange, , innerRange] = unorderedRanges;
  assert.ok(outerRange[0] < innerRange[0], 'the enclosing entry starts before the nested one');
  assert.equal(
    scopeAt(unordered.indexOf('x: 1'), unorderedRanges),
    `projects@${innerRange[0]}`,
  );

  // Nested `projects` yield both ranges, and a path inside the inner one is scoped to the inner
  // entry rather than the outer one that also encloses it.
  const nested = `projects: [{ test: { projects: [{ test: { setupFiles: ['./b.ts'] } }] } }]`;
  const ranges = projectEntryRanges(nested);
  assert.equal(ranges.length, 2);
  const [outer, inner] = ranges;
  assert.ok(outer[0] < inner[0] && inner[1] < outer[1], 'inner range must sit inside the outer one');
  const [wired] = wiredPaths(nested, 'packages/x/vitest.config.ts');
  assert.equal(wired.scope, `projects@${inner[0]}`);
});

// The newline bound in the quote walk of `projectEntryRanges` is the fail-open half of that reader,
// and nothing else in this suite reaches it. A regex literal carrying an unpaired `'` is valid
// JavaScript, so the config parses and its own package job stays green; unbounded, that quote span
// swallows the entry braces, `projects` yields no ranges, and every allowance and seam path
// collapses into `root` scope — restoring the cross-entry crediting #3123 closed.
test('an unpaired quote in a regex literal does not collapse projects scope', () => {
  const regexQuote = [
    "export default { test: { environment: 'jsdom', projects: [",
    "    /\\d'/u,",
    "    { server: { fs: { allow: ['../..'] } } },",
    "    { test: { setupFiles: ['../../test-support/tmp-isolation/isolate-tmp.ts'] } },",
    '] } }',
  ].join('\n');
  assert.deepEqual(unreachableWirings(regexQuote, 'packages/x/vitest.config.ts'), [
    { key: 'setupFiles', resolved: 'test-support/tmp-isolation/isolate-tmp.ts' },
  ]);
});

// Commenting a wiring line out while chasing a slow or flaky suite is an ordinary edit, and the one
// most likely to be committed by accident. Every reader above matches over the raw source, so
// without `stripComments` a commented-out entry reads exactly like a live one and the gate above
// stays green while the suite leaks (issue #3027). These prove the readers red on that edit, the
// same way the gate is already red on a deleted one.
test('commented-out wiring does not read as live wiring', () => {
  const config = 'packages/layer/vitest.config.ts';
  const live = [
    'export default defineConfig({',
    "  test: { setupFiles: ['../../test-support/tmp-isolation/isolate-tmp.ts'],",
    "    globalSetup: ['../../test-support/tmp-isolation/global-tmp-root.ts'] },",
    '});',
  ].join('\n');
  assert.equal(wiredPaths(live, config).length, 2);

  const lineCommented = live
    .split('\n')
    .map((line) => (line.includes('tmp-isolation') ? `// ${line}` : line))
    .join('\n');
  assert.deepEqual(wiredPaths(lineCommented, config), []);

  const blockCommented = live.replace("  test: {", '  /* test: {').replace('});', '} */\n});');
  assert.deepEqual(wiredPaths(blockCommented, config), []);
});

test('commented-out server.fs.allow does not read as a live allowance', () => {
  const config = 'packages/indexer/explorer/vitest.config.ts';
  const live = "server: { fs: { allow: ['../../..', '.'] } },";
  assert.equal(fsAllowPaths(live, config).length, 2);
  assert.deepEqual(fsAllowPaths(`// ${live}`, config), []);
  assert.deepEqual(fsAllowPaths(`/* ${live} */`, config), []);
});

test('an environment named in a comment does not shadow the declared one', () => {
  assert.deepEqual(declaredEnvironments("environment: 'jsdom',"), ['jsdom']);
  assert.deepEqual(
    declaredEnvironments("// unlike the environment: 'node' suites\nenvironment: 'jsdom',"),
    ['jsdom'],
  );
  assert.deepEqual(
    declaredEnvironments("/* contrast with environment: 'node' */\nenvironment: 'jsdom',"),
    ['jsdom'],
  );
  // A commented-out declaration leaves none, which the reachability check reads as Vitest's
  // `node` default — the same as a config that declares no environment at all.
  assert.deepEqual(declaredEnvironments("// environment: 'jsdom'"), []);
});

test('stripComments leaves comment markers inside strings alone', () => {
  const source = "url: 'https://example.test/a', pattern: '/* not a comment */', real: 1 /* gone */";
  const stripped = stripComments(source);
  assert.ok(stripped.includes("'https://example.test/a'"));
  assert.ok(stripped.includes("'/* not a comment */'"));
  assert.ok(!stripped.includes('gone'));
  assert.equal(stripped.length, source.length);
  assert.equal(stripComments("a: '\\'', b: 2 // x").trimEnd(), "a: '\\'', b: 2");
  assert.equal(stripComments("a: 'unterminated // x"), "a: 'unterminated // x");

  // A quote the scanner cannot pair off must not leak the next line's comments back as live source.
  const afterOddQuote = stripComments("const RE = /['\"]/u;\n// setupFiles: ['isolate-tmp.ts']");
  assert.ok(!afterOddQuote.includes('isolate-tmp'));

  // The same, where the quote is not in a regex literal at all: `regexStartsAt` reads a `/` after
  // an operand as division, so only the newline bound stops the span here.
  assert.ok(!stripComments("a: b '\n// setupFiles: ['isolate-tmp.ts']").includes('isolate-tmp'));
});

// A `projects` config gives each entry its own Vite root, so an `fs.allow` under one entry says
// nothing about a seam path named under another. Reading both sides globally credited it anyway,
// which is fail-open for exactly the shape the reachability check exists to close (issue #3123).
test('fs.allow in one projects entry does not cover a seam path in another', () => {
  const config = 'packages/x/vitest.config.ts';
  const seam = '../../test-support/tmp-isolation/isolate-tmp.ts';
  const resolved = 'test-support/tmp-isolation/isolate-tmp.ts';
  const inProjects = (entries) =>
    `export default { test: { environment: 'jsdom', projects: [${entries}] } }`;

  // The allowance sits in the sibling entry, so the seam path stays unreachable.
  assert.deepEqual(
    unreachableWirings(
      inProjects(`{ server: { fs: { allow: ['../..'] } } }, { test: { setupFiles: ['${seam}'] } }`),
      config,
    ),
    [{ key: 'setupFiles', resolved }],
  );

  // Its own entry's allowance covers it.
  assert.deepEqual(
    unreachableWirings(
      inProjects(`{ server: { fs: { allow: ['../..'] } }, test: { setupFiles: ['${seam}'] } }`),
      config,
    ),
    [],
  );

  // So does a root-level one, but only for an entry that opts into the root config (issue #3136).
  assert.deepEqual(
    unreachableWirings(
      `export default { server: { fs: { allow: ['../..'] } }, test: { environment: 'jsdom', ` +
        `projects: [{ extends: true, test: { setupFiles: ['${seam}'] } }] } }`,
      config,
    ),
    [],
  );
});

// Vitest does not fold the root config into a `projects` entry; an entry opts in with
// `extends: true` (this repo relies on that at `operator/vitest.config.ts`, and both
// `global-tmp-root.ts` copies document the double `globalSetup` invocation it causes). Reading
// the root allowance as universal was wrong in both directions: it credited coverage to an entry
// that never sees the root config, and it withheld an extending entry's own coverage from the
// root-scoped seam path that entry inherits.
test('extendingScopes reads the entries that opt into the root config', () => {
  const scopes = (source) => [...extendingScopes(source)];
  assert.deepEqual(scopes('export default { test: { setupFiles: [] } }'), []);
  assert.equal(scopes(`projects: [{ extends: true, test: {} }]`).length, 1);
  // A path-valued `extends` names another file, not this config's root scope.
  assert.deepEqual(scopes(`projects: [{ extends: './base.ts', test: {} }]`), []);
  assert.deepEqual(scopes(`projects: [{ /* extends: true */ test: {} }]`), []);
  // Only the entry that declares it opts in.
  const mixed = extendingScopes(`projects: [{ extends: true }, { test: {} }]`);
  const ranges = projectEntryRanges(`projects: [{ extends: true }, { test: {} }]`);
  assert.equal(mixed.size, 1);
  assert.ok(mixed.has(`projects@${ranges[0][0]}`));
});

test('a root fs.allow reaches only the projects entries that extend the root config', () => {
  const config = 'packages/x/vitest.config.ts';
  const seam = '../../test-support/tmp-isolation/isolate-tmp.ts';
  const resolved = 'test-support/tmp-isolation/isolate-tmp.ts';
  const withRootAllowance = (entry) =>
    `export default { server: { fs: { allow: ['../..'] } }, test: { environment: 'jsdom', ` +
    `projects: [${entry}] } }`;

  // Fail-open closed: the entry never sees the root config, so its Vite server is built without
  // that allowance and every test file in it dies on `Cannot find module '/@fs/…'`.
  assert.deepEqual(unreachableWirings(withRootAllowance(`{ test: { setupFiles: ['${seam}'] } }`), config), [
    { key: 'setupFiles', resolved },
  ]);

  // An extending entry does inherit it.
  assert.deepEqual(
    unreachableWirings(withRootAllowance(`{ extends: true, test: { setupFiles: ['${seam}'] } }`), config),
    [],
  );
});

test("an extending entry's own fs.allow covers the root-scoped seam path it inherits", () => {
  const config = 'packages/x/vitest.config.ts';
  const seam = '../../test-support/tmp-isolation/isolate-tmp.ts';
  const resolved = 'test-support/tmp-isolation/isolate-tmp.ts';
  const withRootSeam = (entries) =>
    `export default { test: { environment: 'jsdom', setupFiles: ['${seam}'], ` +
    `projects: [${entries}] } }`;

  // False red closed: the inherited setup file loads under the extending entry's own server.
  assert.deepEqual(
    unreachableWirings(withRootSeam(`{ extends: true, server: { fs: { allow: ['../..'] } } }`), config),
    [],
  );

  // Every extending entry loads it, so one uncovered entry is still a real import failure.
  assert.deepEqual(
    unreachableWirings(
      withRootSeam(`{ extends: true, server: { fs: { allow: ['../..'] } } }, { extends: true }`),
      config,
    ),
    [{ key: 'setupFiles', resolved }],
  );

  // A non-extending sibling never loads the root seam path, so its lack of coverage says nothing.
  assert.deepEqual(
    unreachableWirings(
      withRootSeam(`{ extends: true, server: { fs: { allow: ['../..'] } } }, { test: {} }`),
      config,
    ),
    [],
  );
});

// Regex literals are not tokenized by these scanners, so a quote inside one — `/['"]/u` — is read
// as opening a string. `stripComments` already bounds a `'`/`"` span at a newline for exactly that
// reason; the balanced scanners did not, so the phantom string ran past the entry's closing brace
// and every range vanished. That put every allowance and seam path back in root scope and handed
// back a green read on precisely the cross-entry crediting #3123 closes (issue #3154).
test('a regex literal holding a quote does not swallow a projects entry', () => {
  const config = 'packages/x/vitest.config.ts';
  const seam = '../../test-support/tmp-isolation/isolate-tmp.ts';
  const resolved = 'test-support/tmp-isolation/isolate-tmp.ts';
  const withProperty = (property) =>
    `export default { test: { environment: 'jsdom', projects: [\n` +
    `  { ${property}server: { fs: { allow: ['../..'] } } },\n` +
    `  { test: { setupFiles: ['${seam}'] } },\n` +
    `] } }`;

  // Both entries keep their range, and the sibling's allowance stays out of the seam entry's scope.
  const properties = [
    '',
    `x: /['"]/u, `,
    // A `/` inside a character class does not close the literal. Unescaped, so this fails if the
    // class is not tracked rather than only if the escape is not skipped.
    `x: /[/]'/u, `,
    // An escaped `/` outside a class does not close it either.
    `x: /a\\/'b/u, `,
    // A brace or bracket inside the literal must not be read as structure.
    `x: /[{}\\]]/u, `,
  ];
  for (const property of properties) {
    // Through `stripComments`, the way every production caller reaches this reader.
    assert.equal(projectEntryRanges(stripComments(withProperty(property))).length, 2, property);
    assert.deepEqual(
      unreachableWirings(withProperty(property), config),
      [{ key: 'setupFiles', resolved }],
      property,
    );
  }

  // A division is not a regex: reading `/ 2` as one would swallow the rest of its line. The
  // trailing `-` of a postfix `--` is the shape that looks most like an operator and is not one.
  for (const property of ['x: total / 2, ', 'x: total-- / 2, ', 'x: total++ / 2, ']) {
    assert.equal(projectEntryRanges(withProperty(property)).length, 2, property);
  }

  // A regex may directly follow a keyword, where a bare character test sees an identifier.
  for (const property of [`x: (s) => typeof /['"]/u.exec(s), `, `x: (s) => { return /['"]/u; }, `]) {
    assert.equal(projectEntryRanges(withProperty(property)).length, 2, property);
  }

  // A postfix `!` is TypeScript's non-null assertion, so the `/` after it is a division. Reading it
  // as a regex is the same fail-open as the `--` case, on a shape that is ordinary in a `.ts`
  // config; a prefix `!` before a real regex must still read as one.
  for (const property of ['x: opts.value! / 2, ', 'x: f(a)! / 2, ', `x: (s) => !/['"]/u.test(s), `]) {
    assert.equal(projectEntryRanges(withProperty(property)).length, 2, property);
  }

  // A property named after a regex-preceding keyword is not that keyword. Every one of these is a
  // legal property name, and reading one as a keyword consumed the division and the entry's braces.
  for (const property of ['x: opts.in / 2, ', 'x: opts.of / 2, ', 'x: opts?.new / 2, ']) {
    assert.equal(projectEntryRanges(withProperty(property)).length, 2, property);
  }

  // The same shapes must not hand a trailing comment's prose back as live source (#3027).
  for (const line of [
    'x: total-- / 2, // setupFiles: isolate-tmp.ts',
    'x: opts.value! / 2, // setupFiles: isolate-tmp.ts',
    'x: opts.in / 2, // setupFiles: isolate-tmp.ts',
  ]) {
    assert.ok(!stripComments(line).includes('isolate-tmp'), line);
  }

  // Bounding it at the line is what keeps the damage local: the entries after the bad one still
  // get their ranges, where an unbounded scan runs to the next `/` in the file or off the end.
  assert.equal(
    projectEntryRanges(`projects: [\n  { a: 1 },\n  { x: /['"]u\n  },\n  { b: 2 },\n]`).length,
    3,
  );

  // An unterminated literal is bounded at its own line rather than the file, but it still takes
  // that line's braces with it, so its own entry is unbalanced and dropped. The scan resumes at the
  // next entry rather than abandoning the array, so the sibling keeps its range — which is what
  // makes the one-line bound above true of the consequence and not only of the consumed text.
  assert.equal(projectEntryRanges(withProperty(`x: /['"]u, `)).length, 1);

  // Every fixture above writes the array across several lines, where `quotedSpanEnd`'s newline
  // bound rescues the scan on its own even if `projectEntryRanges` never recognised the regex. A
  // single-line array is the only shape that reaches that branch, and without it the unpaired quote
  // runs to the end of the array: zero ranges, every entry falling back to root scope, which is the
  // cross-entry crediting fail-open of #3154 returning.
  assert.equal(projectEntryRanges(stripComments(`projects: [ /'/u, { a: 1 }, { b: 2 } ]`)).length, 2);
});

// `stripComments` passes regex literals through verbatim, and that branch is not redundant with the
// comment checks that precede it. What reaches those checks is an *unescaped* `/` inside the
// literal followed by `/` or `*` — which is why a character class is the shape that gets there, and
// an escaped `\/` is not: the backslash sits between the slashes, so there is no adjacent `//` for
// the line-comment check to see. Without the regex branch each fixture below is blanked from its
// inner `/` to the end of the line. Nothing in the tree writes those shapes today, which is why
// they are pinned here rather than left to the configs.
test('stripComments does not read a / inside a regex character class as a comment', () => {
  for (const source of [
    "x: /[/*]/u, setupFiles: ['isolate-tmp.ts']",
    "x: /[//]/u, setupFiles: ['isolate-tmp.ts']",
  ]) {
    assert.equal(stripComments(source), source);
  }
});
