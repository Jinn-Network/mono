import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { selectHermetic } from './hermetic-selection.mjs';

const pr = (changedFiles) => selectHermetic({ eventName: 'pull_request', changedFiles });
const mergeGroup = (changedFiles) => selectHermetic({ eventName: 'merge_group', changedFiles });
const push = (changedFiles) => selectHermetic({ eventName: 'push', changedFiles });

const CANNOT_AFFECT = [
  'docs/engineering/handbook.md',
  'log/decisions/2026-08-18-merge-queue-on-next.md',
  'spec/2026-04-28-canonical-docs.md',
  'apps/website/src/app/page.tsx',
  'growth/README.md',
  'legacy/jinn-cli-agents-reference/CLAUDE.md',
  '.agents/skills/example.md',
  '.claude/skills/eng-day/SKILL.md',
  '.codex/config.toml',
  '.cursor/rules/example.mdc',
  'architecture/generated/platform-topology.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'PRINCIPLES.md',
  'SPEC.md',
  'THESIS.md',
  'BRAND.md',
  'GROWTH.md',
  'GLOSSARY.md',
  'DESIGN.md',
  'DESIGN.json',
  'README.md',
  'LICENSE',
  '.github/CODEOWNERS',
  '.github/architecture-owners',
];

const MUST_RUN = [
  'operator/src/daemon/daemon.ts',
  'apps/operator-console/app/page.tsx',
  'packages/sdk/src/index.ts',
  'contracts/src/claiming/ClaimRegistry.sol',
  '.github/workflows/hermetic-gate.yml',
];

test('documentation-only and CODEOWNERS-only diffs skip on pull_request and merge_group', () => {
  for (const event of ['pull_request', 'merge_group']) {
    const select = event === 'pull_request' ? pr : mergeGroup;
    for (const path of CANNOT_AFFECT) {
      const result = select([path]);
      assert.equal(result.run, false, `${event}: ${path} cannot affect hermetic`);
    }
    assert.equal(select(CANNOT_AFFECT).run, false, `${event}: a full cannot-affect set must skip`);
  }
});

test('a path the suite reads selects the lane on pull_request and merge_group', () => {
  for (const event of ['pull_request', 'merge_group']) {
    const select = event === 'pull_request' ? pr : mergeGroup;
    for (const path of MUST_RUN) {
      const result = select([path]);
      assert.equal(result.run, true, `${event}: ${path} must run hermetic`);
    }
  }
});

test('a mixed docs-and-operator diff selects the lane', () => {
  const result = pr(['docs/engineering/handbook.md', 'operator/src/daemon/daemon.ts']);
  assert.equal(result.run, true);
});

test('an unmatched path defaults to running the suite', () => {
  const result = pr(['some-uncatalogued-directory/index.ts']);
  assert.equal(result.run, true);
});

test('an empty change set defaults to running the suite', () => {
  const result = pr([]);
  assert.equal(result.run, true);
});

test('push always runs the suite, including a docs-only land', () => {
  const result = push(['docs/engineering/handbook.md']);
  assert.equal(result.run, true);
  assert.equal(push(CANNOT_AFFECT).run, true);
  assert.equal(push([]).run, true);
});

test('an unknown event defaults to running the suite', () => {
  const result = selectHermetic({ eventName: 'workflow_dispatch', changedFiles: ['docs/engineering/handbook.md'] });
  assert.equal(result.run, true);
});

// #4144: the entry guard compared the raw `argv[1]` with a percent-encoded URL
// pathname, so from a checkout path containing a space the CLI printed nothing, and
// comparing unresolved paths printed nothing through a symlinked directory.
test('the CLI runs from a checkout path containing a space or reached through a symlink (#4144)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinn hermetic space-'));
  try {
    copyFileSync(resolve(import.meta.dirname, 'hermetic-selection.mjs'), join(dir, 'hermetic-selection.mjs'));
    symlinkSync(dir, join(dir, 'via link'));
    for (const script of [join(dir, 'hermetic-selection.mjs'), join(dir, 'via link', 'hermetic-selection.mjs')]) {
      const result = spawnSync(process.execPath, [script], {
        input: 'operator/src/index.ts\n',
        encoding: 'utf8',
        env: { ...process.env, EVENT_NAME: 'pull_request' },
      });
      assert.equal(result.status, 0, `selector exited ${result.status}: ${result.stderr}`);
      assert.equal(typeof JSON.parse(result.stdout).run, 'boolean', script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
