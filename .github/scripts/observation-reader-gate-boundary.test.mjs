// Class O (observation) receipts must never be read by a gate
// (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7, issue #2409).
// The Phase D deletion machinery is exactly such a gate: it decides whether a transition-manifest
// row may flip to `deleted`. This guard asserts neither the deletion test itself nor the manifest
// validator it depends on ever imports an observation reader — if one did, Class O counters could
// be read by, and eventually silently promoted into, a deletion decision.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

const GATE_PATH_FILES = [
  '.github/scripts/phase-d-transition-deletion.test.mjs',
  '.github/scripts/transition-manifest.mjs',
];

const FORBIDDEN_OBSERVATION_READERS = [
  'client/src/compatibility/phase-d-transition-usage.ts',
  'client/src/monitoring/phase-d-observation-window.ts',
];

function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [
    new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function stem(path) {
  return path.replace(/\.[cm]?[jt]sx?$/u, '');
}

function observationReaderImports(filePath) {
  const source = readFileSync(filePath, 'utf8');
  const fileDir = dirname(filePath);
  const forbiddenStems = FORBIDDEN_OBSERVATION_READERS.map((path) => stem(resolve(root, path)));
  return specifiers(source).flatMap((specifier) => {
    if (!specifier.startsWith('.')) return [];
    const resolvedStem = stem(resolve(fileDir, specifier));
    return forbiddenStems.includes(resolvedStem) ? [specifier] : [];
  });
}

test('no gate-path module imports an observation reader (spec §7)', () => {
  for (const gateFile of GATE_PATH_FILES) {
    const hits = observationReaderImports(resolve(root, gateFile));
    assert.deepEqual(hits, [],
      `${gateFile} must never import a Class O observation reader: ${hits.join(', ')}`);
  }
});

test('the guard actually catches a synthetic violation', () => {
  // The synthetic file is created inside the repository tree (rather than the OS tmpdir) so its
  // relative import specifier never needs to cross the repo-root ancestor — a checkout path
  // containing a quote character (this one lives under a directory named "life's-work") would
  // otherwise leak into the specifier and break the `["']` delimited parse below, same as it
  // would for a real gate-path violation.
  const dir = mkdtempSync(join(root, '.github', 'scripts', '.tmp-observation-reader-guard-'));
  try {
    const violatingFile = join(dir, 'synthetic-gate.test.mjs');
    const forbiddenTarget = resolve(root, FORBIDDEN_OBSERVATION_READERS[0]);
    let specifier = relative(dir, forbiddenTarget).split('\\').join('/').replace(/\.ts$/u, '.js');
    if (!specifier.startsWith('.')) specifier = `./${specifier}`;
    writeFileSync(violatingFile, `import { phaseDTransitionUsageDiagnostics } from '${specifier}';\n`);
    const hits = observationReaderImports(violatingFile);
    assert.deepEqual(hits, [specifier]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
