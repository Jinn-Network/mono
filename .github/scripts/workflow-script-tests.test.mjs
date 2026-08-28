import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const scriptsDir = resolve(root, '.github/scripts');
const workflowsDir = resolve(root, '.github/workflows');

/** @type {Record<string, string>} */
const SUGGESTED_OWNER_BY_TEST = {
  'build-platform-public-surface.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'build-prepublication-bundle.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'fixture-immutability.test.mjs': 'stack-fixture-immutability.yml',
  'fixture-manifest.test.mjs': 'stack-fixture-immutability.yml',
  'indexer-probe.test.mjs': 'indexer-monitor.yml',
  'jinn-plugin-split.test.mjs': 'jinn-plugin-split.yml',
  'platform-publisher-surface.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'prepublication-external-consumer.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-stack-run.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-stack.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'publish-verified-platform.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'published-artifacts-smoke-workflow.test.mjs': 'published-artifacts-smoke.yml',
  'stack-external-acceptance.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
  'stack-package-graph.test.mjs': 'platform-architecture-control.yml (platform-architecture-control job)',
  'stack-publish-manifest.test.mjs': 'platform-architecture-control.yml (platform-release-surface job)',
};

export function listScriptTests(scriptsRoot = scriptsDir) {
  return readdirSync(scriptsRoot)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();
}

export function collectReferencedScriptTests(workflowsRoot = workflowsDir) {
  const referenced = new Set();
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    const source = readFileSync(join(workflowsRoot, fileName), 'utf8');
    for (const match of source.matchAll(/\.github\/scripts\/([A-Za-z0-9_.-]+\.test\.mjs)/gu)) {
      referenced.add(match[1]);
    }
    for (const match of source.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+\.test\.mjs)(?:\s|$)/gmu)) {
      if (match[1].startsWith('.')) continue;
      referenced.add(match[1]);
    }
  }
  return referenced;
}

// Suites that patch files in the checked-out tree while they run. `node --test`
// schedules the files it is given in parallel, so any suite sharing an invocation
// with one of these reads manifests mid-rewrite and fails on truncated or
// canary-versioned JSON. Each must own its invocation.
const LIVE_TREE_MUTATING_TESTS = new Set(['build-prepublication-bundle.test.mjs']);

// Fixture directories a suite creates *inside the checked-out tree* rather than in the OS
// tmpdir. `node --test` runs a batch in parallel, so while one of these exists a sibling suite
// walking the checkout sees a path that `git ls-files --cached --others --exclude-standard`
// can never return. That race has fired twice: run 32982011618 (evidence-package-inventory)
// and issue #3148 (fixed by PR #3175). Both were repaired reader-side, and both repairs only
// worked because the transient directory happened to be dot-prefixed and gitignored.
//
// The invariant is therefore enforced here rather than left to luck. A suite that creates a
// directory under the repo root must declare it below, and every declared prefix must be both
// dot-prefixed (so dot-skipping walkers never descend into it) and matched by .gitignore (so
// the git-inventory comparison never sees it). A suite that cannot satisfy both must instead
// own its `node --test` invocation via LIVE_TREE_MUTATING_TESTS above.
//
// Paths are repo-root-relative prefixes; mkdtemp's random suffix is appended by the sample.
/** @type {Record<string, string[]>} */
const LIVE_TREE_FIXTURES = {
  'observation-reader-gate-boundary.test.mjs': ['.github/scripts/.tmp-observation-reader-guard-'],
};

const FIXTURE_CREATING_CALLS = ['mkdtempSync', 'mkdirSync'];

/**
 * A copy of `source` with the interior of every string literal, and every comment, replaced by a
 * neutral filler of the same length. Offsets are preserved, so a match found here indexes the
 * original text. Scanning the raw source instead makes `\broot\b` fire inside unrelated content
 * such as `'jinn-information-world-root-closure-'` or a synthetic fixture source in this file.
 */
