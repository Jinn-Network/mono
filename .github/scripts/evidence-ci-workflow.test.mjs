// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/evidence-ci.yml');

const NODE_VERSION = '22.23.1';
const NPM_STEP_NAME = 'Install npm 11.19.0 for pack-smoke';
const REQUIRED_SETUP_NODE_JOBS = [
  'architecture',
  'foundation',
  'components',
  'derivation',
  'execution-recorder-bridge',
  'retrieval',
  'trajectory',
  'contribution',
  'catalog-sqlite',
  'local-runtime',
  'verify',
];
const PACK_SMOKE_JOB_IDS = [
  'foundation',
  'components',
  'derivation',
  'execution-recorder-bridge',
  'retrieval',
  'trajectory',
  'contribution',
  'catalog-sqlite',
  'local-runtime',
];

function parseSteps(jobBlock) {
  const stepsStart = jobBlock.indexOf('\n    steps:\n');
  assert.notEqual(stepsStart, -1, 'job must declare steps');
  const stepsSection = jobBlock.slice(stepsStart + 12);
  const steps = [];
  const lines = stepsSection.split('\n');
  let current = null;
  for (const line of lines) {
    if (/^  [a-z0-9-]+:/.test(line)) break;
    if (/^      - /.test(line)) {
      if (current) steps.push(current);
      const nameMatch = line.match(/^      - name: (.+)$/);
      current = { name: nameMatch?.[1] ?? null, lines: [line.trimEnd()] };
      continue;
    }
    if (current && (line.startsWith('      ') || line.startsWith('        '))) {
      current.lines.push(line.trimEnd());
    }
  }
  if (current) steps.push(current);
  return steps;
}

function stepRunsPackSmoke(step) {
  return step.lines.some((line) => line.includes('pack:smoke'));
}

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

function setupNodeStepsInJob(jobBlock) {
  return [...jobBlock.matchAll(/uses: actions\/setup-node@v4[\s\S]*?node-version:\s*([^\n]+)/g)];
}

export function validateEvidenceCiWorkflow(source) {
  const jobs = parseJobs(source);

  for (const jobId of REQUIRED_SETUP_NODE_JOBS) {
    assert.ok(jobs.has(jobId), `missing required setup-node job ${jobId}`);
    const setupNodes = setupNodeStepsInJob(jobs.get(jobId));
    assert.equal(
      setupNodes.length,
      1,
      `${jobId} must have exactly one setup-node step (found ${String(setupNodes.length)})`,
    );
    assert.equal(
      setupNodes[0][1].trim(),
      NODE_VERSION,
      `${jobId} setup-node must pin ${NODE_VERSION}`,
    );
  }

  assert.doesNotMatch(source, /node-version:\s*22\s*$/m);
  assert.doesNotMatch(source, /node-version:\s*['"]22['"]/);
  assert.doesNotMatch(source, /legacy-peer-deps/i);
  assert.doesNotMatch(source, /NPM_CONFIG_LEGACY_PEER_DEPS/i);

  for (const jobId of PACK_SMOKE_JOB_IDS) {
    assert.ok(jobs.has(jobId), `missing required pack-smoke job ${jobId}`);
  }

  for (const [jobId, block] of jobs.entries()) {
    if (!PACK_SMOKE_JOB_IDS.includes(jobId)) continue;
    const steps = parseSteps(block);
    const npmStepIndex = steps.findIndex((step) => step.name === NPM_STEP_NAME);
    assert.notEqual(npmStepIndex, -1, `${jobId} must include the named npm install step`);
    const npmBody = steps[npmStepIndex].lines.join('\n');
    assert.match(npmBody, /npm install -g npm@11\.19\.0/);
    assert.match(npmBody, /GITHUB_PATH/);
    assert.match(npmBody, /test "\$\(npm --version\)" = "11\.19\.0"/);

    const packSmokeIndexes = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => stepRunsPackSmoke(step));
    assert.ok(packSmokeIndexes.length >= 1, `${jobId} must run pack:smoke`);
    for (const { index } of packSmokeIndexes) {
      assert.ok(
        npmStepIndex < index,
        `${jobId} npm pin step must precede pack:smoke step at index ${String(index)}`,
      );
    }
  }

  const extraPackSmokeJobs = [...jobs.entries()].filter(
    ([jobId, block]) => !PACK_SMOKE_JOB_IDS.includes(jobId) && block.includes('pack:smoke'),
  );
  assert.equal(extraPackSmokeJobs.length, 0, 'unexpected ungoverned pack-smoke jobs');
}

const workflow = readFileSync(workflowPath, 'utf8');

function expectValidationFailure(mutant, pattern) {
  try {
    validateEvidenceCiWorkflow(mutant);
    assert.fail('expected workflow validation to fail');
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern);
  }
}

