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
 * The paths a config's `setupFiles`/`globalSetup` entries resolve to, as repo-relative strings.
 *
 * Deliberately a scan of the quoted paths in the source rather than an import of the config: these
 * configs import `vitest/config` and per-package plugins, and this gate runs on a checkout with no
 * dependencies installed anywhere.
 */
export function wiredPaths(source, configPath, base = root) {
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

test('the seam files every config points at exist', () => {
  for (const seam of SEAMS) {
    for (const file of [seam.setup, seam.global]) {
      const absolute = resolve(root, file);
      assert.ok(existsSync(absolute) && statSync(absolute).isFile(), `missing seam file ${file}`);
    }
  }
});
