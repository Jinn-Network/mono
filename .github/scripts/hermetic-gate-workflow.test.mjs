import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Pins the run-value guard in hermetic-gate's selection step (#4164). It is the
// prior art the #4060 guard in `platform-architecture-control.yml` was modeled on,
// and `architecture-control-workflow.test.mjs` is the template for this file. The
// harness is reimplemented rather than shared: the two scripts differ in job
// markers, `set` line, required env, and stub set, and parameterizing all of that
// for two callers would cost more than the two copies do.

const workflowRoot = resolve(import.meta.dirname, '../workflows');

function readHermeticGateWorkflow() {
  return readFileSync(resolve(workflowRoot, 'hermetic-gate.yml'), 'utf8');
}

function readArchitectureControlWorkflow() {
  return readFileSync(resolve(workflowRoot, 'platform-architecture-control.yml'), 'utf8');
}

/**
 * Slice one job out of the workflow source. Both markers are asserted, and the end
 * marker is asserted to *follow* the start: a renamed end marker otherwise yields
 * `indexOf` -1, and the slice silently widens to the whole file, which would make
 * every scoped assertion below pass for the wrong reason.
 */
function sliceJob(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `workflow is missing the job marker '${startMarker.trim()}'`);
  const end = source.indexOf(endMarker);
  assert.ok(
    end > start,
    `job marker '${endMarker.trim()}' must exist and follow '${startMarker.trim()}'`,
  );
  return source.slice(start, end);
}

function sliceChangesJob(source) {
  return sliceJob(source, '  changes:', '  cache-warm:');
}

/**
 * Lift the `run:` script out of the selection step so it can be executed rather than
 * only pattern-matched. A regex over YAML cannot observe whether the guard actually
 * reds the step or merely prints; the executable cases below can.
 */
function extractSelectionScript(source) {
  const changesJob = sliceChangesJob(source);
  const marker = '\n        run: |\n';
  const start = changesJob.indexOf(marker);
  assert.ok(start >= 0, 'changes must carry a literal-block run: script');
  const indent = '          ';
  const lines = [];
  for (const line of changesJob.slice(start + marker.length).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith(indent)) break;
    lines.push(line.slice(indent.length));
  }
  const script = `${lines.join('\n')}\n`;
  assert.match(script, /^set -euo pipefail$/mu);
  return script;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Stands in for `hermetic-selection.mjs`: the surrounding shell only needs a JSON
// object on stdout. Stdin is drained so the `<` redirection never blocks.
const SELECTOR_STUB = ['#!/bin/bash', 'cat > /dev/null', 'echo \'{ "run": true }\'', ''].join('\n');
const FALSE_SELECTOR_STUB = ['#!/bin/bash', 'cat > /dev/null', 'echo \'{ "run": false }\'', ''].join('\n');

// One path on stdout serves both `git cat-file -e` (exit 0, output discarded) and
// the name-only `git diff` that writes the changed list.
const GIT_STUB = ['#!/bin/bash', 'echo operator/src/index.ts', ''].join('\n');

const JQ_STUB = [
  '#!/bin/bash',
  'input="$(cat)"',
  'case "$input" in',
  '  *\'"run": true\'*) echo true ;;',
  '  *\'"run": false\'*) echo false ;;',
  '  *) echo null ;;',
  'esac',
  '',
].join('\n');

/**
 * Run the workflow's own selection script under `bash -e` — the shell GitHub Actions
 * uses for a `run:` step — against stubs for `git`, `node`, and `jq`. Hermetic: a
 * scratch directory, a synthetic PATH, no network, no repository history. Only the
 * `merge_group` arm is driven; the `pull_request` and `push` arms are not under test.
 */
