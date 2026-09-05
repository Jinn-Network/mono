import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowsDir = resolve(root, '.github/workflows');

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
const scalar = (value) => unquote(value.replace(/\s+#.*$/u, ''));
const jobKeyPattern = /^(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*))$/u;

function mappingKey(line) {
  const match = line.match(/^(\s+)(.+?):\s*(?:#.*)?$/u);
  if (!match) return null;
  const key = match[2].match(jobKeyPattern);
  return key ? { indent: match[1].length, name: key[1] ?? key[2] ?? key[3] } : null;
}

function jobRanges(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return [];

  const jobsIndent = indentOf(lines[jobsAt]);
  const starts = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= jobsIndent) break;
    const key = mappingKey(line);
    if (key?.indent === jobsIndent + 2) starts.push({ index, name: key.name });
  }

  return starts.map((start, position) => ({
    name: start.name,
    lines: lines.slice(start.index, starts[position + 1]?.index ?? lines.length),
  }));
}

function stepsForJob(lines) {
  const jobIndent = indentOf(lines[0]);
  const stepsPattern = new RegExp(`^\\s{${jobIndent + 2}}steps:\\s*(?:#.*)?$`, 'u');
  const stepsAt = lines.findIndex((line) => stepsPattern.test(line));
  if (stepsAt === -1) return [];
  const stepsIndent = indentOf(lines[stepsAt]);
  const starts = [];
  for (let index = stepsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= stepsIndent) break;
    if (indentOf(line) === stepsIndent + 2 && /^\s*-\s+/u.test(line)) starts.push(index);
  }
  return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length));
}

function propertyValue(lines, property) {
  const stepIndent = indentOf(lines[0]);
  const pattern = new RegExp(
    `^(?:\\s{${stepIndent}}-\\s*|\\s{${stepIndent + 2}})${property}:\\s*(.*)$`,
    'u',
  );
  const at = lines.findIndex((line) => pattern.test(line));
  if (at === -1) return null;
  const match = lines[at].match(pattern);
  if (!['|', '|-', '>', '>-'].includes(match[1].trim())) return scalar(match[1]);

  const propertyIndent = indentOf(lines[at]);
  return blockAfter(lines, at, propertyIndent).join('\n');
}

function blockAfter(lines, at, propertyIndent) {
  const block = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= propertyIndent) break;
    block.push(line);
  }
  return block;
}

function withValues(lines) {
  const stepIndent = indentOf(lines[0]);
  const withPattern = new RegExp(
    `^(?:\\s{${stepIndent}}-\\s*|\\s{${stepIndent + 2}})with:\\s*(?:#.*)?$`,
    'u',
  );
  const withAt = lines.findIndex((line) => withPattern.test(line));
  if (withAt === -1) return new Map();
  const withIndent = indentOf(lines[withAt]);
  const values = new Map();

  for (let index = withAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= withIndent) break;
    const match = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!match || match[1].length !== withIndent + 2) continue;
    const raw = match[3].trim();
    if (!['|', '|-', '>', '>-'].includes(raw)) {
      values.set(match[2], scalar(raw));
      continue;
    }
    values.set(match[2], blockAfter(lines, index, match[1].length)
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith('#'))
      .join('\n'));
  }
  return values;
}

function setupNodeAction(lines) {
  const uses = propertyValue(lines, 'uses');
  return uses?.startsWith('actions/setup-node@') ?? false;
}

// Repository-structure runs this guard before installing dependencies, so keep the
// workflow reader self-contained. Unknown dynamic directories fail closed below;
// finite matrix axes and the repository's package-loop form expand to exact paths.
function defaultsWorkingDirectory(lines, defaultsIndent) {
  const defaultsPattern = new RegExp(`^\\s{${defaultsIndent}}defaults:\\s*(?:#.*)?$`, 'u');
  const defaultsAt = lines.findIndex((line) => defaultsPattern.test(line));
  if (defaultsAt === -1) return null;

  const runIndent = defaultsIndent + 2;
  const runPattern = new RegExp(`^\\s{${runIndent}}run:\\s*(?:#.*)?$`, 'u');
  const runAt = lines.findIndex((line, index) => index > defaultsAt && runPattern.test(line));
  if (runAt === -1) return null;

  const workingDirectoryPattern = new RegExp(
    `^\\s{${runIndent + 2}}working-directory:\\s*(.+)$`,
    'u',
  );
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= runIndent) break;
    const match = line.match(workingDirectoryPattern);
    if (match) return scalar(match[1]);
  }
  return null;
}

