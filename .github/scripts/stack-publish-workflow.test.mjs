import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(import.meta.dirname, '../workflows/stack-npm-publish.yml');
const workflow = readFileSync(workflowPath, 'utf8');

test('the canary lane triggers on both the integration branch and next', () => {
  assert.match(workflow, /branches:\s*\[integration\/evidence-v1, next\]/);
});

test('the workflow carries the OIDC permissions trusted publishing needs', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /checks: read/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test('the existence guard runs before any publish step', () => {
  const guardAt = workflow.indexOf('name: Guard on an empty platform package set');
  const publishAt = workflow.indexOf('name: Publish the platform package set');
  assert.ok(guardAt > -1, 'the existence guard step must exist');
  assert.ok(publishAt > -1, 'the publish step must exist');
  assert.ok(guardAt < publishAt, 'the existence guard must precede the publish step');
});

test('the existence guard distinguishes a genuinely empty package set from every other planning failure', () => {
  const occurrences = workflow.split('name: Guard on an empty platform package set').length - 1;
  assert.equal(occurrences, 3, 'the publish, registrations, and profile-root jobs must each guard on the package set');
  // Every guard occurrence must branch on the dedicated empty-set exit code (3) and
  // re-exit on any other non-zero status, rather than treating all failures as absence.
  const guardBlockCount = (workflow.match(/elif \[ "\$\{status\}" -eq 3 \]/g) ?? []).length;
  assert.equal(guardBlockCount, 3, 'every guard must special-case exit code 3, not swallow every non-zero exit as absence');
  assert.doesNotMatch(workflow, /if node \.github\/scripts\/publish-stack\.mjs/, 'the guard must not conflate any non-zero exit with absence');
});

test('the registration and profile-root jobs are gated on the same presence signal as the publish job', () => {
  const registrationsAt = workflow.indexOf('name: Trusted-publisher registration list');
  const profileRootAt = workflow.indexOf('name: Profile root artifact');
  assert.ok(registrationsAt > -1 && profileRootAt > -1);
  const registrationsBlock = workflow.slice(registrationsAt, profileRootAt);
  const profileRootBlock = workflow.slice(profileRootAt);
  for (const block of [registrationsBlock, profileRootBlock]) {
    assert.match(block, /name: Guard on an empty platform package set/);
    assert.match(block, /if: steps\.guard\.outputs\.present == 'true'/);
  }
});

test('the tree CI gate names all six platform CI workflows', () => {
  for (const name of ['Evidence CI', 'Trust CI', 'Task Execution CI', 'Record Discovery CI', 'Marketplace CI', 'Benchmarking CI']) {
    assert.ok(workflow.includes(name), `the tree CI gate must name "${name}"`);
  }
});

test('the workflow drives the derived publisher, never a hard-coded package list', () => {
  assert.match(workflow, /node \.github\/scripts\/publish-stack\.mjs --mode canary --sha "\$\{JINN_BUILD_COMMIT\}"/);
  assert.doesNotMatch(workflow, /@jinn-network\/(evidence|trust|task-execution|marketplace|benchmarking|record-discovery)-/);
});

test('the workflow pins the npm CLI version trusted publishing requires', () => {
  assert.match(workflow, /npm install -g npm@11\.16\.0/);
});

test('the stable lane runs from the protected stable environment', () => {
  assert.match(workflow, /name: stack-stable\n/);
  assert.match(workflow, /environment: npm-stable-publish/);
});

test('the stable lane derives its version from a stack-v tag', () => {
  assert.match(workflow, /node \.github\/scripts\/publish-stack\.mjs --mode stable --release-tag "\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'stack-v'\)/);
});

test('the stable lane refuses a release tag that is not on origin at the checked-out sha', () => {
  assert.match(workflow, /Release tag \$\{RELEASE_TAG\} points at/);
});

test('both lanes run external acceptance after publishing', () => {
  const occurrences = workflow.split('name: Registry consumer acceptance').length - 1;
  assert.equal(occurrences, 2, 'canary and stable lanes must each run external acceptance');
  const canaryPublishAt = workflow.indexOf('name: Publish the platform package set');
  const canaryAcceptAt = workflow.indexOf('name: Registry consumer acceptance');
  assert.ok(canaryPublishAt < canaryAcceptAt, 'acceptance must follow the publish step');
  assert.match(workflow, /node \.github\/scripts\/stack-external-acceptance\.mjs --version "\$\{ACCEPTANCE_VERSION\}"/);
});

test('acceptance waits for registry availability before installing', () => {
  assert.match(workflow, /name: Wait for the platform set on the registry/);
});

test('the stable lane runs the registry-backed fixture gate before publishing', () => {
  const gateAt = workflow.indexOf('name: Verify fixture immutability against the published set');
  const publishAt = workflow.indexOf('name: Publish the stable platform set');
  assert.ok(gateAt > -1, 'the registry-backed fixture gate must exist');
  assert.ok(gateAt < publishAt, 'the fixture gate must precede the stable publish');
});

test('the profile root is built and signed as an uploadable artifact', () => {
  assert.match(workflow, /name: jinn-profile-root/);
  const buildAt = workflow.indexOf('name: Build the static profile root');
  const signAt = workflow.indexOf('name: Sign the profile manifest');
  assert.ok(buildAt > -1 && signAt > buildAt, 'the manifest is signed after it is built');
  assert.match(workflow, /JINN_PROFILE_MANIFEST_SIGNING_KEY: \$\{\{ secrets\.JINN_PROFILE_MANIFEST_SIGNING_KEY \}\}/);
});
