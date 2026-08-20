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
  'trace',
  'trace-decode',
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
  'trace',
  'trace-decode',
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
  const seenJobIds = new Set();
  for (const match of matches) {
    if (seenJobIds.has(match[1])) {
      throw new Error(`duplicate job key "${match[1]}"`);
    }
    seenJobIds.add(match[1]);
  }
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1];
    const start = matches[index].index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : jobsSection.length;
    jobs.set(name, jobsSection.slice(start, end));
  }
  return jobs;
}

function parseStepFields(step) {
  const fields = { uses: null, with: {}, run: null };
  const stepLevelKeys = [];
  const withLevelKeys = [];
  let inBlockScalar = false;
  let blockScalarIndent = null;
  let inWithBlock = false;

  for (const line of step.lines) {
    if (inBlockScalar) {
      if (line.trim() === "") continue;
      const indent = line.match(/^ */)?.[0]?.length ?? 0;
      if (indent <= blockScalarIndent) {
        inBlockScalar = false;
        blockScalarIndent = null;
      } else {
        continue;
      }
    }

    const sequenceMatch = line.match(/^ {6}- ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (sequenceMatch) {
      stepLevelKeys.push(sequenceMatch[1]);
      const key = sequenceMatch[1];
      const value = sequenceMatch[2].trim();
      if (key === "uses") fields.uses = value;
      if (key === "run") {
        fields.run = line.trim();
        if (value === "|" || value === ">" || value === "|-" || value === ">-") {
          inBlockScalar = true;
          blockScalarIndent = 8;
        }
      }
      if (key === "with") inWithBlock = true;
      continue;
    }

    const stepMatch = line.match(/^ {8}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (stepMatch) {
      stepLevelKeys.push(stepMatch[1]);
      const key = stepMatch[1];
      const value = stepMatch[2].trim();
      if (key === "uses") fields.uses = value;
      if (key === "run") {
        fields.run = line.trim();
        if (value === "|" || value === ">" || value === "|-" || value === ">-") {
          inBlockScalar = true;
          blockScalarIndent = 8;
        }
      }
      if (key === "with") {
        inWithBlock = true;
      } else {
        inWithBlock = false;
      }
      continue;
    }

    if (inWithBlock) {
      const withMatch = line.match(/^ {10}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (withMatch) {
        withLevelKeys.push(withMatch[1]);
        fields.with[withMatch[1]] = withMatch[2].trim();
        continue;
      }
      if (/^ {8}\S/.test(line) && !/^ {10}/.test(line)) {
        inWithBlock = false;
      }
    }
  }

  fields.stepLevelKeys = stepLevelKeys;
  fields.withLevelKeys = withLevelKeys;
  return fields;
}

const BLOCK_SCALAR_MARKERS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

function lineIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function isUnsupportedYamlConstruct(line) {
  const trimmed = line.trim();
  if (/^\*[^\s*]/.test(trimmed)) return true;
  if (/&[^\s&]/.test(trimmed)) return true;
  if (/<<:\s*/.test(trimmed)) return true;
  return false;
}

function parseMappingKey(line) {
  const sequence = line.match(/^(\s*)-\s+([A-Za-z0-9_.-]+):\s*(.*)$/);
  if (sequence) {
    return {
      indent: sequence[1].length,
      key: sequence[2],
      rest: sequence[3].trim(),
      sequenceItem: true,
    };
  }
  const plain = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
  if (plain) {
    return {
      indent: plain[1].length,
      key: plain[2],
      rest: plain[3].trim(),
      sequenceItem: false,
    };
  }
  return null;
}

function isBlockScalarStart(rest) {
  if (rest === "") return false;
  if (BLOCK_SCALAR_MARKERS.has(rest)) return true;
  return rest.startsWith("|") || rest.startsWith(">");
}

/** Block-scalar-aware duplicate-key scan for every YAML mapping scope in the workflow. */
export function assertUniqueYamlMappingKeys(source, contextLabel = "workflow") {
  const lines = source.split("\n");
  const stack = [{ indent: -1, keys: new Set(), label: contextLabel }];
  let blockScalar = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = lineIndent(line);

    if (blockScalar) {
      if (trimmed === "") continue;
      if (indent <= blockScalar.indent) {
        blockScalar = null;
      } else {
        continue;
      }
    }

    if (isUnsupportedYamlConstruct(line)) {
      throw new Error(
        `${contextLabel} line ${String(lineNumber + 1)}: unsupported YAML anchor/merge construct`,
      );
    }

    const parsed = parseMappingKey(line);
    if (!parsed) continue;

    if (parsed.sequenceItem) {
      while (stack.length > 1 && stack[stack.length - 1].indent >= parsed.indent) {
        stack.pop();
      }
      stack.push({
        indent: parsed.indent,
        keys: new Set(),
        label: `${contextLabel} line ${String(lineNumber + 1)} sequence item`,
      });
    } else {
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
        stack.pop();
      }
    }

    const frame = stack[stack.length - 1];
    if (frame.keys.has(parsed.key)) {
      throw new Error(`${frame.label}: duplicate YAML mapping key "${parsed.key}"`);
    }
    frame.keys.add(parsed.key);

    if (isBlockScalarStart(parsed.rest)) {
      blockScalar = { indent: parsed.indent };
    } else if (parsed.rest === "") {
      stack.push({
        indent: parsed.indent,
        keys: new Set(),
        label: `${frame.label}.${parsed.key}`,
      });
    }
  }
}

function assertUniqueYamlKeys(keys, context) {
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new Error(`${context}: duplicate YAML mapping key "${key}"`);
    }
    seen.add(key);
  }
}

