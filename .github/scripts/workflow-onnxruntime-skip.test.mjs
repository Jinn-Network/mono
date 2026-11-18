// Every workflow job that installs a Yarn project resolving onnxruntime-node skips its optional
// CUDA download.
//
// On Linux x64 the onnxruntime-node postinstall downloads CUDA libraries that the npm package does
// not bundle. The 1.21.0 installer, reached through @lmoe/gliner-onnx and @huggingface/transformers
// 3, fetches them from the ONNX Runtime GitHub release page and reads ONNXRUNTIME_NODE_INSTALL_CUDA;
// newer installers fetch them from NuGet and read ONNXRUNTIME_NODE_INSTALL. No job here has a GPU,
// and the CPU binaries ship inside the npm package, so the download only adds a host the install
// can fail on. Most CPU-only lanes already set both variables to `skip`, added lane by lane; five never did. On
// 2026-11-18 the release URL returned 404 and one of the five, the jinn-agent cold-stock gate,
// failed at its first `yarn install` in the merge queue (#5392).
//
// A job is in scope when a setup-node step in it caches a lockfile that resolves onnxruntime-node:
// `workflow-yarn-cache.test.mjs` already makes every Yarn install list its lockfile there. A job in
// scope sets both variables to `skip` in its own `env:` or the workflow's. Like the other workflow
// guards, this reads the workflow text rather than a YAML document: Repository structure runs it
// before any dependency is installed.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = join(root, '.github/workflows');
const SKIP_VARIABLES = ['ONNXRUNTIME_NODE_INSTALL', 'ONNXRUNTIME_NODE_INSTALL_CUDA'];

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const isSkippable = (line) => line.trim() === '' || line.trimStart().startsWith('#');
const scalar = (value) => value.replace(/(?:^|\s)#.*$/u, '').trim().replace(/^(['"])(.*)\1$/u, '$2');

// The lines indented under `lines[at]`, up to the first line back at or above its indent.
function childrenOf(lines, at) {
  const children = [];
  for (const line of lines.slice(at + 1)) {
    if (isSkippable(line)) continue;
    if (indentOf(line) <= indentOf(lines[at])) break;
    children.push(line);
  }
  return children;
}

// The `NAME: value` pairs of the `env:` key at `indent` in `lines`, or an empty map.
function envAt(lines, indent) {
  const at = lines.findIndex((line) => indentOf(line) === indent && /^\s*env:\s*(?:#.*)?$/u.test(line));
  if (at === -1) return new Map();
  const children = childrenOf(lines, at);
  const level = children.length > 0 ? indentOf(children[0]) : 0;
  return new Map(children
    .filter((line) => indentOf(line) === level)
    .map((line) => line.match(/^\s*([A-Za-z_][\w]*):\s*(.*)$/u))
    .filter(Boolean)
    .map((match) => [match[1], scalar(match[2])]));
}

function jobsOf(source) {
  const lines = source.replace(/\r\n/gu, '\n').split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return { env: envAt(lines, 0), jobs: [] };
  const body = [];
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/u.test(line) && !line.startsWith('#')) break;
    body.push(line);
  }
  const jobIndent = indentOf(body.find((line) => !isSkippable(line)) ?? '');
  const jobs = [];
  for (const line of body) {
    const key = indentOf(line) === jobIndent && !isSkippable(line)
      ? line.match(/^\s*([A-Za-z_][\w-]*):\s*(?:#.*)?$/u)
      : null;
    if (key) jobs.push({ id: key[1], lines: [] });
    else jobs.at(-1)?.lines.push(line);
  }
  return {
    env: envAt(lines.slice(0, jobsAt), 0),
    jobs: jobs.map(({ id, lines: jobLines }) => {
      const propertyIndent = indentOf(jobLines.find((line) => !isSkippable(line)) ?? '');
      return { id, env: envAt(jobLines, propertyIndent), cached: cachedLockfiles(jobLines) };
    }),
  };
}

// Every entry of every `cache-dependency-path:` in the job, inline or as a block scalar.
function cachedLockfiles(lines) {
  return lines.flatMap((line, at) => {
    const match = line.match(/^\s*cache-dependency-path:\s*(.*)$/u);
    if (!match || isSkippable(line)) return [];
    const inline = scalar(match[1]);
    if (!/^[|>][+-]?\d*$/u.test(inline)) return inline === '' ? [] : [inline];
    return childrenOf(lines, at).map((entry) => scalar(entry)).filter(Boolean);
  });
}

function resolvesOnnxruntime(lockfile) {
  const path = join(root, lockfile);
  return existsSync(path) && /^"onnxruntime-node@/mu.test(readFileSync(path, 'utf8'));
}

// `<workflow>#<job>` for each job in scope, with the variables it leaves unset or not `skip`.
function onnxruntimeJobs(sources, resolves = resolvesOnnxruntime) {
  return sources.flatMap(({ name, source }) => {
    const workflow = jobsOf(source);
    return workflow.jobs
      .filter((job) => job.cached.some(resolves))
      .map((job) => {
        const env = new Map([...workflow.env, ...job.env]);
        return {
          name: `${name}#${job.id}`,
          missing: SKIP_VARIABLES.filter((variable) => env.get(variable) !== 'skip'),
        };
      });
  });
}

const workflowSources = readdirSync(workflowsDir)
  .filter((file) => /\.ya?ml$/u.test(file))
  .sort()
  .map((file) => ({ name: file, source: readFileSync(join(workflowsDir, file), 'utf8') }));

test('the lockfiles that resolve onnxruntime-node and the jobs that install them are found', () => {
  for (const lockfile of ['operator/yarn.lock', 'packages/core/yarn.lock', 'packages/layer/yarn.lock']) {
    assert.ok(resolvesOnnxruntime(lockfile), `${lockfile} resolves onnxruntime-node and must be found`);
  }
  const names = onnxruntimeJobs(workflowSources).map(({ name }) => name);
  for (const known of ['ci.yml#check', 'hermetic-gate.yml#hermetic', 'jinn-agent-ci.yml#cold-stock-e2e']) {
    assert.ok(names.includes(known), `${known} installs onnxruntime-node and must be found`);
  }
});

test('every job that installs onnxruntime-node skips its optional CUDA download', () => {
  const offenders = onnxruntimeJobs(workflowSources)
    .filter(({ missing }) => missing.length > 0)
    .map(({ name, missing }) => `${name} must set ${missing.map((variable) => `${variable}: skip`).join(' and ')}`);
  assert.deepEqual(offenders, []);
});

const fixture = (env, jobEnv = '') => ({
  name: 'fixture.yml',
  source: [
    'name: fixture',
    env,
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    jobEnv,
    '    steps:',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          cache: yarn',
    '          cache-dependency-path: |',
    '            operator/yarn.lock',
    '      - run: yarn install --immutable',
    '        working-directory: operator',
  ].join('\n'),
});
const both = (indent) => `${indent}env:\n${indent}  ONNXRUNTIME_NODE_INSTALL: skip\n${indent}  ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip'`;
const isOperator = (lockfile) => lockfile === 'operator/yarn.lock';

test('a job that installs onnxruntime-node without both variables is flagged', () => {
  assert.deepEqual(onnxruntimeJobs([fixture('')], isOperator), [
    { name: 'fixture.yml#build', missing: SKIP_VARIABLES },
  ]);
  assert.deepEqual(onnxruntimeJobs([fixture('env:\n  ONNXRUNTIME_NODE_INSTALL: skip')], isOperator), [
    { name: 'fixture.yml#build', missing: ['ONNXRUNTIME_NODE_INSTALL_CUDA'] },
  ]);
});

test('both variables set at the workflow or the job level pass', () => {
  assert.deepEqual(onnxruntimeJobs([fixture(both(''))], isOperator)[0].missing, []);
  assert.deepEqual(onnxruntimeJobs([fixture('', both('    '))], isOperator)[0].missing, []);
});

test('a job-level value that is not skip overrides the workflow-level skip', () => {
  const jobEnv = '    env:\n      ONNXRUNTIME_NODE_INSTALL_CUDA: v12';
  assert.deepEqual(onnxruntimeJobs([fixture(both(''), jobEnv)], isOperator)[0].missing, [
    'ONNXRUNTIME_NODE_INSTALL_CUDA',
  ]);
});

test('a job that caches no lockfile resolving onnxruntime-node is out of scope', () => {
  assert.deepEqual(onnxruntimeJobs([fixture('')], () => false), []);
});