export function maskLiterals(source) {
  const out = [...source];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      const end = next === '/'
        ? (source.indexOf('\n', index) === -1 ? source.length : source.indexOf('\n', index))
        : (source.indexOf('*/', index + 2) === -1 ? source.length : source.indexOf('*/', index + 2) + 2);
      for (let cursor = index; cursor < end; cursor += 1) if (out[cursor] !== '\n') out[cursor] = ' ';
      index = end - 1;
      continue;
    }
    if (char !== "'" && char !== '"' && char !== '`') continue;
    let cursor = index + 1;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '\\') { cursor += 1; continue; }
      if (source[cursor] === char) break;
      if (out[cursor] !== '\n') out[cursor] = 'x';
    }
    index = cursor;
  }
  return out.join('');
}

/** Reads the balanced-parenthesis argument text of the call opening at `open`. */
function callArgumentText(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

/**
 * Identifiers bound at module scope to the repository root. A `root` bound inside a helper is
 * almost always a tmpdir fixture root; only the module-level `resolve(import.meta.dirname, ...)`
 * form reaches into the live checkout.
 */
export function findRepoRootBindings(source) {
  return [...maskLiterals(source).matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*resolve\(\s*import\.meta\.dirname/gmu)]
    .map((match) => match[1]);
}

/** Calls that create a directory under the repository root, with their literal path segments. */
export function findInCheckoutFixtureCalls(source) {
  const bindings = findRepoRootBindings(source);
  if (bindings.length === 0) return [];
  const rootReference = new RegExp(`\\b(?:${bindings.join('|')})\\b`, 'u');
  const masked = maskLiterals(source);
  const calls = [];
  for (const name of FIXTURE_CREATING_CALLS) {
    for (const match of masked.matchAll(new RegExp(`\\b${name}\\(`, 'gu'))) {
      const open = match.index + name.length;
      if (!rootReference.test(callArgumentText(masked, open))) continue;
      const args = callArgumentText(source, open);
      calls.push({
        call: name,
        segments: [...args.matchAll(/'([^']*)'|"([^"]*)"/gu)].map((literal) => literal[1] ?? literal[2]),
      });
    }
  }
  return calls;
}

/** Suites that create at least one directory under the repository root. */
export function findLiveTreeFixtureSuites(scriptsRoot = scriptsDir) {
  return listScriptTests(scriptsRoot)
    .filter((name) => findInCheckoutFixtureCalls(readFileSync(join(scriptsRoot, name), 'utf8')).length > 0);
}

export function collectTestInvocations(workflowsRoot = workflowsDir) {
  const invocations = [];
  for (const fileName of readdirSync(workflowsRoot).filter((name) => name.endsWith('.yml'))) {
    const lines = readFileSync(join(workflowsRoot, fileName), 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!/\bnode\s+--test\b/u.test(lines[index])) continue;
      const files = [];
      let last = index;
      for (;;) {
        for (const match of lines[last].matchAll(/([A-Za-z0-9_.-]+\.test\.mjs)/gu)) files.push(match[1]);
        if (!lines[last].trimEnd().endsWith('\\') || last + 1 >= lines.length) break;
        last += 1;
      }
      invocations.push({ workflow: fileName, files });
      index = last;
    }
  }
  return invocations;
}

export function findOrphanedScriptTests(scriptsRoot = scriptsDir, workflowsRoot = workflowsDir) {
  const tests = listScriptTests(scriptsRoot);
  const referenced = collectReferencedScriptTests(workflowsRoot);
  return tests.filter((name) => !referenced.has(name));
}

test('every .github/scripts/*.test.mjs is referenced by at least one workflow', () => {
  const orphans = findOrphanedScriptTests();
  if (orphans.length === 0) return;

  const details = orphans.map((name) => {
    const owner = SUGGESTED_OWNER_BY_TEST[name] ?? 'an owning workflow under .github/workflows/';
    return `- ${name} (suggested owner: ${owner})`;
  }).join('\n');

  assert.fail(
    `Found ${orphans.length} unwired script test file(s). Each .github/scripts/*.test.mjs must appear in a workflow node --test invocation:\n${details}`,
  );
});

test('findOrphanedScriptTests detects a planted orphan', () => {
  assert.deepEqual(findOrphanedScriptTests(scriptsDir, workflowsDir), []);
});