function setupNodeVersionForStep(step) {
  const fields = parseStepFields(step);
  if (fields.uses !== "actions/setup-node@v7") return undefined;
  return fields.with["node-version"];
}

function setupNodeStepsInJob(jobBlock) {
  const steps = parseSteps(jobBlock);
  return steps.filter((step) => stepUsesSetupNode(step));
}

function checkoutStepsInJob(jobBlock) {
  return [...jobBlock.matchAll(/uses: actions\/checkout@v4/g)];
}

function stepUsesCheckout(step) {
  return step.lines.some((line) => line.includes("uses: actions/checkout@v4"));
}

function stepUsesSetupNode(step) {
  return step.lines.some((line) => line.includes("uses: actions/setup-node@v7"));
}

export function validateEvidenceCiWorkflow(source) {
  assertUniqueYamlMappingKeys(source);
  const jobs = parseJobs(source);

  for (const jobId of REQUIRED_SETUP_NODE_JOBS) {
    assert.ok(jobs.has(jobId), `missing required setup-node job ${jobId}`);
    const jobBlock = jobs.get(jobId);
    const checkouts = checkoutStepsInJob(jobBlock);
    assert.equal(
      checkouts.length,
      1,
      `${jobId} must have exactly one checkout step (found ${String(checkouts.length)})`,
    );
    const setupNodes = setupNodeStepsInJob(jobBlock);
    assert.equal(
      setupNodes.length,
      1,
      `${jobId} must have exactly one setup-node step (found ${String(setupNodes.length)})`,
    );

    const steps = parseSteps(jobBlock);
    const checkoutIndex = steps.findIndex((step) => stepUsesCheckout(step));
    const setupIndex = steps.findIndex((step) => stepUsesSetupNode(step));
    assert.notEqual(checkoutIndex, -1, `${jobId} must declare checkout in steps`);
    assert.notEqual(setupIndex, -1, `${jobId} must declare setup-node in steps`);
    assert.ok(
      checkoutIndex < setupIndex,
      `${jobId} checkout must precede setup-node (checkout=${String(checkoutIndex)} setup=${String(setupIndex)})`,
    );

    const setupNodeVersion = setupNodeVersionForStep(steps[setupIndex]);
    assert.equal(
      setupNodeVersion,
      NODE_VERSION,
      `${jobId} setup-node must pin ${NODE_VERSION} on its own with block (found ${String(setupNodeVersion)})`,
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
    const checkoutIndex = steps.findIndex((step) => stepUsesCheckout(step));
    const setupIndex = steps.findIndex((step) => stepUsesSetupNode(step));
    assert.notEqual(checkoutIndex, -1, `${jobId} pack-smoke job must declare checkout`);
    assert.notEqual(setupIndex, -1, `${jobId} pack-smoke job must declare setup-node`);
    assert.ok(
      checkoutIndex < setupIndex,
      `${jobId} checkout must precede setup-node before pack:smoke`,
    );
    const npmStepIndex = steps.findIndex((step) => step.name === NPM_STEP_NAME);
    assert.notEqual(npmStepIndex, -1, `${jobId} must include the named npm install step`);
    assert.ok(
      setupIndex < npmStepIndex,
      `${jobId} setup-node must precede npm pin step`,
    );
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
  const mutant = workflow.replace(/\n  trace:\n[\s\S]*?(?=\n  contribution:)/, '\n');
  expectValidationFailure(
    mutant,
    /missing required pack-smoke job trace|missing required setup-node job trace/,
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
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /setup-node must pin 22\.23\.1 on its own with block/);
});

test('mutation: legacy-peer-deps workaround fails', () => {
  const mutant = `${workflow}\n# legacy-peer-deps\n`;
  assert.throws(() => validateEvidenceCiWorkflow(mutant), /legacy-peer-deps/i);
});

test('mutation: anonymous one-line pack:smoke before npm pin fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      )- name: Install npm 11\.19\.0 for pack-smoke/,
    '$1- run: yarn pack:smoke\n      - name: Install npm 11.19.0 for pack-smoke',
  );
  expectValidationFailure(mutant, /trace npm pin step must precede pack:smoke step/);
});

