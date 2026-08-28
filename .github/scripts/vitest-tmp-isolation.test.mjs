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
 * `source` with line and block comments replaced by whitespace, preserving offsets and line
 * structure so the readers below can keep matching over a plain string.
 *
 * Every reader here matches the raw source, so without this a commented-out entry reads exactly
 * like a live one: prefixing `// ` to a config's `setupFiles` line left the wiring gate green while
 * the suite resumed leaking (issue #3027). Quoted text is skipped, so a `//` inside a path or URL
 * is not mistaken for a comment.
 *
 * Stripping also protects the balanced scanners below, which are quote-aware but not
 * comment-aware. These configs are prose-heavy: an apostrophe in a comment inside a multi-line
 * array opens a phantom string that swallows the closing bracket, and a stray `]` in a comment
 * closes the array early. Either one drops a real seam entry and reds a correctly wired config.
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index += 1;
      // A `'`/`"` string cannot hold an unescaped newline, so ending the span at one bounds any
      // mis-read to a single line. Without that an odd quote count outside a string — a regex like
      // `/['"]/u`, since regex literals are not tokenized — would swallow the rest of the file and
      // hand every later comment back as live source, which is the failure this whole change removes.
      while (index < source.length && source[index] !== char) {
        if (char !== '`' && source[index] === '\n') break;
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      out += source.slice(start, Math.min(index, source.length));
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
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The index of the `close` that balances an `open` already consumed at `start - 1`, or `-1` when
 * the literal is never terminated. Quote-aware so a bracket inside a quoted entry does not close it.
 */
function balancedEnd(source, start, open, close) {
  let depth = 1;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const character = source[i];
    if (quote !== null) {
      if (character === '\\') i += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
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
 * one scope and restores the cross-entry crediting this closes. That is the same fallback the other
 * scanners take on an unterminated literal, and it is bounded the same way: a config that does not
 * parse cannot load, so its own package job is red before this gate has an opinion.
 */
export function projectEntryRanges(source) {
  const ranges = [];
  for (const { inner, start } of arrayLiterals(source, 'projects')) {
    let quote = null;
    for (let i = 0; i < inner.length; i += 1) {
      const character = inner[i];
      if (quote !== null) {
        if (character === '\\') i += 1;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === "'" || character === '"' || character === '`') quote = character;
      else if (character === '{') {
        const end = balancedEnd(inner, i + 1, '{', '}');
        if (end === -1) break;
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
  for (const match of stripComments(source).matchAll(/\benvironment\s*:\s*(?:(['"])([^'"]*)\1|([^,\s}]+))/gu)) {
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
// `projects`, a second `allow:` key, a nested array, and a `]` inside a quoted entry.

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