function matrixValues(lines, variable) {
  const jobIndent = indentOf(lines[0]);
  const matrixPattern = new RegExp(`^\\s{${jobIndent + 4}}matrix:\\s*(?:#.*)?$`, 'u');
  const matrixAt = lines.findIndex((line) => matrixPattern.test(line));
  if (matrixAt === -1) return [];

  const variableIndent = jobIndent + 6;
  const variablePattern = new RegExp(
    `^\\s{${variableIndent}}${variable}:\\s*(.*)$`,
    'u',
  );
  const variableAt = lines.findIndex((line, index) => index > matrixAt && variablePattern.test(line));
  if (variableAt === -1) return [];
  const raw = lines[variableAt].match(variablePattern)[1].trim();
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(scalar).filter(Boolean);
  }

  const itemPattern = new RegExp(`^\\s{${variableIndent + 2}}-\\s+(.+)$`, 'u');
  const values = [];
  for (let index = variableAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= variableIndent) break;
    const match = line.match(itemPattern);
    if (match) values.push(scalar(match[1]));
  }
  return values;
}

function expandWorkingDirectories(value, jobLines) {
  const workspaceExpanded = value.replace(/\$\{\{\s*github\.workspace\s*\}\}/gu, '.');
  const expressionPattern = /\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/u;
  const match = workspaceExpanded.match(expressionPattern);
  if (!match) return workspaceExpanded.includes('${{') ? [] : [workspaceExpanded];

  const values = matrixValues(jobLines, match[1]);
  return values.flatMap((entry) => expandWorkingDirectories(
    workspaceExpanded.replace(expressionPattern, entry),
    jobLines,
  ));
}

function repositoryPath(repositoryRoot, ...parts) {
  const absolute = resolve(repositoryRoot, ...parts);
  const insideRoot = relative(repositoryRoot, absolute);
  if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..') return null;
  return insideRoot || '.';
}

function shellLoopValues(run) {
  const commands = run.split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\s*\n\s*/gu, ' ');
  const values = new Map();
  const loopPattern = /(?:^|\n)\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]+);\s*do/gu;
  for (const match of commands.matchAll(loopPattern)) {
    const entries = match[2].trim().split(/\s+/u).map(unquote).filter(Boolean);
    if (entries.some((entry) => entry.includes('$'))) continue;
    values.set(match[1], entries);
  }
  return values;
}

function expandShellWorkingDirectories(value, loopValues) {
  const workspaceExpanded = value
    .replace(/^\$\{?GITHUB_WORKSPACE\}?$/u, '.')
    .replace(/^\$\{\{\s*github\.workspace\s*\}\}$/u, '.');
  const variablePattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/u;
  const match = workspaceExpanded.match(variablePattern);
  if (!match) return [workspaceExpanded];

  const values = loopValues.get(match[1] ?? match[2]) ?? [];
  return values.flatMap((entry) => expandShellWorkingDirectories(
    workspaceExpanded.replace(variablePattern, entry),
    loopValues,
  ));
}

function yarnInstallLockfiles(step, jobLines, inheritedWorkingDirectory, repositoryRoot) {
  const run = propertyValue(step, 'run');
  if (run === null) return { found: false, lockfiles: [], unresolved: false };

  const stepWorkingDirectory = propertyValue(step, 'working-directory');
  const workingDirectory = stepWorkingDirectory ?? inheritedWorkingDirectory ?? '.';
  const workingDirectories = expandWorkingDirectories(workingDirectory, jobLines);
  const lockfiles = [];
  let found = false;
  let unresolved = workingDirectories.length === 0;
  const loopValues = shellLoopValues(run);
  const yarnPattern = /(?:^|[;&|()\s])yarn(?:\s+--cwd(?:=|\s+)("[^"]+"|'[^']+'|[^\s;&|()]+))?\s+install(?:\s|$)/gu;
  const cdPattern = /(?:^\s*|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|()]+)\s*&&\s*$/u;

  for (const line of run.split('\n')) {
    if (line.trimStart().startsWith('#')) continue;
    for (const match of line.matchAll(yarnPattern)) {
      found = true;
      const beforeYarn = line.slice(0, match.index + match[0].indexOf('yarn'));
      const cd = beforeYarn.match(cdPattern);
      const commandWorkingDirectory = match[1] ? unquote(match[1]) : cd ? unquote(cd[1]) : null;
      const commandWorkingDirectories = commandWorkingDirectory === null
        ? ['.']
        : expandShellWorkingDirectories(commandWorkingDirectory, loopValues);
      if (commandWorkingDirectories.length === 0) {
        unresolved = true;
        continue;
      }
      for (const base of workingDirectories) {
        for (const commandDirectory of commandWorkingDirectories) {
          const project = repositoryPath(repositoryRoot, base, commandDirectory);
          if (project === null) {
            unresolved = true;
            continue;
          }
          lockfiles.push(project === '.' ? 'yarn.lock' : `${project}/yarn.lock`);
        }
      }
    }
  }

  return { found, lockfiles: [...new Set(lockfiles)], unresolved };
}

