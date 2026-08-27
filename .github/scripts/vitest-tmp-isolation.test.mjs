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
 * `source` with line and block comments removed.
 *
 * The scanners below are quote-aware but not comment-aware, and these configs are prose-heavy: an
 * apostrophe in a comment inside a multi-line array opens a phantom string that swallows the
 * closing bracket, and a stray `]` in a comment closes the array early. Either one drops a real
 * seam entry and reds a correctly wired config. Stripping first costs one pass and removes the
 * whole class. Quote state is tracked here too, so a `//` inside a path string survives.
 */
function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    if (quote !== null) {
      out += character;
      if (character === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      out += character;
      continue;
    }
    if (character === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    if (character === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = (end === -1 ? source.length : end + 1);
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * The `open`…`close` literal that follows each `key:` in `source`, as raw inner text.
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
        if (depth === 0) {
          literals.push(source.slice(start, i));
          break;
        }
      }
    }
  }
  return literals;
}

/** The array literal that follows each `key:` in `source`, as raw inner text. */
function arrayLiterals(source, key) {
  return enclosedLiterals(source, key, '[', ']');
}

/** The quoted entries of `literal`, resolved against `configDir` and made repo-relative. */
function resolveQuoted(literal, configDir, base) {
  return [...literal.matchAll(/['"]([^'"]+)['"]/gu)].map((quoted) =>
    relative(base, resolve(configDir, quoted[1])).split('\\').join('/'),
  );
}

/**
 * The paths a config's `setupFiles`/`globalSetup` entries resolve to, as repo-relative strings.
 *
 * Deliberately a scan of the quoted paths in the source rather than an import of the config: these
 * configs import `vitest/config` and per-package plugins, and this gate runs on a checkout with no
 * dependencies installed anywhere.
 */
export function wiredPaths(source, configPath, base = root) {
  const configDir = dirname(resolve(base, configPath));
  const stripped = stripComments(source);
  const paths = [];
  for (const key of ['setupFiles', 'globalSetup']) {
    for (const literal of arrayLiterals(stripped, key)) {
      for (const resolved of resolveQuoted(literal, configDir, base)) paths.push({ key, resolved });
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
 * The paths a config's `server.fs.allow` entries resolve to, as repo-relative strings.
 *
 * Same quoted-path scan as `wiredPaths`, and for the same reason: this gate runs on a checkout
 * with no dependencies installed, so it cannot import a config to ask. Every `fs.allow` list counts
 * — missing a later one reads a covered seam as unreachable.
 *
 * Anchored to an enclosing `fs:` block rather than scanning for a bare `allow:` key. Coverage is
 * what turns the reachability finding OFF, so crediting an unrelated plugin's `allow:` option would
 * reopen exactly the fail-open this reader exists to close.
 */
export function fsAllowPaths(source, configPath, base = root) {
  const configDir = dirname(resolve(base, configPath));
  return enclosedLiterals(stripComments(source), 'fs', '{', '}')
    .flatMap((block) => arrayLiterals(block, 'allow'))
    .flatMap((literal) => resolveQuoted(literal, configDir, base));
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
      const allowed = fsAllowPaths(source, config);
      for (const entry of wiredPaths(source, config)) {
        if (contains(configDir, entry.resolved)) continue;
        if (allowed.some((allow) => contains(allow, entry.resolved))) continue;
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
  const at = (source) => fsAllowPaths(source, 'packages/x/vitest.config.ts');
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
});

test('wiredPaths reads every setupFiles and globalSetup list', () => {
  const at = (source) => wiredPaths(source, 'packages/x/vitest.config.ts');
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
});