test('mutation: anonymous multiline pack:smoke before npm pin fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      )- name: Install npm 11\.19\.0 for pack-smoke/,
    '$1- run: |\n          yarn pack:smoke\n      - name: Install npm 11.19.0 for pack-smoke',
  );
  expectValidationFailure(mutant, /trace npm pin step must precede pack:smoke step/);
});

test('mutation: unnamed npm step before pack:smoke fails', () => {
  const mutant = workflow.replace(
    '      - name: Install npm 11.19.0 for pack-smoke\n        run: |',
    '      - run: |\n          npm install -g npm@11.19.0\n          echo "$(npm prefix -g)/bin" >> "$GITHUB_PATH"\n          test "$(npm --version)" = "11.19.0"\n      - run: |',
  );
  expectValidationFailure(mutant, /must include the named npm install step/);
});

test('mutation: anonymous pack:smoke inserted before npm pin in trace job fails', () => {
  const mutant = workflow.replace(
    '  trace:\n    name: Evidence Trace\n    needs: [foundation]\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4',
    '  trace:\n    name: Evidence Trace\n    needs: [foundation]\n    runs-on: ubuntu-latest\n    steps:\n      - run: yarn pack:smoke\n      - uses: actions/checkout@v4',
  );
  expectValidationFailure(mutant, /npm pin step must precede pack:smoke step at index 0/);
});

test('mutation: remove setup-node from trace job fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - uses: actions\/checkout@v4\n(?:        with:\n          ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}\n)?)(      - uses: actions\/setup-node@v7\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1',
  );
  expectValidationFailure(mutant, /trace must have exactly one setup-node step \(found 0\)/);
});

test('mutation: duplicate setup-node in architecture job fails', () => {
  const mutant = workflow.replace(
    /(  architecture:[\s\S]*?      - uses: actions\/setup-node@v7\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1      - uses: actions/setup-node@v7\n        with:\n          node-version: 22.23.1\n',
  );
  expectValidationFailure(
    mutant,
    /architecture must have exactly one setup-node step \(found 2\)/,
  );
});

test('mutation: setup-node before checkout in trace job fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?steps:\n)(      - uses: actions\/checkout@v4\n(?:        with:\n          ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}\n)?)(      - uses: actions\/setup-node@v7\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1      - uses: actions/setup-node@v7\n        with:\n          node-version: 22.23.1\n$2',
  );
  expectValidationFailure(mutant, /trace checkout must precede setup-node/);
});

test('mutation: duplicate checkout in foundation job fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?      - uses: actions\/checkout@v4\n)/,
    '$1      - uses: actions/checkout@v4\n',
  );
  expectValidationFailure(mutant, /foundation must have exactly one checkout step \(found 2\)/);
});

test('mutation: missing checkout in derivation job fails', () => {
  const mutant = workflow.replace(
    /(  derivation:[\s\S]*?steps:\n)      - uses: actions\/checkout@v4\n/,
    '$1',
  );
  expectValidationFailure(mutant, /derivation must have exactly one checkout step \(found 0\)/);
});

test('mutation: wrong setup-node version in foundation job fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?node-version: )22\.23\.1/,
    '$122.0.0',
  );
  expectValidationFailure(mutant, /foundation setup-node must pin 22\.23\.1 on its own with block/);
});

test('mutation: bare setup-node with decoy node-version in later step fails', () => {
  const mutant = workflow
    .replace(
      /(  trace:[\s\S]*?      - uses: actions\/setup-node@v7\n)(        with:\n          node-version: 22\.23\.1\n)/,
      '$1',
    )
    .replace(
      /(  trace:[\s\S]*?      - name: Enable Yarn 4\.13\.0\n)/,
      '      - run: echo decoy\n        with:\n          node-version: 22.23.1\n$1',
    );
  expectValidationFailure(
    mutant,
    /trace setup-node must pin 22\.23\.1 on its own with block \(found undefined\)/,
  );
});

test('mutation: job-level node-version decoy fails', () => {
  const mutant = workflow.replace(
    /(  trace:\n    name: Evidence Trace\n    needs: \[foundation\]\n    runs-on: ubuntu-latest\n)/,
    '$1    env:\n      node-version: 22.23.1\n',
  ).replace(
    /(  trace:[\s\S]*?      - uses: actions\/setup-node@v7\n        with:\n          node-version: )22\.23\.1/,
    '$122.0.0',
  );
  expectValidationFailure(
    mutant,
    /trace setup-node must pin 22\.23\.1 on its own with block/,
  );
});

