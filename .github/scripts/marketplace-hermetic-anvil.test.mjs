import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

const pullRequestSurfaces = [
  '.github/workflows/marketplace-ci.yml',
  '.github/workflows/platform-verification.yml',
  '.github/workflows/platform-architecture-control.yml',
  '.github/workflows/stack-npm-publish.yml',
  'packages/marketplace/testing/src/backend-conformance.test.ts',
  'packages/marketplace/testing/src/escrow-lifecycle.test.ts',
  'packages/marketplace/testing/src/venue-fork.ts',
];

test('marketplace PR verification cannot depend on a live chain RPC', () => {
  for (const path of pullRequestSurfaces) {
    const source = read(path);
    assert.doesNotMatch(source, /JINN_MARKETPLACE_FORK_RPC_URL/u, path);
    assert.doesNotMatch(source, /--fork-url/u, path);
    assert.doesNotMatch(source, /https:\/\/(?:base-sepolia[^\s"']*|sepolia\.base\.org)/u, path);
  }
});

test('marketplace Anvil verification binds the committed snapshot explicitly', () => {
  const workflow = read('.github/workflows/marketplace-ci.yml');
  const harness = read('packages/marketplace/testing/src/anvil-state.ts');

  assert.match(workflow, /JINN_MARKETPLACE_ANVIL_STATE_PATH/u);
  assert.match(workflow, /operator\/test\/_support\/fixtures\/anvil-base-v3-state\/state\.json/u);
  assert.match(workflow, /src\/escrow-lifecycle\.test\.ts/u);
  assert.match(harness, /--load-state/u);
  assert.match(harness, /--chain-id/u);
  assert.match(harness, /--slots-in-an-epoch/u);
  assert.match(harness, /84532/u);
});
