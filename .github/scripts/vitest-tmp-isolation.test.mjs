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
 */
export function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === '\\' ? 2 : 1;
      }
      index += 1;
      out += source.slice(start, Math.min(index, source.length));
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
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
 * The paths a config's `setupFiles`/`globalSetup` entries resolve to, as repo-relative strings.
 *
 * Deliberately a scan of the quoted paths in the source rather than an import of the config: these
 * configs import `vitest/config` and per-package plugins, and this gate runs on a checkout with no
 * dependencies installed anywhere.
 */
export function wiredPaths(rawSource, configPath, base = root) {
  const source = stripComments(rawSource);
  const configDir = dirname(resolve(base, configPath));
  const paths = [];
  for (const key of ['setupFiles', 'globalSetup']) {
    const match = source.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, 'u'));
    if (match === null) continue;
    for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/gu)) {
      paths.push({ key, resolved: relative(base, resolve(configDir, quoted[1])).split('\\').join('/') });
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
 * with no dependencies installed, so it cannot import a config to ask.
 */
export function fsAllowPaths(rawSource, configPath, base = root) {
  const configDir = dirname(resolve(base, configPath));
  const match = stripComments(rawSource).match(/allow:\s*\[([^\]]*)\]/u);
  if (match === null) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/gu)].map((quoted) =>
    relative(base, resolve(configDir, quoted[1])).split('\\').join('/'),
  );
}

/** A config's declared `test.environment`, or `'node'` when it declares none (Vitest's default). */
export function declaredEnvironment(rawSource) {
  const match = stripComments(rawSource).match(/environment:\s*['"]([^'"]+)['"]/u);
  return match === null ? 'node' : match[1];
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
      if (declaredEnvironment(source) === 'node') continue;
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
  assert.equal(declaredEnvironment("environment: 'jsdom',"), 'jsdom');
  assert.equal(
    declaredEnvironment("// unlike the environment: 'node' suites\nenvironment: 'jsdom',"),
    'jsdom',
  );
  assert.equal(
    declaredEnvironment("/* contrast with environment: 'node' */\nenvironment: 'jsdom',"),
    'jsdom',
  );
  assert.equal(declaredEnvironment("// environment: 'jsdom'"), 'node');
});

test('stripComments leaves comment markers inside strings alone', () => {
  const source = "url: 'https://example.test/a', pattern: '/* not a comment */', real: 1 /* gone */";
  const stripped = stripComments(source);
  assert.ok(stripped.includes("'https://example.test/a'"));
  assert.ok(stripped.includes("'/* not a comment */'"));
  assert.ok(!stripped.includes('gone'));
});