test('mutation: setup-node without with block fails', () => {
  const mutant = workflow.replace(
    /(  architecture:[\s\S]*?      - uses: actions\/setup-node@v7\n)(        with:\n          node-version: 22\.23\.1\n)/,
    '$1',
  );
  expectValidationFailure(
    mutant,
    /architecture setup-node must pin 22\.23\.1 on its own with block \(found undefined\)/,
  );
});

test('mutation: wrong-indentation node-version outside setup with fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?      - uses: actions\/setup-node@v7\n        with:\n)          node-version: 22\.23\.1\n/,
    '$1        node-version: 22.23.1\n',
  );
  expectValidationFailure(
    mutant,
    /foundation setup-node must pin 22\.23\.1 on its own with block \(found undefined\)/,
  );
});

test('mutation: duplicate uses in trace setup step fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - uses: actions\/setup-node@v7\n)(        with:\n          node-version: 22\.23\.1\n)/,
    '$1        uses: actions/setup-node@v7\n$2',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "uses"/);
});

test('mutation: duplicate run in trace npm step fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - name: Install npm 11\.19\.0 for pack-smoke\n        run: \|)/,
    '$1\n        run: echo duplicate',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "run"/);
});

test('mutation: duplicate node-version in setup with block fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?      - uses: actions\/setup-node@v7\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1          node-version: 22.23.1\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "node-version"/);
});

test('mutation: duplicate job key fails', () => {
  const mutant = `${workflow}\n  trace:\n    runs-on: ubuntu-latest\n`;
  expectValidationFailure(mutant, /duplicate YAML mapping key "trace"/);
});

test('mutation: duplicate indented step name inside npm step fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - name: Install npm 11\.19\.0 for pack-smoke\n        run: \|)/,
    '$1\n        name: duplicate step name',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "name"/);
});

test('mutation: duplicate indented uses inside setup step fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - uses: actions\/setup-node@v7\n        with:\n          node-version: 22\.23\.1\n)/,
    '$1        uses: actions/setup-node@v7\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "uses"/);
});

test('mutation: duplicate working-directory inside step fails', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - name: Enable Yarn 4\.13\.0\n)/,
    '      - name: Enable Yarn 4.13.0\n        working-directory: packages/evidence/trace\n        working-directory: packages/evidence/trace\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "working-directory"/);
});

test('mutation: colon-like line inside run block scalar does not false-positive', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - name: Install npm 11\.19\.0 for pack-smoke\n        run: \|\n)(          npm install -g npm@11\.19\.0\n)/,
    '$1          name: not-a-yaml-key\n$2',
  );
  assert.doesNotThrow(() => validateEvidenceCiWorkflow(mutant));
});

test('mutation: malformed dedent after block scalar still catches duplicate run', () => {
  const mutant = workflow.replace(
    /(  trace:[\s\S]*?      - name: Install npm 11\.19\.0 for pack-smoke\n        run: \|)/,
    '$1\n        run: echo duplicate',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "run"/);
});

test('mutation: duplicate job-level runs-on fails', () => {
  const mutant = workflow.replace(
    /(  trace:\n    name: Evidence Trace\n    needs: \[foundation\]\n    runs-on: ubuntu-latest\n)/,
    '$1    runs-on: ubuntu-latest\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "runs-on"/);
});

test('mutation: duplicate step env key fails', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?      - name: Enable Yarn 4\.13\.0\n        run: \|\n          corepack enable\n)/,
    '$1        env:\n          FOO: one\n          FOO: two\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "FOO"/);
});

test('mutation: duplicate root env key fails', () => {
  const mutant = workflow.replace(
    /^env:\n  EVIDENCE_ROOT: packages\/evidence\n/m,
    'env:\n  EVIDENCE_ROOT: packages/evidence\n  EVIDENCE_ROOT: packages/evidence\n',
  );
  expectValidationFailure(mutant, /duplicate YAML mapping key "EVIDENCE_ROOT"/);
});

test('mutation: duplicate env key in different steps remains valid', () => {
  const mutant = workflow.replace(
    /(  foundation:[\s\S]*?      - name: Enable Yarn 4\.13\.0\n        run: \|\n          corepack enable\n)/,
    '$1        env:\n          STEP_A: one\n      - name: Decoy second step\n        env:\n          STEP_A: two\n        run: echo ok\n',
  );
  assert.doesNotThrow(() => validateEvidenceCiWorkflow(mutant));
});

test('mutation: YAML merge key fails closed', () => {
  const mutant = workflow.replace(
    'permissions:\n  contents: read\n',
    'permissions:\n  <<: *anchor\n  contents: read\n',
  );
  expectValidationFailure(mutant, /unsupported YAML anchor\/merge construct/);
});