export function yarnCacheViolations(directory = workflowsDir, repositoryRoot = root) {
  const violations = [];
  const workflowNames = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  for (const workflowName of workflowNames) {
    const source = readFileSync(join(directory, workflowName), 'utf8');
    const sourceLines = source.split('\n');
    const jobsAt = sourceLines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
    const workflowWorkingDirectory = defaultsWorkingDirectory(sourceLines.slice(0, jobsAt), 0);
    for (const job of jobRanges(source)) {
      const steps = stepsForJob(job.lines);
      const jobWorkingDirectory = defaultsWorkingDirectory(job.lines, indentOf(job.lines[0]) + 2)
        ?? workflowWorkingDirectory;
      for (let index = 0; index < steps.length; index += 1) {
        if (!setupNodeAction(steps[index])) continue;
        const installs = steps.slice(index + 1)
          .map((step) => yarnInstallLockfiles(step, job.lines, jobWorkingDirectory, repositoryRoot))
          .filter((install) => install.found);
        if (installs.length === 0) continue;

        const location = `${workflowName} job ${job.name}`;
        const values = withValues(steps[index]);
        const remoteCheckoutLockfiles = steps.slice(0, index)
          .filter((step) => propertyValue(step, 'uses')?.startsWith('actions/checkout@'))
          .map((step) => withValues(step))
          .filter((checkout) => checkout.get('repository') && checkout.get('path'))
          .map((checkout) => relative(
            repositoryRoot,
            resolve(repositoryRoot, checkout.get('path'), 'yarn.lock'),
          ))
          .filter((dependencyPath) => !dependencyPath.startsWith(`..${sep}`) && dependencyPath !== '..');
        if (values.get('cache') !== 'yarn') {
          violations.push(`${location}: setup-node must declare cache: yarn`);
        }

        const paths = (values.get('cache-dependency-path') ?? '')
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (paths.length === 0) {
          violations.push(`${location}: setup-node must declare cache-dependency-path`);
          continue;
        }
        if (new Set(paths).size !== paths.length) {
          violations.push(`${location}: cache-dependency-path entries must be deduplicated`);
        }
        if (installs.some((install) => install.unresolved)) {
          violations.push(`${location}: could not derive every Yarn install project lockfile`);
        }
        const requiredPaths = [...new Set(installs.flatMap((install) => install.lockfiles))];
        for (const requiredPath of requiredPaths) {
          if (!paths.includes(requiredPath)) {
            violations.push(`${location}: setup-node must cache ${requiredPath}`);
          }
        }
        for (const dependencyPath of paths) {
          const absolute = resolve(repositoryRoot, dependencyPath);
          const insideRoot = relative(repositoryRoot, absolute);
          if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..' || dependencyPath.startsWith('/')) {
            violations.push(`${location}: cache dependency path must stay inside the repository: ${dependencyPath}`);
          } else if (basename(dependencyPath) !== 'yarn.lock') {
            violations.push(`${location}: cache dependency path is not an existing lockfile: ${dependencyPath}`);
          } else if ((!existsSync(absolute) || !statSync(absolute).isFile())
            && !remoteCheckoutLockfiles.includes(dependencyPath)) {
            violations.push(`${location}: cache dependency path is not an existing lockfile: ${dependencyPath}`);
          }
        }
      }
    }
  }
  return violations;
}

test('setup-node caches every later Yarn install with existing lockfiles', () => {
  assert.deepEqual(yarnCacheViolations(), []);
});

function fixtureWorkflow(setupWith) {
  return `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
${setupWith}
      - run: yarn install --immutable
        working-directory: app
`;
}

