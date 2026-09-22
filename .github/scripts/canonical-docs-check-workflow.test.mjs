import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflowPath = resolve(import.meta.dirname, '../workflows/canonical-docs-check.yml');

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}

function extractCheckScript(source) {
  const startMarker = '  check:';
  const endMarker = '  canonical-docs-gate:';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, 'workflow is missing the check job');
  assert.ok(end > start, 'canonical-docs-gate must follow check');
  const job = source.slice(start, end);
  const marker = '\n        run: |\n';
  const runStart = job.lastIndexOf(marker);
  assert.ok(runStart >= 0, 'check job must carry a literal-block run: script');
  const indent = '          ';
  const lines = [];
  for (const line of job.slice(runStart + marker.length).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith(indent)) break;
    lines.push(line.slice(indent.length));
  }
  return `${lines.join('\n')}\n`;
}

test('pull_request trigger includes edited so a Discussion-URL body edit re-runs the gate (#4181)', () => {
  const source = readWorkflow();
  const typesBlock = source.match(/pull_request:[\s\S]*?types:\n((?:      - \w+\n)+)/u);
  assert.ok(typesBlock, 'pull_request.types must be a block list');
  const types = [...typesBlock[1].matchAll(/- (\w+)/gu)].map((m) => m[1]);
  assert.deepEqual(new Set(types), new Set(['opened', 'synchronize', 'reopened', 'edited']));
});

test('the check job reads the PR body from the API, not the triggering event payload (#4181)', () => {
  const script = extractCheckScript(readWorkflow());
  assert.doesNotMatch(script, /github\.event\.pull_request\.body/u);
  assert.match(script, /gh api .*pulls\/\$\{PR_NUMBER\}/u);
  assert.match(script, /--jq \.body/u);
});

test('the discussion URL pattern is unchanged', () => {
  const script = extractCheckScript(readWorkflow());
  assert.match(
    script,
    /github\\\.com\/Jinn-Network\/mono\/discussions\/\[0-9\]\+/u,
  );
});

test('a live body with the Discussion URL passes even when the event payload would have been empty', () => {
  const script = extractCheckScript(readWorkflow());
  const dir = mkdtempSync(join(tmpdir(), 'canonical-docs-check-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'gh'),
      [
        '#!/bin/bash',
        'echo "See https://github.com/Jinn-Network/mono/discussions/59"',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    writeFileSync(
      join(dir, 'bin', 'git'),
      ['#!/bin/bash', 'echo PRINCIPLES.md', ''].join('\n'),
    );
    chmodSync(join(dir, 'bin', 'git'), 0o755);
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        PR_NUMBER: '4139',
        BASE_REF: 'next',
        GITHUB_REPOSITORY: 'Jinn-Network/mono',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live body without the Discussion URL still fails when a canonical file changed', () => {
  const script = extractCheckScript(readWorkflow());
  const dir = mkdtempSync(join(tmpdir(), 'canonical-docs-check-fail-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin', 'gh'),
      ['#!/bin/bash', 'echo "no discussion here"', ''].join('\n'),
    );
    chmodSync(join(dir, 'bin', 'gh'), 0o755);
    writeFileSync(
      join(dir, 'bin', 'git'),
      ['#!/bin/bash', 'echo PRINCIPLES.md', ''].join('\n'),
    );
    chmodSync(join(dir, 'bin', 'git'), 0o755);
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        HOME: dir,
        PR_NUMBER: '4139',
        BASE_REF: 'next',
        GITHUB_REPOSITORY: 'Jinn-Network/mono',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.match(result.stdout, /Canonical doc changed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
