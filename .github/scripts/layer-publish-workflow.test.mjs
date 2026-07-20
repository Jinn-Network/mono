import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/layer-npm-publish.yml'),
  'utf8',
);
const ci = readFileSync(
  resolve(root, '.github/workflows/layer-ci.yml'),
  'utf8',
);

test('layer CI is paths-filtered and rehearses the npm-shaped package', () => {
  assert.match(ci, /'packages\/layer\/\*\*'/);
  assert.match(ci, /yarn pack:smoke/);
  assert.match(ci, /yarn typecheck/);
  assert.match(ci, /yarn test/);
  assert.match(ci, /yarn build/);
});

test('canary publication is dependency ordered and restricted to next', () => {
  assert.match(workflow, /branches: \[next\]/);
  assert.match(workflow, /plugin-canary:/);
  assert.match(workflow, /core-canary:/);
  assert.match(workflow, /needs: plugin-canary/);
  assert.match(workflow, /layer-canary:/);
  assert.match(workflow, /needs: core-canary/);
  assert.match(workflow, /-canary\.\$\{SHORT_SHA\}/);
  assert.match(workflow, /npm publish --access public --tag canary/);
  assert.match(workflow, /id-token: write/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\./);
});

test('local pack smoke never publishes', () => {
  const smoke = readFileSync(
    resolve(root, 'packages/layer/scripts/pack-smoke.mjs'),
    'utf8',
  );
  assert.match(smoke, /npm.*pack/s);
  assert.match(smoke, /session.*pickup/s);
  assert.match(smoke, /session.*end/s);
  assert.doesNotMatch(smoke, /npm['"]?,\s*\[['"]publish/);
  assert.doesNotMatch(smoke, /npm publish/);
});
