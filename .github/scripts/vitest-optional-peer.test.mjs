import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { stripComments } from './js-source-scanner.mjs';

// npm before 11.19 resolves the peer set of an optional peer at install time and crashes when
// that set conflicts (#5079), and a conflicting vitest release can land at any time. An optional
// peer installs nothing: for a package with a vitest-importing test entry point it only states a
// version range, and a consumer of that entry point already has vitest. That hint is not worth an
// install crash for everyone else, so no package declares vitest as a peer (#5087). The package's
// README says the entry point needs vitest, and inside this repository each kit resolves vitest
// through its own devDependency.

const root = resolve(import.meta.dirname, '../..');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

function manifests() {
  return git('ls-files', '--', 'package.json', '*/package.json').map((file) => ({
    directory: dirname(file),
    manifest: JSON.parse(readFileSync(join(root, file), 'utf8')),
  }));
}

const IMPORT_SPECIFIER =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|(?<!typeof\s+)\bimport\(\s*["']([^"']+)["']\s*\)/gu;

function importsVitest(source) {
  return [...stripComments(source).matchAll(IMPORT_SPECIFIER)]
    .some((match) => /^(vitest|@vitest\/[^/]+)(\/|$)/u.test(match[1] ?? match[2] ?? match[3]));
}

function kitsThatImportVitest() {
  return manifests().filter(({ directory, manifest }) =>
    (manifest.exports?.['./testing'] !== undefined || manifest.name?.endsWith('-testing'))
    && git('ls-files', '--', join(directory, 'src'))
      .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file))
      .some((file) => importsVitest(readFileSync(join(root, file), 'utf8'))));
}

test('no package declares vitest as a peer', () => {
  assert.deepEqual(
    manifests()
      .filter(({ manifest }) => manifest.peerDependencies?.vitest || manifest.peerDependenciesMeta?.vitest)
      .map(({ manifest }) => manifest.name),
    [],
  );
});

test('a kit that imports vitest keeps it as a devDependency and says so in its README', () => {
  const kits = kitsThatImportVitest();
  assert.ok(kits.length > 0, 'no kit imports vitest: this guard has nothing to check');
  for (const { directory, manifest } of kits) {
    assert.ok(manifest.devDependencies?.vitest, `${manifest.name} must resolve vitest in this repository`);
    assert.match(
      readFileSync(join(root, directory, 'README.md'), 'utf8'),
      /needs\s+`vitest`\s+installed/u,
      `${manifest.name} must tell consumers its test entry point needs vitest`,
    );
  }
});

test('the scan counts imports and nothing else', () => {
  assert.equal(importsVitest('import { test } from "vitest";'), true);
  assert.equal(importsVitest('export * from "vitest/config";'), true);
  assert.equal(importsVitest('import "vitest";'), true);
  assert.equal(importsVitest('await import("vitest");'), true);
  assert.equal(importsVitest('const { it } = globalThis as unknown as typeof import("vitest");'), false);
  assert.equal(importsVitest('// import { test } from "vitest";\n/* from "vitest" */'), false);
});
