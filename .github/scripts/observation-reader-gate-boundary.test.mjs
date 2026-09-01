// Class O (observation) receipts must never be read by a gate
// (docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md §7, issue #2409).
// The Phase D deletion machinery is exactly such a gate: it decides whether a transition-manifest
// row may flip to `deleted`. This guard asserts none of the gate-path modules that decide that
// question ever imports an observation reader — if one did, Class O counters could be read by,
// and eventually silently promoted into, a deletion decision.
//
// Known evasion holes this regex-based import scan does not close (accepted, matching the style
// of the tree's other `*-boundaries.test.mjs` guards, which share the same scanner): a re-export
// shim (`export * from '<forbidden>'` one hop away from a gate-path file, then imported by name)
// and a computed/templated dynamic `import()` specifier built from concatenated strings. Closing
// either needs a real module graph (e.g. an AST/TS-program walk), which this lightweight guard
// deliberately does not attempt.
//
// GATE_PATH_FILES and FORBIDDEN_OBSERVATION_READERS are derived from the manifest itself (plus
// two fixed non-manifest facts: the manifest loader, and the observation-window reader, which the
// manifest never names directly) rather than hand-maintained, so a new deletion-adjacent file or
// a new durable counter automatically enters the guard's scope.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

import { loadAndValidateTransitionManifest } from './transition-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(root, 'architecture/transitions/phase-d-native-operator.v1.json');
const manifest = loadAndValidateTransitionManifest(manifestPath, { repoRoot: root });

// Not manifest-declared data: `transition-manifest.mjs` is the loader/validator every deletion
// test depends on to even read the manifest, and `phase-d-observation-window.ts` is the second
// Class O reader (spec §7) — it backs no transition's usageSignal.sourceFile because the
// observation-window receipt is collected out-of-band by the collector script, not read inline by
// a gate. Both are fixed facts about the architecture, not per-transition data.
const TRANSITION_MANIFEST_LOADER = '.github/scripts/transition-manifest.mjs';
const OBSERVATION_WINDOW_READER = 'operator/src/monitoring/phase-d-observation-window.ts';

// A deletionTest.command is a shell command string (e.g. "node --test <path>"); pull out the
// path-shaped tokens rather than assuming a fixed argv position.
function commandFiles(command) {
  return command.split(/\s+/u).filter((token) => token.includes('/') && /\.[cm]?[jt]sx?$/u.test(token));
}

const GATE_PATH_FILES = [...new Set([
  ...manifest.transitions.map((transition) => transition.noNewUseGuard.path),
  ...manifest.transitions.flatMap((transition) => commandFiles(transition.deletionTest.command)),
  TRANSITION_MANIFEST_LOADER,
])].sort();

const FORBIDDEN_OBSERVATION_READERS = [...new Set([
  ...manifest.transitions
    .map((transition) => transition.usageSignal.sourceFile)
    .filter((sourceFile) => typeof sourceFile === 'string'),
  OBSERVATION_WINDOW_READER,
])].sort();

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

test('the derived gate-path list picks up every noNewUseGuard and deletionTest file (self-maintaining, F3)', () => {
  // marketplace-source-boundaries.test.mjs is a real transition's noNewUseGuard.path that a prior
  // hand-maintained version of this list omitted — asserted by name so a future re-hardcoding
  // regresses visibly.
  assert.ok(GATE_PATH_FILES.includes('.github/scripts/marketplace-source-boundaries.test.mjs'));
  assert.ok(GATE_PATH_FILES.includes('.github/scripts/phase-d-transition-deletion.test.mjs'));
  assert.ok(GATE_PATH_FILES.includes(TRANSITION_MANIFEST_LOADER));
  for (const transition of manifest.transitions) {
    assert.ok(GATE_PATH_FILES.includes(transition.noNewUseGuard.path));
    for (const file of commandFiles(transition.deletionTest.command)) {
      assert.ok(GATE_PATH_FILES.includes(file));
    }
  }
});

test('the derived forbidden-reader list picks up every declared usageSignal.sourceFile', () => {
  assert.ok(FORBIDDEN_OBSERVATION_READERS.includes('operator/src/compatibility/phase-d-transition-usage.ts'));
  assert.ok(FORBIDDEN_OBSERVATION_READERS.includes(OBSERVATION_WINDOW_READER));
  for (const transition of manifest.transitions) {
    if (typeof transition.usageSignal.sourceFile === 'string') {
      assert.ok(FORBIDDEN_OBSERVATION_READERS.includes(transition.usageSignal.sourceFile));
    }
  }
});

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
  //
  // Creating it inside the checkout is safe only while the name stays dot-prefixed and gitignored:
  // `node --test` runs a batch in parallel, so a sibling suite walking the tree would otherwise see
  // a path `git ls-files --cached --others --exclude-standard` cannot return (run 32982011618,
  // issue #3148). Both conditions are enforced by LIVE_TREE_FIXTURES in workflow-script-tests.test.mjs,
  // which this prefix is declared in; renaming it means updating that declaration too.
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
