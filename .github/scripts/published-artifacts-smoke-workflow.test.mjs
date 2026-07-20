import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(
  scriptsDir,
  '..',
  'workflows',
  'published-artifacts-smoke.yml',
);
const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '';

test('published-artifacts smoke covers schedule, manual, and post-split release triggers', () => {
  assert.ok(workflow, 'published-artifacts-smoke.yml must exist');
  assert.match(workflow, /schedule:[\s\S]*?- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /workflow_run:\s*\n\s+workflows:\s*\['Split jinn plugin to slim repo'\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(workflow, /UPSTREAM_CONCLUSION/);
  assert.match(workflow, /success/);
});

test('smoke installs stock Hermes and Jinn only from pinned published channels', () => {
  assert.match(
    workflow,
    /HERMES_UPSTREAM_SHA:\s*9df5f879b4a5925c0f8f947e7e16ed8e845932c3/,
  );
  assert.match(
    workflow,
    /git\+https:\/\/github\.com\/NousResearch\/hermes-agent\.git@\$\{HERMES_UPSTREAM_SHA\}/,
  );
  assert.match(
    workflow,
    /plugins install Jinn-Network\/jinn-plugin --enable/,
  );
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.doesNotMatch(workflow, /file:\/\//);
  assert.doesNotMatch(workflow, /apps\/jinn-agent\/plugins\/jinn/);
});

test('full doctor output is converted into a real non-advisory gate', () => {
  assert.match(workflow, /jinn-doctor/);
  assert.match(workflow, /PIPESTATUS\[0\]/);
  assert.match(workflow, /grep -Fq '\[fail\]'/);
  assert.match(workflow, /grep -Fxq 'all checks passed\.'/);
  for (const check of [
    'plugin-build',
    'layer-available',
    'layer-contract',
    'prerequisites',
    'host-provider',
  ]) {
    assert.match(workflow, new RegExp(check));
  }
  assert.match(workflow, /exit 1/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test('workflow has a bounded, secret-free, least-privilege execution surface', () => {
  assert.match(workflow, /permissions:\s*\{\}/);
  assert.match(workflow, /timeout-minutes:\s*25/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(
    workflow,
    /actions\/setup-python@[0-9a-f]{40}/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@[0-9a-f]{40}/,
  );
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /id-token:\s*write|contents:\s*write/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});
