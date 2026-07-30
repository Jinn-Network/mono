import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAcceptanceArgs, renderAcceptanceSpec } from './stack-external-acceptance.mjs';

const VERSION = `0.1.0-canary.sha.${'d'.repeat(40)}`;

test('an exact version is required', () => {
  assert.deepEqual(parseAcceptanceArgs(['--version', VERSION]), {
    version: VERSION, registry: 'https://registry.npmjs.org', keep: false,
  });
  assert.throws(() => parseAcceptanceArgs(['--version', '^0.1.0']), /--version must be an exact version, got \^0\.1\.0/);
  assert.throws(() => parseAcceptanceArgs(['--version', 'canary']), /--version must be an exact version, got canary/);
  assert.throws(() => parseAcceptanceArgs([]), /--version is required/);
  assert.throws(() => parseAcceptanceArgs(['--nope', '1']), /unknown argument: --nope/);
});

test('the acceptance spec runs the published backend-contract kit against the published fake', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.match(spec, /from "@jinn-network\/task-execution-testing"/);
  assert.match(spec, /describeTaskExecutionBackendContract\(\(\) => createInMemoryBackend\(\)\)/);
});

test('the acceptance spec proves a schema is retrievable from the installed package', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.match(spec, /import\.meta\.resolve\("@jinn-network\/task-execution-protocol\/schemas\/task\.schema\.json"\)/);
  assert.match(spec, /json-schema\.org\/draft\/2020-12\/schema/);
});

test('the acceptance spec never reads from the repository under test', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.doesNotMatch(spec, /\.\.\//, 'no relative escape into the repository');
  assert.doesNotMatch(spec, /portal:/);
});