function runSelectionScript({ script, jqStub = JQ_STUB, selectorStub = SELECTOR_STUB }) {
  const dir = mkdtempSync(join(tmpdir(), 'hg-selection-'));
  try {
    const bin = join(dir, 'bin');
    const runnerTemp = join(dir, 'tmp');
    mkdirSync(bin);
    mkdirSync(runnerTemp);
    const githubOutput = join(dir, 'github-output');
    writeFileSync(githubOutput, '');

    writeExecutable(join(bin, 'git'), GIT_STUB);
    writeExecutable(join(bin, 'node'), selectorStub);
    writeExecutable(join(bin, 'jq'), jqStub);

    const scriptPath = join(dir, 'selection.sh');
    writeFileSync(scriptPath, script);
    const run = spawnSync('bash', ['-e', scriptPath], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_OUTPUT: githubOutput,
        RUNNER_TEMP: runnerTemp,
        EVENT_NAME: 'merge_group',
        MG_BASE_SHA: 'base',
        MG_HEAD_SHA: 'head',
      },
    });

    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      output: readFileSync(githubOutput, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The guard's exact text, with assignment→guard adjacency: the jq hop feeds `case`
// directly, and `run=` is published only inside the boolean arm. Widening the arm
// to admit `null`, dropping `exit 1`, or folding the value back into the echo each
// breaks this pin.
test('hermetic-gate selection validates the run value before publishing it', () => {
  const slice = sliceChangesJob(readHermeticGateWorkflow());
  assert.match(
    slice,
    new RegExp(
      [
        String.raw`run="\$\(jq -r '\.run' <<<"\$\{selection\}"\)"`,
        String.raw`case "\$\{run\}" in`,
        String.raw`true\|false\)`,
        String.raw`echo "run=\$\{run\}" >> "\$\{GITHUB_OUTPUT\}"`,
        String.raw`;;`,
        String.raw`\*\)`,
        String.raw`echo "::error::unparseable selection output: '\$\{run\}'"`,
        String.raw`exit 1`,
        String.raw`;;`,
        String.raw`esac`,
      ].join(String.raw`\s+`),
      'u',
    ),
  );
  assert.doesNotMatch(slice, /echo "run=\$\(/u, 'the jq value must not be published unvalidated');
  assert.match(slice, /outputs:\n\s+run: \$\{\{ steps\.select\.outputs\.run \}\}/u);
});

// A jq that succeeds with a non-boolean is the #2456 hole (#4060 on the sibling
// workflow). `set -e` cannot see these: both exit 0. An empty `selection` makes
// real jq print nothing, and a `.run`-less object makes it print `null` -- and
// `run=` / `run=null` each fail the gate's `== 'true'` check and unselect the
// hermetic suite at exit 0.
const EMPTY_OUTPUT_JQ_STUB = ['#!/bin/bash', 'cat > /dev/null', ''].join('\n');
const NULL_JQ_STUB = ['#!/bin/bash', 'cat > /dev/null', 'echo null', ''].join('\n');

/**
 * Strip the guard the way a regression would. The publication lives inside the
 * boolean arm here, so the whole `case … esac` becomes the bare echo: the value
 * still publishes, only the validation goes.
 */
function stripRunValueGuard(script) {
  const stripped = script.replace(
    /^case "\$\{run\}" in\n(?:.*\n)*?esac\n/mu,
    'echo "run=${run}" >> "${GITHUB_OUTPUT}"\n',
  );
  assert.notEqual(stripped, script, 'the selection step must validate run before publishing it');
  return stripped;
}

for (const { label, jqStub, laundered } of [
  { label: 'an empty selection', jqStub: EMPTY_OUTPUT_JQ_STUB, laundered: /^run=$/mu },
  { label: 'a selection with no .run key', jqStub: NULL_JQ_STUB, laundered: /^run=null$/mu },
]) {
  test(`${label} reds hermetic-gate selection instead of publishing a non-boolean run`, () => {
    const script = extractSelectionScript(readHermeticGateWorkflow());

    const guarded = runSelectionScript({ script, jqStub });
    assert.notEqual(guarded.status, 0, 'a non-boolean run value must red the job');
    assert.doesNotMatch(guarded.output, /run=/u, 'no run= verdict may be published');
    assert.match(guarded.stdout + guarded.stderr, /::error::unparseable selection output/u);

    // Kill-check: without the guard the same script exits 0 and publishes the value,
    // which is what makes the assertions above load-bearing rather than incidental.
    const unguarded = runSelectionScript({ script: stripRunValueGuard(script), jqStub });
    assert.equal(unguarded.status, 0, 'unguarded, the non-boolean value is masked');
    assert.match(unguarded.output, laundered);
  });
}

test('a boolean run value still publishes through the hermetic-gate guard', () => {
  const script = extractSelectionScript(readHermeticGateWorkflow());
  for (const [selectorStub, expected] of [
    [SELECTOR_STUB, 'run=true'],
    [FALSE_SELECTOR_STUB, 'run=false'],
  ]) {
    const passed = runSelectionScript({ script, selectorStub });
    assert.equal(passed.status, 0, `${expected} must pass the guard`);
    assert.match(passed.output, new RegExp(`^${expected}$`, 'mu'));
  }
});

// Wiring pin: this file only guards anything while a required job runs it. The
// control job is the owner (`platform-architecture-control` is in the required
// check set); `workflow-script-tests.test.mjs` is the orphan-guard second net.
test('the platform-architecture-control job runs the hermetic-gate workflow test', () => {
  const controlJob = sliceJob(
    readArchitectureControlWorkflow(),
    '  platform-architecture-control:',
    '  verification-selection:',
  );
  assert.match(controlJob, /\.github\/scripts\/hermetic-gate-workflow\.test\.mjs/u);
});
