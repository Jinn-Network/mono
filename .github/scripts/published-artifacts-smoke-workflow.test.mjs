import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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

function workflowStepScript(name) {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, `workflow step "${name}" must exist`);

  const runMarker = '        run: |\n';
  const runStart = workflow.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, `workflow step "${name}" must have a run block`);

  const contentStart = runStart + runMarker.length;
  const nextStep = workflow.indexOf('\n      - name:', contentStart);
  const block = workflow.slice(contentStart, nextStep === -1 ? undefined : nextStep);
  return block
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function runIdentityStep(provenance) {
  const root = mkdtempSync(path.join(tmpdir(), 'published-smoke-identity-'));
  const hermesHome = path.join(root, 'hermes');
  const pluginDir = path.join(hermesHome, 'plugins', 'jinn');
  const summaryPath = path.join(root, 'summary.md');
  mkdirSync(pluginDir, { recursive: true });

  const git = (...args) => {
    const result = spawnSync('git', args, {
      cwd: pluginDir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', 'https://github.com/Jinn-Network/jinn-plugin.git');
  writeFileSync(path.join(pluginDir, 'plugin.yaml'), 'name: jinn\n');
  git('add', 'plugin.yaml');
  git('commit', '-q', '-m', 'published fixture');

  if (provenance !== null) {
    writeFileSync(path.join(pluginDir, '.jinn-split-source'), provenance);
  }

  try {
    return spawnSync(
      'bash',
      ['-c', workflowStepScript('Verify installed release-channel identity')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          HERMES_HOME: hermesHome,
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
  assert.doesNotMatch(workflow, /plugin\/frozen/);
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
    'evidence-readable',
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

test('published split provenance accepts exactly the canonical two-line contract', () => {
  assert.ok(
    workflow.indexOf('Verify installed release-channel identity') <
      workflow.indexOf('Run the full published-plugin doctor'),
    'published provenance must be verified before executing the plugin doctor',
  );
  for (const sha of [
    '0123456789abcdef0123456789abcdef01234567',
    'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
  ]) {
    const result = runIdentityStep(
      `source: Jinn-Network/mono@${sha}\n` +
        'generated-by: .github/workflows/jinn-plugin-split.yml\n',
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('published split provenance rejects missing, malformed, duplicate, and unexpected values', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const source = `source: Jinn-Network/mono@${sha}`;
  const generated = 'generated-by: .github/workflows/jinn-plugin-split.yml';
  const invalid = {
    missing: null,
    'missing source': `${generated}\n`,
    'missing generator': `${source}\n`,
    'short source SHA': 'source: Jinn-Network/mono@0123456789abcdef\n' + `${generated}\n`,
    'long source SHA': `source: Jinn-Network/mono@${'a'.repeat(41)}\n${generated}\n`,
    'non-hex source SHA': `source: Jinn-Network/mono@${'g'.repeat(40)}\n${generated}\n`,
    'wrong source repo': `source: someone/else@${sha}\n${generated}\n`,
    'wrong generator': `${source}\ngenerated-by: other-workflow.yml\n`,
    'duplicate source': `${source}\n${source}\n${generated}\n`,
    'duplicate generator': `${source}\n${generated}\n${generated}\n`,
    'unexpected field': `${source}\n${generated}\nrelease: latest\n`,
    'unexpected prose': `${source}\n${generated}\nDO NOT EDIT HERE\n`,
    'reordered fields': `${generated}\n${source}\n`,
  };

  for (const [name, content] of Object.entries(invalid)) {
    const result = runIdentityStep(content);
    assert.notEqual(
      result.status,
      0,
      `${name} provenance unexpectedly passed:\n${result.stdout}\n${result.stderr}`,
    );
  }
});
