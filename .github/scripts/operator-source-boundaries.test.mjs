import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'client';
const treeRoot = join(root, TREE);

// Directories inside the tree whose sources are checked.
const SCANNED = ['src', 'scripts', 'test'];

// Every sibling tree the operator must not reach into with a relative path.
// A relative escape bypasses the package boundary and the portal graph, which
// is exactly the #2297 violation class.
const SIBLING_ROOTS = [
  join(root, 'packages'),
  join(root, 'apps'),
  join(root, 'contracts'),
  join(root, 'examples'),
  join(root, 'legacy'),
];

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;
// import ... from '<spec>' | export ... from '<spec>' | import('<spec>')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;
const ownPackageName = JSON.parse(
  readFileSync(join(treeRoot, 'package.json'), 'utf8'),
).name;

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return sourceFiles(child);
    }
    return SOURCE_EXTENSIONS.test(entry.name) ? [child] : [];
  });
}

function relativeEscapes(file) {
  const contents = readFileSync(file, 'utf8');
  const offenders = [];
  for (const match of contents.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const target = resolve(file, '..', specifier);
    if (!relative(treeRoot, target).startsWith('..')) continue;
    const escaped = SIBLING_ROOTS.some(
      (sibling) => !relative(sibling, target).startsWith('..'),
    );
    if (escaped) offenders.push(`${relative(root, file)} -> ${specifier}`);
  }
  return offenders;
}

// A bare-specifier import that reaches past a package's public entrypoint,
// e.g. '@jinn-network/jinn-layer/src/publish.js'. The portal graph is the
// supported seam; internals are not.
function packageInternalImports(file) {
  const contents = readFileSync(file, 'utf8');
  const offenders = [];
  for (const match of contents.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('@jinn-network/')) continue;
    // Pack-smoke probes the operator's own tarball internals; that is not
    // a sibling-package boundary violation.
    if (specifier === ownPackageName || specifier.startsWith(`${ownPackageName}/`)) {
      continue;
    }
    if (/^@jinn-network\/[^/]+\/(?:src|dist)\//u.test(specifier)) {
      offenders.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  return offenders;
}

test('operator tree source never relative-imports into a sibling tree', () => {
  const offenders = SCANNED
    .flatMap((directory) => sourceFiles(join(treeRoot, directory)))
    .flatMap(relativeEscapes);
  assert.deepEqual(
    offenders.sort(),
    [],
    `${TREE}/ crosses a tree boundary with a relative import; consume the package through its portal entrypoint instead`,
  );
});

test('operator tree source never imports another package’s internals', () => {
  const offenders = SCANNED
    .flatMap((directory) => sourceFiles(join(treeRoot, directory)))
    .flatMap(packageInternalImports);
  assert.deepEqual(
    offenders.sort(),
    [],
    `${TREE}/ imports past a package public entrypoint`,
  );
});
