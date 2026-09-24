import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'operator';
const treeRoot = join(root, TREE);

function manifest() {
  const path = join(treeRoot, 'package.json');
  assert.ok(existsSync(path), `missing manifest: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The published identity is @jinn-network/operator.
test('operator package keeps its published identity', () => {
  const pkg = manifest();
  assert.equal(pkg.name, '@jinn-network/operator');
  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
  assert.equal(pkg.packageManager, 'yarn@4.13.0');
});

test('operator workspaces are exactly the nested packages glob', () => {
  assert.deepEqual(manifest().workspaces, ['packages/*']);
});

// Runtime deps are versioned (the tarball must resolve them from the
// registry); portal edges are relative and depth-preserving, so the
// rename must leave every spec byte-identical.
// Inventories the 2026-08-15 operator graph (post one-swap), not the July
// three-package sketch in the stage-5 plan.
const EXPECTED_JINN_DEPENDENCIES = {
  "@jinn-network/attestation-issuer": "0.1.0",
  "@jinn-network/contract-abis": "0.1.0",
  "@jinn-network/core": "0.1.2",
  "@jinn-network/environment-record": "0.1.0",
  "@jinn-network/evidence-catalog-sqlite": "0.1.0",
  "@jinn-network/evidence-discovery": "0.1.0",
  "@jinn-network/evidence-local-runtime": "0.1.0",
  "@jinn-network/evidence-protocol": "0.1.0",
  "@jinn-network/evidence-repository": "0.1.0",
  "@jinn-network/execution-evidence-builder": "0.1.0",
  "@jinn-network/execution-recorder": "0.1.0",
  "@jinn-network/lifecycle-notifications": "0.1.0",
  "@jinn-network/marketplace-binding": "0.1.0",
  "@jinn-network/marketplace-pipeline": "0.1.0",
  "@jinn-network/marketplace-projector": "0.1.0",
  "@jinn-network/marketplace-venue-base": "0.1.0",
  "@jinn-network/plugin": "0.1.2",
  "@jinn-network/policy-identity": "0.1.0",
  "@jinn-network/record-discovery-client": "0.1.0",
  "@jinn-network/record-discovery-facts-task-execution": "0.1.0",
  "@jinn-network/record-discovery-protocol": "0.1.0",
  "@jinn-network/record-discovery-serve": "0.1.0",
  "@jinn-network/record-discovery-transport-http": "0.1.0",
  "@jinn-network/read-plane": "0.1.0",
  "@jinn-network/sdk": "0.2.0",
  "@jinn-network/task-admission": "0.1.0",
  "@jinn-network/task-execution-backend": "0.1.0",
  "@jinn-network/task-execution-backend-local": "0.1.0",
  "@jinn-network/task-execution-evaluation-harness": "0.1.0",
  "@jinn-network/task-execution-evaluator-adapters": "0.1.0",
  "@jinn-network/task-execution-launchers": "0.1.0",
  "@jinn-network/task-execution-profiles": "0.1.0",
  "@jinn-network/task-execution-protocol": "0.1.0",
  "@jinn-network/task-execution-supervisor": "0.1.0",
  "@jinn-network/task-execution-workspace": "0.1.0",
  "@jinn-network/trust-authoring": "0.1.0",
  "@jinn-network/trust-core": "0.1.0",
  "@jinn-network/trust-observation": "0.1.0",
  "@jinn-network/trust-resolve": "0.1.0"
};
const EXPECTED_JINN_DEV_DEPENDENCIES = {
  "@jinn-network/jinn-layer": "portal:../packages/layer",
  "@jinn-network/record-discovery-testing": "portal:../packages/discovery/testing"
};
const EXPECTED_JINN_RESOLUTIONS = {
  "@jinn-network/attestation-issuer": "portal:../packages/evidence/attestation-issuer",
  "@jinn-network/contract-abis": "portal:../packages/contract-abis",
  "@jinn-network/core": "portal:../packages/core",
  "@jinn-network/environment-record": "portal:../packages/environments/record",
  "@jinn-network/evidence-catalog-sqlite": "portal:../packages/evidence/catalog-sqlite",
  "@jinn-network/evidence-discovery": "portal:../packages/evidence/discovery",
  "@jinn-network/evidence-local-runtime": "portal:../packages/evidence/local-runtime",
  "@jinn-network/evidence-protocol": "portal:../packages/evidence/protocol",
  "@jinn-network/evidence-repository": "portal:../packages/evidence/repository",
  "@jinn-network/execution-evidence-builder": "portal:../packages/evidence/execution-evidence-builder",
  "@jinn-network/execution-recorder": "portal:../packages/evidence/execution-recorder",
  "@jinn-network/jinn-layer": "portal:../packages/layer",
  "@jinn-network/lifecycle-notifications": "portal:../packages/lifecycle-notifications",
  "@jinn-network/marketplace-binding": "portal:../packages/marketplace/binding",
  "@jinn-network/marketplace-pipeline": "portal:../packages/marketplace/pipeline",
  "@jinn-network/marketplace-projector": "portal:../packages/marketplace/projector",
  "@jinn-network/marketplace-venue-base": "portal:../packages/marketplace/venue-base",
  "@jinn-network/plugin": "portal:../packages/plugin",
  "@jinn-network/policy-identity": "portal:../packages/policy/identity",
  "@jinn-network/record-discovery-client": "portal:../packages/discovery/client",
  "@jinn-network/record-discovery-facts-task-execution": "portal:../packages/discovery/facts/task-execution",
  "@jinn-network/record-discovery-protocol": "portal:../packages/discovery/protocol",
  "@jinn-network/record-discovery-serve": "portal:../packages/discovery/serve",
  "@jinn-network/record-discovery-transport-http": "portal:../packages/discovery/transport-http",
  "@jinn-network/read-plane": "portal:../packages/read-plane",
  "@jinn-network/sdk": "portal:../packages/sdk",
  "@jinn-network/task-admission": "portal:../packages/task-supply/admission",
  "@jinn-network/task-execution-backend": "portal:../packages/task-execution/backend",
  "@jinn-network/task-execution-backend-local": "portal:../packages/task-execution/backend-local/assembly",
  "@jinn-network/task-execution-evaluation-harness": "portal:../packages/task-execution/evaluation-harness",
  "@jinn-network/task-execution-evaluator-adapters": "portal:../packages/task-execution/evaluator-adapters",
  "@jinn-network/task-execution-launchers": "portal:../packages/task-execution/backend-local/launchers",
  "@jinn-network/task-execution-profiles": "portal:../packages/task-execution/profiles",
  "@jinn-network/task-execution-protocol": "portal:../packages/task-execution/protocol",
  "@jinn-network/task-execution-supervisor": "portal:../packages/task-execution/backend-local/supervisor",
  "@jinn-network/task-execution-workspace": "portal:../packages/task-execution/backend-local/workspace",
  "@jinn-network/trust-authoring": "portal:../packages/trust/authoring",
  "@jinn-network/trust-core": "portal:../packages/trust/core",
  "@jinn-network/trust-observation": "portal:../packages/trust/observation",
  "@jinn-network/trust-resolve": "portal:../packages/trust/resolve"
};

function jinnEntries(section) {
  return Object.fromEntries(
    Object.entries(manifest()[section] ?? {})
      .filter(([name]) => name.startsWith('@jinn-network/'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

test('operator jinn dependency graph is the approved shape', () => {
  assert.deepEqual(jinnEntries('dependencies'), EXPECTED_JINN_DEPENDENCIES);
  assert.deepEqual(jinnEntries('devDependencies'), EXPECTED_JINN_DEV_DEPENDENCIES);
  assert.deepEqual(jinnEntries('resolutions'), EXPECTED_JINN_RESOLUTIONS);
  assert.deepEqual(jinnEntries('optionalDependencies'), {});
  assert.deepEqual(jinnEntries('peerDependencies'), {});
});

// Every portal target must exist on disk at the declared relative path. This
// is the check that fails loudly if the rename changes the tree's depth.
test('every operator portal target resolves on disk', () => {
  for (const spec of [
    ...Object.values(EXPECTED_JINN_DEV_DEPENDENCIES),
    ...Object.values(EXPECTED_JINN_RESOLUTIONS),
  ]) {
    if (!String(spec).startsWith('portal:')) continue;
    const target = resolve(treeRoot, spec.slice('portal:'.length));
    assert.ok(
      existsSync(join(target, 'package.json')),
      `portal target does not resolve: ${spec}`,
    );
  }
});
