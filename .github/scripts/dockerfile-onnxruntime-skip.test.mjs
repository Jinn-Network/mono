// Every Dockerfile stage that runs Yarn in a project resolving onnxruntime-node skips its optional
// CUDA download first.
//
// `workflow-onnxruntime-skip.test.mjs` covers the workflow jobs; this covers the images. On Linux
// x64 the onnxruntime-node postinstall downloads CUDA libraries that no job or image here uses, and
// when that download returns 404 the install fails (#5392). The operator image sets both variables
// with ENV in its build stage (#5396), but no workflow builds that image before merge: Operator
// Images runs after a push to next and docker.yml at release. Nothing else would catch a change that
// drops or moves those lines.
//
// A stage is in scope when one of its RUN commands runs `yarn` in a directory holding a `yarn.lock`
// that resolves onnxruntime-node. The directory comes from WORKDIR and `cd`, and the lockfile from
// the COPY that placed it there, resolved against the build context (the repository root, or
// `packages/` as in the indexer images). Both ONNXRUNTIME_NODE_INSTALL and
// ONNXRUNTIME_NODE_INSTALL_CUDA must then be `skip` by ENV at that RUN. Like the workflow guards,
// this reads text rather than parsing the Dockerfile: Repository structure runs it before any
// dependency is installed.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const SKIP_VARIABLES = ['ONNXRUNTIME_NODE_INSTALL', 'ONNXRUNTIME_NODE_INSTALL_CUDA'];
const CONTEXTS = [root, join(root, 'packages')];

function resolvesOnnxruntime(lockfile) {
  return existsSync(lockfile) && /^"onnxruntime-node@/mu.test(readFileSync(lockfile, 'utf8'));
}

// The repository file a COPY source names, trying each build context an image here uses.
const sourceFile = (source) => CONTEXTS.map((context) => join(context, source)).find(existsSync);

// Instructions with continuation lines joined and comments dropped: `[keyword, arguments]`.
function instructionsOf(source) {
  const joined = source.replace(/\r\n/gu, '\n').replace(/\\[ \t]*\n/gu, ' ');
  return joined.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => [line.split(/\s+/u)[0].toUpperCase(), line.replace(/^\S+\s*/u, '')]);
}

// `KEY=value ...` pairs, or the legacy `KEY value` form, of one ENV instruction.
function envPairs(args) {
  const pairs = [...args.matchAll(/([A-Za-z_]\w*)=("[^"]*"|'[^']*'|\S*)/gu)]
    .map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/u, '$2')]);
  if (pairs.length > 0) return pairs;
  const legacy = args.match(/^(\S+)\s+(.*)$/u);
  return legacy ? [[legacy[1], legacy[2].trim()]] : [];
}

// The directory of every `yarn` command in a RUN, following `cd` segments from `workdir`.
function yarnDirectories(command, workdir) {
  let dir = workdir;
  const found = [];
  for (const segment of command.split(/&&|;|\|\||\|/u).map((part) => part.trim())) {
    const cd = segment.match(/^cd\s+(\S+)/u);
    if (cd) dir = posix.resolve(dir, cd[1]);
    else if (/(?:^|\s)yarn(?:\s|$)/u.test(segment)) found.push(dir);
  }
  return found;
}

// `<Dockerfile>:<line of the RUN>` text for each in-scope RUN, with the variables not `skip` there.
function onnxruntimeRuns(name, source, resolves = resolvesOnnxruntime) {
  const stages = new Map();
  let stage = { env: new Map(), lockfiles: new Map(), workdir: '/' };
  const runs = [];
  for (const [keyword, args] of instructionsOf(source)) {
    if (keyword === 'FROM') {
      const [base, , alias] = args.replace(/^--\S+\s+/u, '').split(/\s+/u);
      const inherited = stages.get(base);
      stage = inherited
        ? { env: new Map(inherited.env), lockfiles: new Map(inherited.lockfiles), workdir: inherited.workdir }
        : { env: new Map(), lockfiles: new Map(), workdir: '/' };
      stages.set(alias ?? String(stages.size), stage);
    } else if (keyword === 'ENV') {
      for (const [key, value] of envPairs(args)) stage.env.set(key, value);
    } else if (keyword === 'WORKDIR') {
      stage.workdir = posix.resolve(stage.workdir, args.trim());
    } else if (keyword === 'COPY' && !/--from=/u.test(args)) {
      const parts = args.split(/\s+/u).filter((part) => !part.startsWith('--'));
      const destination = parts.pop();
      const lockfile = parts.find((part) => posix.basename(part) === 'yarn.lock');
      if (lockfile && sourceFile(lockfile)) {
        stage.lockfiles.set(posix.resolve(stage.workdir, destination), sourceFile(lockfile));
      }
    } else if (keyword === 'RUN') {
      for (const dir of yarnDirectories(args, stage.workdir)) {
        const lockfile = stage.lockfiles.get(dir);
        if (lockfile && resolves(lockfile)) {
          runs.push({
            name: `${name} (${dir}): ${args.slice(0, 60)}`,
            missing: SKIP_VARIABLES.filter((variable) => stage.env.get(variable) !== 'skip'),
          });
        }
      }
    }
  }
  return runs;
}

