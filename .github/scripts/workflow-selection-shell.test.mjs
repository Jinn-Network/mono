// The operator-surface `changes` jobs, executed as shell rather than re-read as text.
//
// DR-2026-08-18-b D3/D6 moved four required contexts off workflow-level `paths:`
// filters and onto a per-workflow `changes` job that recomputes the same selection
// from the event's own diff. Three sibling tests
// (`layer-publish-workflow.test.mjs`, `operator/test/scripts/pack-workflows.test.ts`,
// `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py`) pin the
// pattern list by re-evaluating those strings in a JavaScript or Python regular
// expression engine. None of them runs the shell.
//
// That gap hid a live fail-open. The first cut matched with
// `printf '%s\n' "${changed}" | grep -qE -f ...`: `grep -q` exits on its first
// match, so on a diff whose list outruns the 64KiB pipe buffer the still-writing
// producer takes SIGPIPE, `set -o pipefail` makes the pipeline non-zero, the `if`
// takes the else branch, and a genuinely matching diff selects run=false. Every job
// in the lane then skips, the terminal gate sees the skips it expects for an
// unselected lane, and the required context reports green having run nothing.
//
// So this file runs the real thing: it lifts each `select` step's script out of the
// workflow, executes it under `bash` against a scratch repository, and asserts on
// the `run=` it writes to `GITHUB_OUTPUT`. Hermetic — `git init` in a temp dir, no
// network, no repository state read beyond the workflow sources themselves.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workflowsRoot = resolve(import.meta.dirname, '../workflows');

// One row per operator-surface member of the required set: the workflow, a path its
// lane must select on, and a control path it must not. `docs/operator/...` is the
// control on purpose — it contains a selected directory name, so an unanchored
// pattern would match it.
const LANES = [
  {
    workflow: 'ci.yml',
    selects: 'operator/src/daemon/daemon.ts',
    ignores: 'docs/operator/rotating-harness-keys.md',
  },
  {
    workflow: 'operator-console-ci.yml',
    selects: 'apps/operator-console/app/page.tsx',
    ignores: 'docs/operator/rotating-harness-keys.md',
  },
  {
    workflow: 'layer-ci.yml',
    selects: 'packages/layer/src/index.ts',
    ignores: 'docs/press/2026-08-18-note.md',
  },
  {
    workflow: 'jinn-agent-ci.yml',
    selects: 'apps/jinn-agent/scripts/cold-stock-e2e.sh',
    ignores: 'docs/operator/rotating-harness-keys.md',
  },
];

// Comfortably past a Linux pipe's 64KiB capacity: 4000 paths of 34 bytes plus a
// newline is ~137KiB. `zz-` keeps the noise sorted after every real prefix, so a
// selected path lands at the head of `git diff --name-only` output — the position
// that makes `grep -q` exit while the producer is still writing.
const NOISE_PATHS = Object.freeze(
  Array.from({ length: 4000 }, (_, index) => `zz-selection-noise/file-${String(index).padStart(6, '0')}.txt`),
);

const PIPE_CAPACITY_BYTES = 65_536;

function source(workflow) {
  return readFileSync(join(workflowsRoot, workflow), 'utf8');
}

// The `run:` script of the `changes` job's `select` step, dedented to column zero.
// Raw-source slicing rather than a YAML parser: `.github/scripts/` has no dependency
// manifest, which is why every test in this directory reads workflows the same way.
function selectScript(workflow) {
  const text = source(workflow);
  const stepAt = text.indexOf('\n        id: select\n');
  assert.notEqual(stepAt, -1, `${workflow}: the changes job has no step with id: select`);
  const marker = '\n        run: |\n';
  const runAt = text.indexOf(marker, stepAt);
  assert.notEqual(runAt, -1, `${workflow}: the select step declares no literal run: block`);

  const lines = [];
  for (const line of text.slice(runAt + marker.length).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  assert.notEqual(lines.length, 0, `${workflow}: the select step's run: block is empty`);
  return `${lines.join('\n')}\n`;
}

function git(cwd, args, input = undefined) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      // No user or system git config may reach the scratch repository: a
      // `diff.renames` or `core.quotePath` set in the environment would make the
      // selection under test depend on whose machine ran it.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'selection test',
      GIT_AUTHOR_EMAIL: 'selection@example.invalid',
      GIT_COMMITTER_NAME: 'selection test',
      GIT_COMMITTER_EMAIL: 'selection@example.invalid',
    },
  }).trim();
}

const repositories = new Map();