test('architecture job runs the Evidence CI toolchain pin test', () => {
  const architecture = parseJobs(workflow).get('architecture');
  assert.ok(architecture, 'architecture job must exist');
  assert.match(
    architecture,
    /node --test \.github\/scripts\/evidence-ci-workflow\.test\.mjs/,
  );
});

test('semantic Evidence CI pack-smoke architecture is valid', () => {
  validateEvidenceCiWorkflow(workflow);
});

test('mutation: npm step name before pack:smoke but command after fails', () => {
  const mutant = workflow.replace(
    /npm install -g npm@11\.19\.0\n/g,
    'echo "placeholder"\n',
  );
  expectValidationFailure(mutant, /must include the named npm install step|npm install -g npm@11/);
});

test('mutation: omitted pack-smoke job fails', () => {
  const mutant = workflow.replace(/\n  trajectory:\n[\s\S]*?(?=\n  contribution:)/, '\n');
  expectValidationFailure(
    mutant,
    /missing required pack-smoke job trajectory|missing required setup-node job trajectory/,
  );
});

test('mutation: extra ungoverned pack-smoke job fails', () => {
  const mutant = workflow.replace(
    '\n  verify:',
    '\n  rogue-pack-smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - run: yarn pack:smoke\n\n  verify:',
  );
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /unexpected ungoverned pack-smoke jobs/);
});

test('mutation: missing GITHUB_PATH publish fails', () => {
  const mutant = workflow.replace(/echo "\$\(npm prefix -g\)\/bin" >> "\$GITHUB_PATH"\n/g, '');
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /GITHUB_PATH/);
});

test('mutation: missing npm version assert fails', () => {
  const mutant = workflow.replace(/test "\$\(npm --version\)" = "11\.19\.0"\n/g, '');
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /11\.19\.0/);
});

test('mutation: floating Node 22 fails', () => {
  const mutant = workflow.replaceAll('node-version: 22.23.1', 'node-version: 22');
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /setup-node must pin 22\.23\.1/);
});

test('mutation: legacy-peer-deps workaround fails', () => {
  const mutant = `${workflow}\n# legacy-peer-deps\n`;
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /legacy-peer-deps/i);
});

test('mutation: anonymous one-line pack:smoke before npm pin fails', () => {
  const mutant = workflow.replace(
    /(  trajectory:[\s\S]*?      )- name: Install npm 11\.19\.0 for pack-smoke/,
    '$1- run: yarn pack:smoke\n      - name: Install npm 11.19.0 for pack-smoke',
  );
  expectValidationFailure(mutant, /trajectory npm pin step must precede pack:smoke step/);
});

test('mutation: anonymous multiline pack:smoke before npm pin fails', () => {
  const mutant = workflow.replace(
    /(  trajectory:[\s\S]*?      )- name: Install npm 11\.19\.0 for pack-smoke/,
    '$1- run: |\n          yarn pack:smoke\n      - name: Install npm 11.19.0 for pack-smoke',
  );
  expectValidationFailure(mutant, /trajectory npm pin step must precede pack:smoke step/);
});

test('mutation: unnamed npm step before pack:smoke fails', () => {
  const mutant = workflow.replace(
    '      - name: Install npm 11.19.0 for pack-smoke\n        run: |',
    '      - run: |\n          npm install -g npm@11.19.0\n          echo "$(npm prefix -g)/bin" >> "$GITHUB_PATH"\n          test "$(npm --version)" = "11.19.0"\n      - run: |',
  );
  expectValidationFailure(mutant, /must include the named npm install step/);
});

test('mutation: anonymous pack:smoke inserted before npm pin in trajectory job fails', () => {
  const mutant = workflow.replace(
    '  trajectory:\n    name: Evidence Trajectory\n    needs: [foundation]\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4',
    '  trajectory:\n    name: Evidence Trajectory\n    needs: [foundation]\n    runs-on: ubuntu-latest\n    steps:\n      - run: yarn pack:smoke\n      - uses: actions/checkout@v4',
  );
  expectValidationFailure(mutant, /npm pin step must precede pack:smoke step at index 0/);
});

test('mutation: remove setup-node from trajectory job fails', () => {
  const mutant = workflow.replace(
    /(  trajectory:[\s\S]*?      - uses: actions\/checkout@v4\n)(      - uses: actions\/setup-node@v4\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1',
  );
  expectValidationFailure(mutant, /trajectory must have exactly one setup-node step \(found 0\)/);
});

test('mutation: duplicate setup-node in architecture job fails', () => {
  const mutant = workflow.replace(
    /(  architecture:[\s\S]*?      - uses: actions\/setup-node@v4\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1      - uses: actions/setup-node@v4\n        with:\n          node-version: 22.23.1\n',
  );
  expectValidationFailure(
    mutant,
    /architecture must have exactly one setup-node step \(found 2\)/,
  );
});

test('mutation: wrong setup-node version in foundation job fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?node-version: )22\.23\.1/,
    '$122.0.0',
  );
  expectValidationFailure(mutant, /foundation setup-node must pin 22\.23\.1/);
});