function dockerfiles(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ['node_modules', '.git'].includes(entry.name) ? [] : dockerfiles(join(dir, entry.name));
    }
    return /^Dockerfile(?:\..+)?$/u.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

const sources = dockerfiles().sort().map((file) => ({
  name: relative(root, file),
  source: readFileSync(file, 'utf8'),
}));

test('the operator image build stage runs yarn against a lockfile that resolves onnxruntime-node', () => {
  const operator = sources.find(({ name }) => name === 'operator/Dockerfile');
  assert.ok(operator, 'operator/Dockerfile must be found');
  const runs = onnxruntimeRuns(operator.name, operator.source);
  assert.ok(runs.some(({ name }) => name.includes('yarn install')), 'its yarn install must be found');
  assert.ok(runs.some(({ name }) => name.includes('yarn build')), 'its yarn build must be found');
});

test('every Dockerfile stage that runs yarn on onnxruntime-node skips its optional CUDA download', () => {
  const offenders = sources
    .flatMap(({ name, source }) => onnxruntimeRuns(name, source))
    .filter(({ missing }) => missing.length > 0)
    .map(({ name, missing }) => `${name} must set ${missing.map((variable) => `${variable}=skip`).join(' and ')} first`);
  assert.deepEqual(offenders, []);
});

const fixture = (...before) => [
  'FROM node:22-slim AS build',
  'WORKDIR /app',
  'COPY operator/package.json operator/yarn.lock ./operator/',
  ...before,
  'RUN corepack enable && \\',
  '    cd operator && yarn install --immutable',
].join('\n');
const isOperator = (lockfile) => lockfile.endsWith('operator/yarn.lock');
const missingIn = (source, resolves = isOperator) => onnxruntimeRuns('fixture', source, resolves).map(({ missing }) => missing);

test('a stage that installs onnxruntime-node without both variables is flagged', () => {
  assert.deepEqual(missingIn(fixture()), [SKIP_VARIABLES]);
  assert.deepEqual(missingIn(fixture('ENV ONNXRUNTIME_NODE_INSTALL=skip')), [['ONNXRUNTIME_NODE_INSTALL_CUDA']]);
});

test('both variables set before the install pass, in either ENV form', () => {
  const both = ['ENV ONNXRUNTIME_NODE_INSTALL=skip', 'ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip'];
  assert.deepEqual(missingIn(fixture(...both)), [[]]);
  assert.deepEqual(missingIn(fixture('ENV ONNXRUNTIME_NODE_INSTALL=skip ONNXRUNTIME_NODE_INSTALL_CUDA="skip"')), [[]]);
  assert.deepEqual(missingIn(fixture('ENV ONNXRUNTIME_NODE_INSTALL skip', 'ENV ONNXRUNTIME_NODE_INSTALL_CUDA skip')), [[]]);
});

test('variables set after the install, or to another value, do not count', () => {
  const after = `${fixture()}\nENV ONNXRUNTIME_NODE_INSTALL=skip\nENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip`;
  assert.deepEqual(missingIn(after), [SKIP_VARIABLES]);
  assert.deepEqual(
    missingIn(fixture('ENV ONNXRUNTIME_NODE_INSTALL=skip', 'ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip', 'ENV ONNXRUNTIME_NODE_INSTALL_CUDA=v12')),
    [['ONNXRUNTIME_NODE_INSTALL_CUDA']],
  );
});

test('a stage that inherits the variables from an earlier stage passes; a fresh stage does not', () => {
  const base = [
    'FROM node:22-slim AS base',
    'ENV ONNXRUNTIME_NODE_INSTALL=skip',
    'ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip',
  ].join('\n');
  assert.deepEqual(missingIn(`${base}\n${fixture().replace('FROM node:22-slim AS build', 'FROM base AS build')}`), [[]]);
  assert.deepEqual(missingIn(`${base}\n${fixture()}`), [SKIP_VARIABLES]);
});

test('a yarn run in a project whose lockfile does not resolve onnxruntime-node is out of scope', () => {
  assert.deepEqual(missingIn(fixture(), () => false), []);
});

test('a later yarn build in WORKDIR is checked as well as the install', () => {
  const build = `${fixture()}\nWORKDIR /app/operator\nRUN yarn build`;
  assert.deepEqual(missingIn(build), [SKIP_VARIABLES, SKIP_VARIABLES]);
});
