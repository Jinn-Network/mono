import assert from 'node:assert/strict';
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