test('a suite that mutates the checked-out tree never shares a node --test invocation', () => {
  for (const { workflow, files } of collectTestInvocations()) {
    for (const solo of files.filter((name) => LIVE_TREE_MUTATING_TESTS.has(name))) {
      assert.deepEqual(
        files,
        [solo],
        `${workflow} runs ${solo} alongside ${files.filter((name) => name !== solo).join(', ')}. `
        + `${solo} rewrites package.json files in the checked-out tree while it packs, so a `
        + 'co-scheduled suite reads them mid-rewrite. Give it its own node --test invocation.',
      );
    }
  }
});

test('collectTestInvocations reads the platform-release-surface lists', () => {
  const lists = collectTestInvocations()
    .filter(({ workflow }) => workflow === 'platform-architecture-control.yml')
    .map(({ files }) => files);
  assert.ok(lists.some((files) => files.length > 1), 'expected at least one multi-file invocation');
  assert.ok(
    lists.some((files) => files.length === 1 && LIVE_TREE_MUTATING_TESTS.has(files[0])),
    'expected the live-tree-mutating suite to own an invocation',
  );
});

test('every suite creating a fixture inside the checkout declares it', () => {
  const declared = new Set(Object.keys(LIVE_TREE_FIXTURES));
  const found = findLiveTreeFixtureSuites();
  const undeclared = found.filter((name) => !declared.has(name) && !LIVE_TREE_MUTATING_TESTS.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `${undeclared.join(', ')} create a directory under the repository root while running. A `
    + 'sibling suite scheduled in the same `node --test` batch sees a path git cannot return, so '
    + 'declare the fixture prefix in LIVE_TREE_FIXTURES (dot-prefixed and gitignored), or add the '
    + 'suite to LIVE_TREE_MUTATING_TESTS so it owns its invocation.',
  );
  const stale = [...declared].filter((name) => !found.includes(name));
  assert.deepEqual(stale, [], `LIVE_TREE_FIXTURES lists ${stale.join(', ')}, which no longer creates one.`);
});

test('every declared in-checkout fixture prefix is dot-prefixed', () => {
  for (const [suite, prefixes] of Object.entries(LIVE_TREE_FIXTURES)) {
    for (const prefix of prefixes) {
      const basename = prefix.split('/').filter(Boolean).at(-1);
      assert.ok(
        basename?.startsWith('.'),
        `${suite} creates ${prefix} inside the checkout. Its final segment must be dot-prefixed so `
        + 'dot-skipping tree walks never descend into it mid-scan.',
      );
    }
  }
});

test('every declared in-checkout fixture prefix is gitignored', () => {
  for (const [suite, prefixes] of Object.entries(LIVE_TREE_FIXTURES)) {
    for (const prefix of prefixes) {
      const sample = `${prefix}0a1b2c`;
      let ignored = true;
      try {
        execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', sample], {
          cwd: root,
          stdio: 'ignore',
        });
      } catch {
        ignored = false;
      }
      assert.ok(
        ignored,
        `${suite} creates ${sample} inside the checkout, but .gitignore does not match it, so a `
        + 'sibling suite comparing the tree against `git ls-files` sees an untracked path.',
      );
    }
  }
});

test('the in-checkout fixture detector reads repo-root bindings, not tmpdir ones', () => {
  const inCheckout = [
    "const root = resolve(import.meta.dirname, '../..');",
    "const dir = mkdtempSync(join(root, '.github', 'scripts', '.tmp-guard-'));",
  ].join('\n');
  assert.deepEqual(findRepoRootBindings(inCheckout), ['root']);
  assert.deepEqual(findInCheckoutFixtureCalls(inCheckout), [
    { call: 'mkdtempSync', segments: ['.github', 'scripts', '.tmp-guard-'] },
  ]);

  const tmpdirFixture = [
    "const root = resolve(import.meta.dirname, '../..');",
    'function fixture() {',
    "  const root = mkdtempSync(join(tmpdir(), 'jinn-'));",
    "  mkdirSync(join(root, 'nested'));",
    '}',
  ].join('\n');
  assert.deepEqual(
    findInCheckoutFixtureCalls(tmpdirFixture).map(({ segments }) => segments),
    [['nested']],
    'a shadowed local `root` is indistinguishable without a scope analysis, so the detector '
    + 'deliberately over-reports rather than missing a real in-checkout fixture',
  );

  assert.deepEqual(findInCheckoutFixtureCalls("mkdirSync(join(tmpdir(), 'x'));"), []);
});