// A two-commit repository whose second commit adds exactly `paths`. Built through
// the index rather than the working tree so a 4000-path commit costs one
// `update-index` call instead of 4000 file writes.
function scratchRepository(paths) {
  const key = paths.join('\n');
  const cached = repositories.get(key);
  if (cached !== undefined) return cached;

  const dir = mkdtempSync(join(tmpdir(), 'selection-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const base = git(dir, ['commit-tree', git(dir, ['write-tree']), '-m', 'base']);
  const blob = git(dir, ['hash-object', '-w', '-t', 'blob', '--stdin'], '');
  git(dir, ['update-index', '--index-info'], `${paths.map((path) => `100644 ${blob}\t${path}`).join('\n')}\n`);
  const head = git(dir, ['commit-tree', git(dir, ['write-tree']), '-p', base, '-m', 'head']);

  const repository = { dir, base, head };
  repositories.set(key, repository);
  return repository;
}

// Execute one workflow's selection script over a synthetic changed list and return
// what it wrote to GITHUB_OUTPUT, plus the byte size of the list it saw.
function select(workflow, paths) {
  const repository = scratchRepository(paths);
  const runnerTemp = mkdtempSync(join(tmpdir(), 'selection-temp-'));
  const outputPath = join(runnerTemp, 'github-output');
  const scriptPath = join(runnerTemp, 'select.sh');
  writeFileSync(outputPath, '');
  writeFileSync(scriptPath, selectScript(workflow));

  execFileSync('bash', [scriptPath], {
    cwd: repository.dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputPath,
      // The script reads all six under `set -u`, so every one must be defined even
      // where the event does not populate it.
      EVENT_NAME: 'push',
      PR_BASE_SHA: '',
      PR_HEAD_SHA: '',
      MG_BASE_SHA: '',
      MG_HEAD_SHA: '',
      PUSH_BEFORE_SHA: repository.base,
      PUSH_HEAD_SHA: repository.head,
    },
  });

  const written = readFileSync(outputPath, 'utf8');
  const match = written.match(/^run=(?<value>.*)$/mu);
  assert.notEqual(match, null, `${workflow}: wrote no run= output (got ${JSON.stringify(written)})`);
  return {
    run: match.groups.value,
    listBytes: paths.reduce((total, path) => total + Buffer.byteLength(path) + 1, 0),
  };
}

test('a selected path is found however long the changed list is', () => {
  for (const lane of LANES) {
    const small = select(lane.workflow, [lane.selects]);
    assert.equal(small.run, 'true', `${lane.workflow}: ${lane.selects} must select the lane`);

    // The regression case. The selected path sorts first, so `grep -q` reaches its
    // match with most of the list still unread; the previous pipeline form left the
    // producer writing into a closed pipe and reported run=false on a diff that
    // plainly touches the lane.
    const large = select(lane.workflow, [lane.selects, ...NOISE_PATHS]);
    assert.ok(
      large.listBytes > PIPE_CAPACITY_BYTES,
      `${lane.workflow}: the synthetic list is ${large.listBytes} bytes and does not exceed a pipe's capacity`,
    );
    assert.equal(
      large.run,
      'true',
      `${lane.workflow}: ${lane.selects} must still select the lane inside a ${large.listBytes}-byte changed list`,
    );

    // The same list with the match at the far end, which the pipeline form happened
    // to survive. Both ends are pinned so neither ordering can regress alone.
    const trailing = select(lane.workflow, [...NOISE_PATHS, lane.selects]);
    assert.equal(
      trailing.run,
      'true',
      `${lane.workflow}: ${lane.selects} must select the lane from the tail of a long changed list`,
    );
  }
});

test('an unselected changed list leaves the lane unselected', () => {
  for (const lane of LANES) {
    assert.equal(
      select(lane.workflow, [lane.ignores]).run,
      'false',
      `${lane.workflow}: ${lane.ignores} must not select the lane`,
    );
    const large = select(lane.workflow, [lane.ignores, ...NOISE_PATHS]);
    assert.ok(large.listBytes > PIPE_CAPACITY_BYTES, `${lane.workflow}: the synthetic list is too small`);
    assert.equal(
      large.run,
      'false',
      `${lane.workflow}: a long changed list touching nothing in the lane must not select it`,
    );
  }
});

test('the selection scripts read the changed list from a file, not a pipe', () => {
  for (const lane of LANES) {
    const script = selectScript(lane.workflow);
    assert.doesNotMatch(
      script,
      /\|[ \t]*grep\b/u,
      `${lane.workflow}: the changed list must not be piped into grep; grep -q exits on its first match and SIGPIPEs the producer, which pipefail turns into run=false on a matching diff`,
    );
    assert.match(
      script,
      /git -c core\.quotePath=false diff --no-renames --name-only/u,
      `${lane.workflow}: the diff must run with core.quotePath=false (git otherwise quotes non-ASCII paths and the ^-anchored patterns stop matching) and --no-renames (a rename otherwise prints only its new path, so a file renamed out of a selected tree stops selecting the lane, and rename scoring faults blobs back in under blob:none)`,
    );
  }
});

test('every terminal gate rejects a selection output it cannot parse', () => {
  for (const lane of LANES) {
    assert.match(
      source(lane.workflow),
      /case "\$\{SELECTED\}" in\n\s+true\|false\) ;;\n/u,
      `${lane.workflow}: the gate must validate SELECTED against true|false; an empty output must never be read as an unselected lane`,
    );
  }
});