function withFixture(run) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-'));
  const fixtureWorkflows = join(fixtureRoot, '.github/workflows');
  mkdirSync(join(fixtureRoot, 'app'), { recursive: true });
  mkdirSync(fixtureWorkflows, { recursive: true });
  writeFileSync(join(fixtureRoot, 'app/yarn.lock'), 'fixture lockfile\n');
  try {
    run({ fixtureRoot, fixtureWorkflows });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function withWorkflowMutation(workflowName, mutate, run) {
  const fixtureWorkflows = mkdtempSync(join(tmpdir(), 'jinn-workflow-yarn-cache-mutation-'));
  const source = readFileSync(join(workflowsDir, workflowName), 'utf8');
  const mutant = mutate(source);
  assert.notEqual(mutant, source, `mutation did not change ${workflowName}`);
  writeFileSync(join(fixtureWorkflows, workflowName), mutant);
  try {
    run(fixtureWorkflows);
  } finally {
    rmSync(fixtureWorkflows, { recursive: true, force: true });
  }
}

test('guard rejects a setup-node step missing Yarn cache configuration', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache-dependency-path: app/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard rejects cache dependency paths that do not exist', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache: yarn\n          cache-dependency-path: missing/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard does not treat a nested checkout path as proof that a lockfile exists', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          path: dependency
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: dependency/yarn.lock
      - run: yarn install --immutable
`);
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard accepts a lockfile supplied by an external repository checkout', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          repository: Jinn-Network/autopilot
          path: .autopilot-pin
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: .autopilot-pin/yarn.lock
      - run: yarn install --immutable
        working-directory: .autopilot-pin
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

test('guard reads step properties at their YAML depth', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Set up Node
        env:
          uses: not-an-action
        uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: yarn install --immutable
        working-directory: app
`);
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard does not mistake nested step data or shell comments for executable workflow structure', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Document an action
        env:
          uses: actions/setup-node@v7
        run: |
          # yarn install --immutable
          echo no dependency installation
`);
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows, fixtureRoot), []);
  });
});

test('guard rejects a directory named like a lockfile', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    rmSync(join(fixtureRoot, 'app/yarn.lock'));
    mkdirSync(join(fixtureRoot, 'app/yarn.lock'));
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22\n          cache: yarn\n          cache-dependency-path: app/yarn.lock',
    ));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /not an existing lockfile/u);
  });
});

test('guard rejects a cache mapping missing one installed project lockfile', () => {
  withWorkflowMutation('ci.yml', (source) => source.replace(
    '            packages/lifecycle-notifications/yarn.lock\n',
    '',
  ), (fixtureWorkflows) => {
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows), [
      'ci.yml job dashboard-e2e: setup-node must cache packages/lifecycle-notifications/yarn.lock',
    ]);
  });
});

test('guard rejects an unrelated existing lockfile in place of the installed project', () => {
  withWorkflowMutation('ci.yml', (source) => source.replace(
    '            packages/lifecycle-notifications/yarn.lock\n',
    '            operator/yarn.lock\n',
  ), (fixtureWorkflows) => {
    assert.deepEqual(yarnCacheViolations(fixtureWorkflows), [
      'ci.yml job dashboard-e2e: setup-node must cache packages/lifecycle-notifications/yarn.lock',
    ]);
  });
});

test('guard derives installs from workflow defaults and yarn --cwd', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    mkdirSync(join(fixtureRoot, 'dependency'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'dependency/yarn.lock'), 'dependency lockfile\n');
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
defaults:
  run:
    working-directory: app
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: app/yarn.lock
      - run: yarn --cwd ../dependency install --immutable
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache dependency\/yarn\.lock/u,
    );
  });
});

test('guard expands matrix working directories', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    for (const directory of ['packages/one', 'packages/two']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
      writeFileSync(join(fixtureRoot, directory, 'yarn.lock'), `${directory} lockfile\n`);
    }
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        component: [one, two]
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: packages/one/yarn.lock
      - run: yarn install --immutable
        working-directory: packages/\${{ matrix.component }}
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache packages\/two\/yarn\.lock/u,
    );
  });
});

test('guard expands shell install loops', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    for (const directory of ['packages/one', 'packages/two']) {
      mkdirSync(join(fixtureRoot, directory), { recursive: true });
      writeFileSync(join(fixtureRoot, directory, 'yarn.lock'), `${directory} lockfile\n`);
    }
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), `name: cache fixture
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: yarn
          cache-dependency-path: packages/one/yarn.lock
      - run: |
          for component in one two; do
            (cd "packages/$component" && yarn install --immutable)
          done
`);
    assert.match(
      yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'),
      /must cache packages\/two\/yarn\.lock/u,
    );
  });
});

test('guard checks Yarn installs under double-quoted job IDs', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22',
    ).replace('  verify:', '  "verify":'));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});

test('guard checks Yarn installs under single-quoted job IDs with valid punctuation', () => {
  withFixture(({ fixtureRoot, fixtureWorkflows }) => {
    writeFileSync(join(fixtureWorkflows, 'fixture.yml'), fixtureWorkflow(
      '          node-version: 22',
    ).replace('  verify:', "  'verify-job_1':"));
    assert.match(yarnCacheViolations(fixtureWorkflows, fixtureRoot).join('\n'), /cache: yarn/u);
  });
});
