// Every workflow job that installs a Playwright browser runs on ubuntu-24.04 (#5173).
//
// GitHub's `ubuntu-latest` label moved to Ubuntu 26.04, where the Playwright versions in this tree
// stop at "Playwright does not support chromium on ubuntu26.04-x64". The move is gradual, so a job
// on `ubuntu-latest` passed or failed by which runner it landed on, and one of those jobs is the
// required hermetic gate. Each such job names the image its Playwright supports.
//
// Like `workflow-npm-pin.test.mjs`, this reads the workflow text rather than a YAML document:
// Repository structure runs it before any dependency is installed. Jobs are the keys indented one
// level under `jobs:`; the level is read off the first job key, not assumed.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = join(root, '.github/workflows');
const RUNNER = 'ubuntu-24.04';

function jobsOf(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return [];
  const firstKey = lines.slice(jobsAt + 1).find((line) => /^\s+[A-Za-z_][\w-]*:\s*(?:#.*)?$/u.test(line));
  if (firstKey === undefined) return [];
  const indent = firstKey.match(/^\s*/u)[0];
  const jobKey = new RegExp(`^${indent}([A-Za-z_][\\w-]*):\\s*(?:#.*)?$`, 'u');
  const jobs = [];
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/u.test(line)) break;
    const key = line.match(jobKey);
    if (key) jobs.push({ id: key[1], body: [] });
    else jobs.at(-1)?.body.push(line);
  }
  return jobs.map(({ id, body }) => ({ id, text: body.join('\n') }));
}

const playwrightJobs = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .flatMap((file) => jobsOf(readFileSync(join(workflowsDir, file), 'utf8'))
    .filter(({ text }) => /playwright install/u.test(text))
    .map((job) => ({ ...job, name: `${file}#${job.id}` })));

test('the jobs that install a Playwright browser are found', () => {
  const names = playwrightJobs.map(({ name }) => name);
  for (const known of ['benchmark-product-ci.yml#web', 'ci.yml#dashboard-e2e', 'hermetic-gate.yml#hermetic']) {
    assert.ok(names.includes(known), `${known} installs a Playwright browser and must be found`);
  }
});

test(`every job that installs a Playwright browser runs on ${RUNNER}`, () => {
  for (const { name, text } of playwrightJobs) {
    const runsOn = text.match(/^\s*runs-on:\s*(\S+)/mu)?.[1];
    assert.equal(runsOn, RUNNER, `${name} installs a Playwright browser, so it must run on ${RUNNER}`);
  }
});
