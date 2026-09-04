// Portal-build probe for `yarn typecheck:test` (issue #3734).
//
// `typecheck:test` builds only `@jinn-network/jinn-layer`. The other portal trees the operator
// test tree compiles against (`build:sdk`, `build:stack`, `build:plugin`, `build:core`) are built
// by `yarn typecheck`, which `.github/workflows/ci.yml` runs immediately before this gate. That
// split is deliberate and worth keeping: the gate then costs one extra `tsc` pass rather than a
// second full stack build.
//
// The coupling is invisible at the point of use, though. On a fresh clone the obvious thing to do
// after a red gate is to run `yarn typecheck:test` alone — which compiles against absent `dist/`
// trees and prints a large regression list that has nothing to do with the change. Probing first
// turns that into one sentence naming the prerequisite.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Portal `@jinn-network/*` dependencies of the package at `dir` whose built entrypoint is absent.
 *
 * Derived from the manifest rather than a hardcoded list, so a new portal dependency is covered
 * without editing this file. A package that declares no `types`/`main` entrypoint is skipped:
 * there is nothing to probe, and a false failure here would be worse than the miss.
 *
 * @param {string} dir Package directory to probe (the operator workspace).
 * @returns {{ name: string, reason: string }[]} Empty when every probed entrypoint exists.
 */
export function findUnbuiltPortalPackages(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    return [{ name: dir, reason: `cannot read package.json: ${error.message}` }];
  }

  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith('@jinn-network/'))
    .sort();

  const unbuilt = [];
  for (const name of names) {
    const packageDir = join(dir, 'node_modules', ...name.split('/'));
    let installed;
    try {
      installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    } catch {
      unbuilt.push({ name, reason: 'not installed' });
      continue;
    }
    const entry = installed.types ?? installed.typings ?? installed.main;
    if (typeof entry !== 'string') continue;
    if (!existsSync(join(packageDir, entry))) unbuilt.push({ name, reason: `missing ${entry}` });
  }
  return unbuilt;
}

/** The message `check-test-typecheck.mjs` prints instead of a spurious regression list. */
export function formatUnbuiltPortalsMessage(unbuilt) {
  return [
    'typecheck:test cannot run — the portal packages the test tree compiles against are not built:',
    '',
    ...unbuilt.map(({ name, reason }) => `  ${name}: ${reason}`),
    '',
    'Run `yarn typecheck` first (it builds sdk/stack/plugin/core), then `yarn typecheck:test`,',
    'which builds jinn-layer itself. That is the order .github/workflows/ci.yml uses.',
  ].join('\n');
}
