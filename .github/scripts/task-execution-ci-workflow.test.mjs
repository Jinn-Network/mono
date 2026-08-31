import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/task-execution-ci.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const packedTypesSource = readFileSync(
  resolve(root, '.github/scripts/task-execution-packed-types.test.mjs'),
  'utf8',
);
const inventorySource = readFileSync(
  resolve(root, '.github/scripts/task-execution-package-inventory.test.mjs'),
  'utf8',
);

/** @type {[string, string][]} */
const PACKED_PACKAGES = [
  ['protocol', '@jinn-network/task-execution-protocol'],
  ['backend', '@jinn-network/task-execution-backend'],
  ['testing', '@jinn-network/task-execution-testing'],
  ['profiles', '@jinn-network/task-execution-profiles'],
  ['backend-local/supervisor', '@jinn-network/task-execution-supervisor'],
  ['backend-local/workspace', '@jinn-network/task-execution-workspace'],
  ['backend-local/launchers', '@jinn-network/task-execution-launchers'],
  ['backend-local/assembly', '@jinn-network/task-execution-backend-local'],
  ['evaluation-harness', '@jinn-network/task-execution-evaluation-harness'],
  ['evaluator-adapters', '@jinn-network/task-execution-evaluator-adapters'],
  ['oci-grader', '@jinn-network/task-execution-oci-grader'],
];

/** @type {[string, string][]} */
const INVENTORY_PACKAGES = [
  ['protocol', '@jinn-network/task-execution-protocol'],
  ['backend', '@jinn-network/task-execution-backend'],
  ['testing', '@jinn-network/task-execution-testing'],
  ['profiles', '@jinn-network/task-execution-profiles'],
  ['backend-local/supervisor', '@jinn-network/task-execution-supervisor'],
  ['backend-local/workspace', '@jinn-network/task-execution-workspace'],
  ['backend-local/launchers', '@jinn-network/task-execution-launchers'],
  ['backend-local/assembly', '@jinn-network/task-execution-backend-local'],
  ['evaluation-harness', '@jinn-network/task-execution-evaluation-harness'],
  ['evaluator-adapters', '@jinn-network/task-execution-evaluator-adapters'],
  ['oci-grader', '@jinn-network/task-execution-oci-grader'],
];

test('packed-types source stays aligned with the canonical pack list', () => {
  for (const [, packageName] of PACKED_PACKAGES) {
    assert.match(
      packedTypesSource,
      new RegExp(`'${packageName.replace(/\//gu, '\\/')}'`),
      `${packageName} must appear in task-execution-packed-types.test.mjs`,
    );
  }
});

test('inventory source stays aligned with the canonical package inventory', () => {
  for (const [packagePath, packageName] of INVENTORY_PACKAGES) {
    const escapedPath = packagePath.replace(/\//gu, '\\/');
    const escapedName = packageName.replace(/\//gu, '\\/');
    assert.match(
      inventorySource,
      new RegExp(`\\['${escapedPath}', '${escapedName}'\\]`),
      `${packageName} must appear in task-execution-package-inventory.test.mjs`,
    );
  }
});

// Consolidated shape (#2997): the packages job verifies every inventory
// package in one workspace, in dependency order, with the packed-types
// compile at the tail. There is no artifact staging left to align - the
// alignment guarantee is now positional: every package's verbatim verify
// step must precede the packed-types step in the same job.

function packagesJobBlock() {
  const start = workflow.indexOf('\n  packages:\n');
  assert.notEqual(start, -1, 'workflow must declare the consolidated packages job');
  const end = workflow.indexOf('\n  ', start + 14);
  return end === -1 ? workflow.slice(start) : workflow.slice(start);
}

test('every inventory package is verified inside the consolidated packages job', () => {
  const block = packagesJobBlock();
  for (const [packagePath] of INVENTORY_PACKAGES) {
    const marker = `        working-directory: packages/task-execution/${packagePath}\n`;
    const at = block.indexOf(marker);
    assert.notEqual(at, -1, `packages job must carry a step in packages/task-execution/${packagePath}`);
    const stepBlock = block.slice(at, at + 700);
    for (const command of ['yarn typecheck', 'yarn test', 'yarn build']) {
      assert.ok(
        stepBlock.includes(command),
        `the ${packagePath} verify step must run ${command}`,
      );
    }
  }
});

test('the packed-types compile runs after every package verify', () => {
  const block = packagesJobBlock();
  const packedAt = block.indexOf('task-execution-packed-types.test.mjs');
  assert.notEqual(packedAt, -1, 'packages job must end with the packed-types compile');
  for (const [packagePath] of INVENTORY_PACKAGES) {
    const at = block.indexOf(`        working-directory: packages/task-execution/${packagePath}\n`);
    assert.ok(
      at < packedAt,
      `${packagePath} must be verified before the packed-types compile consumes its dist`,
    );
  }
});

test('the consolidated workflow carries no artifact round-trips', () => {
  // Dist hand-offs between jobs are exactly what the consolidation removed;
  // one creeping back in would silently reintroduce the staging-alignment
  // problem this file used to police.
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact/u);
});

test('the native custody binary is built and probed in-workspace', () => {
  assert.match(workflow, /build-native\.mjs/u, 'the assembly step must rebuild the native shim');
  assert.match(
    workflow,
    /JINN_NATIVE_CUSTODY_BINARY/u,
    'the custody binary path must stay pinned for the assembly and harness steps',
  );
});
