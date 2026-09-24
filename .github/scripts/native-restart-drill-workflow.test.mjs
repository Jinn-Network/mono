// SPDX-License-Identifier: Apache-2.0
//
// Pins the Phase B restart-drill CI lane (#4194): scheduled/manual, Foundry,
// the full operator dependency-stack build, `yarn drill:native-restart:verify`,
// never a merge-queue required context.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { REQUIRED_CHECK_SET } from './required-check-set.mjs';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/native-restart-drill.yml');
const ciPath = resolve(root, '.github/workflows/ci.yml');
const hermeticPath = resolve(root, '.github/workflows/hermetic-gate.yml');

function readWorkflow() {
  assert.equal(
    existsSync(workflowPath),
    true,
    'native-restart-drill.yml must exist so the Phase B restart drill runs in CI (#4194)',
  );
  return readFileSync(workflowPath, 'utf8');
}

function commentStripped(source) {
  return source.replaceAll(/^[ \t]*#.*$/gmu, '');
}

function onBlock(source) {
  const stripped = commentStripped(source);
  const match = stripped.match(/^["']?on["']?:\n(?<body>[\s\S]*?)(?=^\S)/mu);
  assert.notEqual(match, null, 'workflow must declare a top-level on: block');
  return match.groups.body;
}

test('the restart-drill lane exists as its own scheduled workflow', () => {
  const source = readWorkflow();
  assert.match(source, /^name: native-restart-drill$/mu);
});

test('the lane is nightly plus workflow_dispatch, never a merge-path trigger', () => {
  const on = onBlock(readWorkflow());
  assert.match(on, /^ {2}workflow_dispatch:/mu);
  assert.match(on, /^ {2}schedule:/mu);
  assert.match(on, /cron: '0 4 \* \* \*'/u);
  assert.doesNotMatch(on, /^ {2}pull_request:/mu);
  assert.doesNotMatch(on, /^ {2}merge_group:/mu);
  assert.doesNotMatch(on, /^ {2}push:/mu);
});

test('the job installs Foundry, builds the full operator dependency stack, and runs the verify script', () => {
  const source = readWorkflow();
  assert.match(source, /uses: foundry-rs\/foundry-toolchain@v1/u);
  assert.match(source, /yarn install --immutable/u);
  // build:stack alone is not enough: build:core depends on the plugin package,
  // and the drill's role hosts import @jinn-network/core's built dist/index.js.
  assert.match(
    source,
    /yarn build:sdk && yarn build:stack && yarn build:plugin && yarn build:core/u,
  );
  assert.match(source, /yarn drill:native-restart:verify/u);
  assert.match(source, /^ {4}timeout-minutes: 120$/mu);
  assert.match(source, /working-directory: operator/u);
  // The build step must run after install and before the verify script, not just exist.
  // Comment lines are stripped first: the header prose above names both commands too, ahead
  // of the actual steps.
  const stripped = commentStripped(source);
  const installIndex = stripped.indexOf('yarn install --immutable');
  const buildIndex = stripped.indexOf('yarn build:sdk && yarn build:stack && yarn build:plugin && yarn build:core');
  const verifyIndex = stripped.indexOf('yarn drill:native-restart:verify');
  assert.ok(installIndex >= 0 && buildIndex > installIndex && verifyIndex > buildIndex);
});

test('the lane reds on failure without becoming a required merge-queue context', () => {
  const source = readWorkflow();
  assert.match(source, /^permissions:\n {2}contents: read$/mu);
  assert.equal(
    REQUIRED_CHECK_SET.some((member) => member.workflow === 'native-restart-drill.yml'),
    false,
    'native-restart-drill.yml must stay off the required-check set — Anvil+process weight is advisory',
  );
  assert.match(source, /ONNXRUNTIME_NODE_INSTALL: skip/u);
  assert.match(source, /ONNXRUNTIME_NODE_INSTALL_CUDA: skip/u);
});

test('the merge-path operator lanes still exclude the drill e2e', () => {
  const ci = readFileSync(ciPath, 'utf8');
  const hermetic = readFileSync(hermeticPath, 'utf8');
  assert.doesNotMatch(ci, /drill:native-restart:verify/u);
  assert.doesNotMatch(hermetic, /drill:native-restart:verify/u);
});
