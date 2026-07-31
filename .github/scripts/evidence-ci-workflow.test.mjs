// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/evidence-ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');

const NODE_VERSION = '22.23.1';
const NPM_STEP_NAME = 'Install npm 11.19.0 for pack-smoke';

function parseJobs(source) {
  const jobsStart = source.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'evidence-ci.yml must declare jobs');
  const jobsSection = source.slice(jobsStart + 6);
  const jobs = new Map();
  const matches = [...jobsSection.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : jobsSection.length;
    jobs.set(name, jobsSection.slice(start, end));
  }
  return jobs;
}

test('architecture job runs the Evidence CI toolchain pin test', () => {
  const architecture = parseJobs(workflow).get('architecture');
  assert.ok(architecture, 'architecture job must exist');
  assert.match(
    architecture,
    /node --test \.github\/scripts\/evidence-ci-workflow\.test\.mjs/,
  );
});

test('every setup-node pins exact Node 22.23.1', () => {
  const setupNodes = [
    ...workflow.matchAll(/uses: actions\/setup-node@v4[\s\S]*?node-version:\s*([^\n]+)/g),
  ];
  assert.equal(setupNodes.length, 11, 'expected eleven setup-node steps');
  for (const [, version] of setupNodes) {
    assert.equal(
      version.trim(),
      NODE_VERSION,
      `setup-node must pin ${NODE_VERSION}, got ${version.trim()}`,
    );
  }
  assert.doesNotMatch(workflow, /node-version:\s*22\s*$/m);
  assert.doesNotMatch(workflow, /node-version:\s*['"]22['"]/);
});

test('pack-smoke jobs install npm 11.19.0 before pack:smoke', () => {
  const jobs = parseJobs(workflow);
  const packSmokeJobs = [...jobs.entries()].filter(([, block]) => block.includes('pack:smoke'));
  assert.ok(packSmokeJobs.length >= 9, 'expected at least nine pack-smoke jobs');

  for (const [name, block] of packSmokeJobs) {
    assert.match(
      block,
      new RegExp(`name: ${NPM_STEP_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${name} must include the named npm install step`,
    );
    const npmIndex = block.indexOf(`name: ${NPM_STEP_NAME}`);
    const packIndex = block.indexOf('pack:smoke');
    assert.ok(npmIndex >= 0 && packIndex > npmIndex, `${name} must run npm pin before pack:smoke`);
    assert.match(block, /npm install -g npm@11\.19\.0/, `${name} must install npm@11.19.0`);
    assert.match(
      block,
      /test "\$\(npm --version\)" = "11\.19\.0"/,
      `${name} must assert npm 11.19.0`,
    );
    assert.match(block, /GITHUB_PATH/, `${name} must publish npm prefix to GITHUB_PATH`);
  }
});

test('Evidence CI forbids legacy-peer-deps workarounds', () => {
  assert.doesNotMatch(workflow, /legacy-peer-deps/i);
  assert.doesNotMatch(workflow, /NPM_CONFIG_LEGACY_PEER_DEPS/i);
});
