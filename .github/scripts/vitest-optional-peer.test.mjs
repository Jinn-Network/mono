import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { stripComments } from './js-source-scanner.mjs';

// npm before 11.19 resolves the peer set of an optional peer at install time and crashes when
// that set conflicts (#5079), so the optional `vitest` peer is a risk every consumer takes on.
// A package declares it only where what it ships needs it: where its non-test source imports
// vitest, directly or through another package's kit entry point (#5087). Reading the suite
// functions off `globalThis` is not an import: the emitted code names no vitest module.

const root = resolve(import.meta.dirname, '../..');

const IMPORT_SPECIFIER =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|(?<!typeof\s+)\bimport\(\s*["']([^"']+)["']\s*\)/gu;

function importSpecifiers(source) {
  return [...stripComments(source).matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
}

const isVitest = (specifier) => /^(vitest|@vitest\/[^/]+)(\/|$)/u.test(specifier);

/** A first-party kit entry: `<package>/testing`, or a whole `*-testing` package. */
function kitPackage(specifier) {
  const [scope, name, ...subpath] = specifier.split('/');
  if (scope !== '@jinn-network' || !name) return undefined;
  return subpath.join('/') === 'testing' || (subpath.length === 0 && name.endsWith('-testing'))
    ? `${scope}/${name}`
    : undefined;
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

function sourceSpecifiers(directory) {
  return git('ls-files', '--', join(directory, 'src'))
    .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file))
    .flatMap((file) => importSpecifiers(readFileSync(join(root, file), 'utf8')));
}

function declaringPackages() {
  return new Map(git('ls-files', '--', 'package.json', '*/package.json').flatMap((file) => {
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    return manifest.peerDependencies?.vitest ? [[manifest.name, dirname(file)]] : [];
  }));
}

function reachesVitest(name, packages, visiting = new Set()) {
  if (visiting.has(name)) return false;
  visiting.add(name);
  const specifiers = sourceSpecifiers(packages.get(name));
  return specifiers.some(isVitest) || specifiers.map(kitPackage).some((kit) =>
    kit !== undefined && packages.has(kit) && reachesVitest(kit, packages, visiting));
}

test('the optional vitest peer is declared only where non-test source imports vitest', () => {
  const packages = declaringPackages();
  assert.ok(packages.size > 0, 'no package declares the peer: this guard has nothing to check');
  const needless = [...packages.keys()].filter((name) => !reachesVitest(name, packages));
  assert.deepEqual(needless, [], 'these packages declare the optional vitest peer but import no vitest');
});

test('the scan counts imports and nothing else', () => {
  assert.deepEqual(importSpecifiers('import { test } from "vitest";'), ['vitest']);
  assert.deepEqual(importSpecifiers('export * from "vitest/config";'), ['vitest/config']);
  assert.deepEqual(importSpecifiers('import "vitest";'), ['vitest']);
  assert.deepEqual(importSpecifiers('await import("vitest");'), ['vitest']);
  assert.deepEqual(importSpecifiers('const { it } = globalThis as unknown as typeof import("vitest");'), []);
  assert.deepEqual(importSpecifiers('// import { test } from "vitest";\n/* from "vitest" */'), []);
});

test('a kit entry point counts and an ordinary entry point does not', () => {
  assert.equal(kitPackage('@jinn-network/task-admission/testing'), '@jinn-network/task-admission');
  assert.equal(kitPackage('@jinn-network/trust-testing'), '@jinn-network/trust-testing');
  assert.equal(kitPackage('@jinn-network/task-admission'), undefined);
  assert.equal(kitPackage('@jinn-network/task-admission/fixtures/a.json'), undefined);
  assert.equal(kitPackage('vitest'), undefined);
});

test('a package reaches vitest through a kit it imports', () => {
  const packages = declaringPackages();
  assert.equal(reachesVitest('@jinn-network/chain-scenarios', packages), true);
  assert.equal(
    sourceSpecifiers(packages.get('@jinn-network/chain-scenarios')).some(isVitest),
    false,
    'chain-scenarios now imports vitest directly, so this no longer proves the transitive path',
  );
});
