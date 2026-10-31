import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { stripComments } from './js-source-scanner.mjs';

// npm resolves the peer set of an optional peer at install time, and npm 10 and 11.5.2 crash when
// that set conflicts (#5079; 11.6.0 does not), so an optional `vitest` peer passes that crash to
// everyone who installs the package. An optional peer installs nothing: for a package with a test
// entry point that needs vitest it only states a version range, and that hint is not worth the
// crash, so no package declares vitest as a peer (#5087).
//
// A kit that needs vitest says so in its README instead. Inside this repository, a Vitest run
// answers a portal kit's `import "vitest"` with its own `vitest:resolve-core` plugin, and plain Node
// resolves it through the portal's own `node_modules`, from the kit's devDependency.

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

function importSpecifiers(source) {
  return [...stripComments(source).matchAll(IMPORT_SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
}

const importsVitest = (source) =>
  importSpecifiers(source).some((specifier) => /^(vitest|@vitest\/[^/]+)(\/|$)/u.test(specifier));

/** The suite functions read off `globalThis`, typed from vitest: nothing emitted names a module. */
const readsVitestGlobals = (source) => /\btypeof\s+import\(\s*["']vitest["']\s*\)/u.test(stripComments(source));

/** The package behind a first-party kit entry: `<package>/testing`, or a whole `*-testing` package. */
function kitPackage(specifier) {
  const [scope, name, ...subpath] = specifier.split('/');
  if (scope !== '@jinn-network' || !name) return undefined;
  return subpath.join('/') === 'testing' || name.endsWith('-testing') ? `${scope}/${name}` : undefined;
}

function kits() {
  return new Map(manifests()
    .filter(({ manifest }) => manifest.exports?.['./testing'] !== undefined || manifest.name?.endsWith('-testing'))
    .map(({ directory, manifest }) => [manifest.name, {
      directory,
      manifest,
      sources: git('ls-files', '--', join(directory, 'src'))
        .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file))
        .map((file) => readFileSync(join(root, file), 'utf8')),
    }]));
}

/** A kit needs vitest if it imports it, reads its globals, or loads another kit that needs it. */
function needsVitest(name, all, seen = new Set()) {
  if (seen.has(name) || !all.has(name)) return false;
  seen.add(name);
  const { sources } = all.get(name);
  return sources.some((source) => importsVitest(source) || readsVitestGlobals(source))
    || sources.flatMap(importSpecifiers).map(kitPackage).some((kit) => needsVitest(kit, all, seen));
}

test('no package declares vitest as a peer', () => {
  assert.deepEqual(
    manifests()
      .filter(({ manifest }) =>
        manifest.peerDependencies?.vitest !== undefined || manifest.peerDependenciesMeta?.vitest !== undefined)
      .map(({ manifest }) => manifest.name),
    [],
  );
});

test('a kit that imports vitest by name keeps it as a devDependency', () => {
  const importing = [...kits().values()].filter(({ sources }) => sources.some(importsVitest));
  assert.ok(importing.length > 0, 'no kit imports vitest: this guard has nothing to check');
  for (const { manifest } of importing) {
    assert.ok(manifest.devDependencies?.vitest, `${manifest.name} must resolve vitest in this repository`);
  }
});

test('a kit that needs vitest says so in its README', () => {
  const all = kits();
  const needing = [...all.keys()].filter((name) => needsVitest(name, all));
  for (const name of ['@jinn-network/chain-scenarios', '@jinn-network/environment-verification']) {
    assert.ok(needing.includes(name), `${name} reaches vitest without importing it by name`);
  }
  for (const name of needing) {
    assert.match(
      readFileSync(join(root, all.get(name).directory, 'README.md'), 'utf8'),
      /needs\s+`vitest`\s+installed/u,
      `${name} must tell consumers its test entry point needs vitest`,
    );
  }
});

test('the scan tells an import from a read of the globals', () => {
  assert.equal(importsVitest('import { test } from "vitest";'), true);
  assert.equal(importsVitest('export * from "vitest/config";'), true);
  assert.equal(importsVitest('import "vitest";'), true);
  assert.equal(importsVitest('await import("vitest");'), true);
  const globals = 'const { it } = globalThis as unknown as typeof import("vitest");';
  assert.equal(importsVitest(globals), false);
  assert.equal(readsVitestGlobals(globals), true);
  assert.equal(importsVitest('// import { test } from "vitest";\n/* from "vitest" */'), false);
  assert.equal(readsVitestGlobals('// typeof import("vitest")'), false);
});

test('a kit entry point counts and an ordinary entry point does not', () => {
  assert.equal(kitPackage('@jinn-network/task-admission/testing'), '@jinn-network/task-admission');
  assert.equal(kitPackage('@jinn-network/trust-testing'), '@jinn-network/trust-testing');
  assert.equal(kitPackage('@jinn-network/marketplace-testing/venue-conformance'), '@jinn-network/marketplace-testing');
  assert.equal(kitPackage('@jinn-network/task-admission'), undefined);
  assert.equal(kitPackage('@jinn-network/task-admission/fixtures/a.json'), undefined);
  assert.equal(kitPackage('vitest'), undefined);
});
