import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowsDir = resolve(root, '.github/workflows');

const indentOf = (line) => line.match(/^\s*/u)[0].length;
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
const scalar = (value) => unquote(value.replace(/\s+#.*$/u, ''));

function jobRanges(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/u.test(line));
  if (jobsAt === -1) return [];

  const jobsIndent = indentOf(lines[jobsAt]);
  const starts = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentOf(line) <= jobsIndent) break;
    const match = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(?:#.*)?$/u);
    if (match && match[1].length === jobsIndent + 2) starts.push({ index, name: match[2] });
  }

  return starts.map((start, position) => ({
    name: start.name,
    lines: lines.slice(start.index, starts[position + 1]?.index ?? lines.length),
  }));
}

function stepsForJob(lines) {
  const stepsAt = lines.findIndex((line) => /^\s+steps:\s*(?:#.*)?$/u.test(line));
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
  const pattern = new RegExp(`^\\s*(?:-\\s*)?${property}:\\s*(.*)$`, 'u');
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
  const withAt = lines.findIndex((line) => /^\s*(?:-\s*)?with:\s*(?:#.*)?$/u.test(line));
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

function runsYarnInstall(lines) {
  const run = propertyValue(lines, 'run');
  return run !== null && /(?:^|[;&|()\s])yarn(?:\s+--cwd(?:=|\s+)\S+)?\s+install(?:\s|$)/u.test(run);
}

export function yarnCacheViolations(directory = workflowsDir, repositoryRoot = root) {
  const violations = [];
  const workflowNames = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();

  for (const workflowName of workflowNames) {
    const source = readFileSync(join(directory, workflowName), 'utf8');
    for (const job of jobRanges(source)) {
      const steps = stepsForJob(job.lines);
      for (let index = 0; index < steps.length; index += 1) {
        if (!setupNodeAction(steps[index])) continue;
        if (!steps.slice(index + 1).some(runsYarnInstall)) continue;

        const location = `${workflowName} job ${job.name}`;
        const values = withValues(steps[index]);
        const checkoutRoots = steps.slice(0, index)
          .filter((step) => propertyValue(step, 'uses')?.startsWith('actions/checkout@'))
          .map((step) => withValues(step).get('path'))
          .filter(Boolean);
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
        for (const dependencyPath of paths) {
          const absolute = resolve(repositoryRoot, dependencyPath);
          const insideRoot = relative(repositoryRoot, absolute);
          if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..' || dependencyPath.startsWith('/')) {
            violations.push(`${location}: cache dependency path must stay inside the repository: ${dependencyPath}`);
          } else if (!dependencyPath.endsWith('yarn.lock')) {
            violations.push(`${location}: cache dependency path is not an existing lockfile: ${dependencyPath}`);
          } else if (!existsSync(absolute)
            && !checkoutRoots.some((checkoutRoot) => dependencyPath === `${checkoutRoot}/yarn.lock`)) {
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
