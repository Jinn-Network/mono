import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workflowRoot = resolve(import.meta.dirname, '../workflows');

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
  if (endMarker === undefined) return source.slice(start);
  const end = source.indexOf(endMarker);
  assert.ok(
    end > start,
    `job marker '${endMarker.trim()}' must exist and follow '${startMarker.trim()}'`,
  );
  return source.slice(start, end);
}

/**
 * Lift the `run:` script out of the selection step so it can be executed rather than
 * only pattern-matched. Regexes over YAML cannot observe shell semantics — whether a
 * dead `git diff` propagates, whether an empty endpoint is caught — and those are
 * exactly the properties that decide whether this lane verifies anything at all.
 */
function extractSelectionScript(source) {
  const selectionJob = sliceJob(source, '  verification-selection:', '  platform-release-surface:');
  const marker = '\n        run: |\n';
  const start = selectionJob.indexOf(marker);
  assert.ok(start >= 0, 'verification-selection must carry a literal-block run: script');
  const indent = '          ';
  const lines = [];
  for (const line of selectionJob.slice(start + marker.length).split('\n')) {
    if (line.trim() === '') {
      lines.push('');
      continue;
    }
    if (!line.startsWith(indent)) break;
    lines.push(line.slice(indent.length));
  }
  const script = `${lines.join('\n')}\n`;
  assert.match(script, /^set -o pipefail$/mu);
  return script;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// Stands in for `platform-verification-selection.mjs` as a selector that fails open:
// empty stdin yields `run: false`. The real CLI no longer does that — since #2830 it
// answers `run: true` (reason `no changed files reported`) for empty or blank stdin.
// The stub keeps the fail-open answer on purpose: it is the adversary the pipefail
// guard has to survive, and the guard must not depend on what the selector answers today.
const SELECTOR_STUB = [
  '#!/bin/bash',
  'input="$(cat)"',
  'echo "$input" > "$SELECTOR_STDIN_LOG"',
  "if [ -z \"$(echo \"$input\" | tr -d '[:space:]')\" ]; then",
  '  echo \'{ "run": false }\'',
  'else',
  '  echo \'{ "run": true }\'',
  'fi',
  '',
].join('\n');

const GIT_STUB = [
  '#!/bin/bash',
  'for arg in "$@"; do echo "$arg" >> "$GIT_ARGS_LOG"; done',
  'echo operator/src/index.ts',
  '',
].join('\n');

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
 * uses for a `run:` step — against recording stubs for `git`, `node`, and `jq`.
 * Hermetic: a scratch directory, a synthetic PATH, no network, no repository history.
 *
 * `gitMode: 'real'` keeps the real git on PATH inside a throwaway repository so a
 * genuinely failing `git diff` (bad object) can be observed rather than simulated.
 */
function runSelectionScript({ script, env, gitMode = 'stub', jqStub = JQ_STUB, selectorStub = SELECTOR_STUB }) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-selection-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const gitArgsLog = join(dir, 'git-args.log');
    const selectorStdinLog = join(dir, 'selector-stdin.log');
    const githubOutput = join(dir, 'github-output');
    for (const path of [gitArgsLog, selectorStdinLog, githubOutput]) writeFileSync(path, '');

    if (gitMode === 'stub') writeExecutable(join(bin, 'git'), GIT_STUB);
    writeExecutable(join(bin, 'node'), selectorStub);
    writeExecutable(join(bin, 'jq'), jqStub);

    if (gitMode === 'real') {
      execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
      writeFileSync(join(dir, 'seed.txt'), 'seed\n');
      execFileSync('git', ['-C', dir, 'add', 'seed.txt'], { stdio: 'ignore' });
      execFileSync(
        'git',
        ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'],
        { stdio: 'ignore' },
      );
    }

    const scriptPath = join(dir, 'selection.sh');
    writeFileSync(scriptPath, script);
    const run = spawnSync('bash', ['-e', scriptPath], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GIT_ARGS_LOG: gitArgsLog,
        SELECTOR_STDIN_LOG: selectorStdinLog,
        GITHUB_OUTPUT: githubOutput,
        ...env,
      },
    });

    return {
      status: run.status,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      gitArgs: readFileSync(gitArgsLog, 'utf8'),
      output: readFileSync(githubOutput, 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('PR architecture workflow exposes exact required job checks and gates reusable verification', () => {
  const source = readArchitectureControlWorkflow();
  assert.match(source, /pull_request:/u);
  assert.doesNotMatch(source, /pull_request_target:/u);
  // Both required contexts this workflow reports (`platform-architecture-control` and
  // `platform-verification`) have to report on merge groups too, or a queue entry sits
  // on unreported checks until the check-response timeout ejects it (DR-2026-08-18-b D3).
  // The trigger set is pinned exactly so neither the merge-group lane nor the absence of
  // `pull_request_target` can drift back out.
  const triggers = source.match(/^on:\n(?<body>[\s\S]*?)\n\n/mu)?.groups?.body;
  assert.equal(triggers, '  pull_request:\n  merge_group:\n  workflow_dispatch:');
  assert.match(source, /platform-architecture-control:\n\s+name: platform-architecture-control/u);
  assert.match(source, /platform-verification:\n\s+name: platform-verification\n\s+needs:\n\s+- verification-selection\n\s+- platform-verification-reusable/u);
  assert.match(source, /uses: \.\/\.github\/workflows\/platform-verification\.yml/u);
  assert.match(source, /github\.event\.pull_request\.head\.sha/u);
  assert.match(source, /lane: canary/u);
  assert.match(source, /VERIFICATION_RESULT: \$\{\{ needs\.platform-verification-reusable\.result \}\}/u);
  assert.match(source, /test "\$\{VERIFICATION_RESULT\}" = success/u);
  // The reusable call is gated on the changed-package closure. The final gate still
  // demands exact success when verification is selected, and exact `skipped` when it
  // is not — so unselection can never launder a failed or cancelled run.
  assert.match(source, /node \.github\/scripts\/platform-verification-selection\.mjs/u);
  assert.match(source, /needs: verification-selection\n\s+if: needs\.verification-selection\.outputs\.run == 'true'/u);
  assert.match(source, /test "\$\{SELECTION_RESULT\}" = success/u);
  assert.match(source, /test "\$\{VERIFICATION_RESULT\}" = skipped/u);
  // Tiered lanes (DR-2026-08-18-b D3). Fast mode is scoped to the lane the merge queue
  // backstops: a pull request that does not target `main` unselects verification outright
  // rather than diffing, because the merge group carries the full battery and the queue is
  // the only path onto `next`. A pull request that DOES target `main` is the hotfix lane —
  // D2 puts no queue there, so fast mode would delete the verification rather than move it,
  // and those PRs verify in full. The merge_group lane reads its base off the merge-group
  // payload and its head as GITHUB_SHA (the commit checkout resolved). Any other event still
  // verifies in full; the three-dot diff needs unshallow history.
  const selectionJob = sliceJob(source, '  verification-selection:', '  platform-release-surface:');
  assert.match(selectionJob, /fetch-depth: 0/u);
  assert.match(selectionJob, /timeout-minutes: 5/u);
  assert.match(selectionJob, /PR_BASE_REF: \$\{\{ github\.base_ref \}\}/u);
  assert.match(selectionJob, /PR_HEAD_REF: \$\{\{ github\.head_ref \}\}/u);
  assert.match(selectionJob, /MG_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
  // The base-ref carve-out is asserted as one contiguous block, before the fast-lane
  // unselect, so a future edit cannot reorder them and silently thin the hotfix lane.
  // The head-ref clause is part of that same contiguous block: the standing
  // release-review PR (`base:main head:next`, issue #2831) mirrors merge-group runs
  // that already verified every commit it carries, so it takes the fast lane while
  // every other `main`-targeting head — the real hotfixes — still verifies in full.
  assert.match(
    selectionJob,
    /^\s+pull_request\)\n\s+if \[ "\$\{PR_BASE_REF\}" = main \] && \[ "\$\{PR_HEAD_REF\}" != next \]; then\n\s+echo '[^']*'\n\s+echo 'run=true' >> "\$\{GITHUB_OUTPUT\}"\n\s+exit 0\n\s+fi\n\s+echo 'pr-fast-lane: full verification runs on the merge group'\n\s+echo 'run=false' >> "\$\{GITHUB_OUTPUT\}"\n\s+exit 0/mu,
  );
  // The PR lane must not diff at all — a surviving pull_request base/head pair would mean
  // fast mode was only half-applied and the PR lane still paid for selection.
  assert.doesNotMatch(selectionJob, /github\.event\.pull_request\.base\.sha/u);
  assert.match(selectionJob, /^\s+merge_group\)\n\s+diff_base="\$\{MG_BASE_SHA\}"\n\s+diff_head="\$\{GITHUB_SHA\}"/mu);
  // One source of truth for the merge-group head. `github.sha` is what the checkout
  // resolved; `merge_group.head_sha` as a second spelling is pinned out of directives.
  const selectionDirectives = selectionJob
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(selectionDirectives, /MG_HEAD_SHA|merge_group\.head_sha/u);
  assert.match(selectionJob, /git diff --name-only "\$\{diff_base\}\.\.\.\$\{diff_head\}"/u);
  assert.match(selectionJob, /non-PR, non-merge-group event verifies in full/u);
  // Fail-loud selection. Without `pipefail` the pipeline reports the selector's status,
  // so a dead `git diff` unselects the whole battery at exit 0; without the emptiness
  // guard an unresolved base makes git read `"...${diff_head}"` as `HEAD...${diff_head}`
  // and report an honestly empty diff. Executable coverage for both is below.
  assert.match(selectionJob, /run: \|\n\s+set -o pipefail\n/u);
  assert.match(selectionJob, /if \[ -z "\$\{diff_base\}" \] \|\| \[ -z "\$\{diff_head\}" \]; then/u);
  assert.match(selectionJob, /::error::selection endpoints unresolved on \$\{EVENT_NAME\}/u);
  // The jq hop is assigned before it is echoed. Folded into the `echo` argument the
  // substitution is invisible to `set -e`, and a dead jq publishes an empty `run=` that
  // unselects the whole battery at exit 0 (#2456). Executable coverage is below.
  assert.match(
    selectionJob,
    /\n\s+run_value="\$\(jq -r '\.run' <<<"\$\{selection\}"\)"\n(?:\s*#[^\n]*\n)*\s*case "\$\{run_value\}" in/u,
  );
  assert.doesNotMatch(selectionJob, /echo "run=\$\(/u);
  // ...and validated before it is published. A jq that succeeds with a non-boolean --
  // no output on an empty `selection`, `null` on a `.run`-less one -- exits 0, so only
  // an explicit check keeps `run=` / `run=null` from unselecting the battery (#4060).
  assert.match(
    selectionJob,
    /\n\s+case "\$\{run_value\}" in\n\s+true\|false\) ;;\n\s+\*\) echo "::error::selection produced a non-boolean run value: '\$\{run_value\}'"; exit 1 ;;\n\s+esac\n\s+echo "run=\$\{run_value\}" >> "\$\{GITHUB_OUTPUT\}"/u,
  );
  assert.doesNotMatch(source, /npm (?:publish|install)|yarn npm publish/u);
  // Ban publish-verified-platform script invocations; wiring its test file is allowed.
  assert.doesNotMatch(source, /publish-verified-platform(?!\.test\.mjs)/u);
  const topPermissions = source.match(/^permissions:\n(?<body>[\s\S]*?)\njobs:/mu)?.groups?.body;
  assert.equal(topPermissions?.trimEnd(), '  contents: read');
  const controlJob = sliceJob(source, '  platform-architecture-control:', '  platform-verification-reusable:');
  const reusableJob = sliceJob(source, '  platform-verification-reusable:', '  platform-verification:');
  const finalJob = sliceJob(source, '  platform-verification:');
  assert.doesNotMatch(controlJob, /(?:id-token|attestations|artifact-metadata): write/u);
  assert.match(controlJob, /node \.github\/scripts\/generate-architecture\.mjs --check/u);
  assert.match(controlJob, /\.github\/scripts\/benchmark-product-source-boundaries\.test\.mjs/u);
  assert.match(controlJob, /\.github\/scripts\/colophon-publish-manifest\.test\.mjs/u);
  assert.match(reusableJob, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/u);
  assert.doesNotMatch(finalJob, /(?:id-token|attestations|artifact-metadata): write/u);
});

test('the selection script resolves its diff endpoints from the event it is given', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());

  // Fast lane: a pull request that does not target `main` unselects without diffing.
  const pullRequest = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'pull_request',
      PR_BASE_REF: 'next',
      PR_HEAD_REF: 'autopilot/1',
      MG_BASE_SHA: '',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.equal(pullRequest.status, 0, pullRequest.stderr);
  assert.equal(pullRequest.gitArgs, '');
  assert.match(pullRequest.output, /^run=false$/mu);

  // Hotfix lane: a pull request targeting `main` verifies in full, still without diffing.
  const hotfix = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'pull_request',
      PR_BASE_REF: 'main',
      PR_HEAD_REF: 'fix/hotfix-branch',
      MG_BASE_SHA: '',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.equal(hotfix.status, 0, hotfix.stderr);
  assert.equal(hotfix.gitArgs, '');
  assert.match(hotfix.output, /^run=true$/mu);

  // Release-review lane: the standing `base:main head:next` PR resynchronizes on every
  // push to `next` and mirrors merge groups that already verified the same commits, so
  // it unselects like the fast lane rather than paying the full battery again (#2831).
  const releaseReview = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'pull_request',
      PR_BASE_REF: 'main',
      PR_HEAD_REF: 'next',
      MG_BASE_SHA: '',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.equal(releaseReview.status, 0, releaseReview.stderr);
  assert.equal(releaseReview.gitArgs, '');
  assert.match(releaseReview.output, /^run=false$/mu);

  // The merge-group head is `GITHUB_SHA`, not a second payload field.
  const mergeGroup = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'merge_group',
      PR_BASE_REF: '',
      PR_HEAD_REF: '',
      MG_BASE_SHA: 'base-from-merge-group',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.equal(mergeGroup.status, 0, mergeGroup.stderr);
  assert.match(mergeGroup.gitArgs, /^base-from-merge-group\.\.\.checked-out-sha$/mu);
  assert.match(mergeGroup.output, /^run=true$/mu);

  // Any other event verifies in full without consulting a diff at all.
  const dispatch = runSelectionScript({
    script,
    env: { EVENT_NAME: 'workflow_dispatch', PR_BASE_REF: '', PR_HEAD_REF: '', MG_BASE_SHA: '', GITHUB_SHA: 'checked-out-sha' },
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.match(dispatch.output, /^run=true$/mu);
  assert.equal(dispatch.gitArgs, '');
});

test('the selection script refuses to unselect when a diff endpoint is unresolved', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());

  // Only the merge-group arm reaches the emptiness guard. The PR fast-lane exits
  // before it, so an empty SHA on pull_request must not be the thing that reds.
  const unresolved = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'merge_group',
      PR_BASE_REF: '',
      PR_HEAD_REF: '',
      MG_BASE_SHA: '',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.notEqual(unresolved.status, 0, 'merge_group: an unresolved endpoint must red the job');
  assert.match(unresolved.stdout, /::error::selection endpoints unresolved on merge_group/u);
  assert.equal(unresolved.gitArgs, '', 'merge_group: no diff should be attempted');
  assert.equal(unresolved.output, '', 'merge_group: no run= verdict should be published');
});

test('a failing git diff reds selection instead of silently unselecting verification', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());
  const env = {
    EVENT_NAME: 'merge_group',
    BASE_SHA: '',
    HEAD_SHA: '',
    MG_BASE_SHA: '0'.repeat(40),
    GITHUB_SHA: '1'.repeat(40),
  };

  const guarded = runSelectionScript({ script, gitMode: 'real', env });
  assert.notEqual(guarded.status, 0, 'a broken diff must red the job');
  assert.doesNotMatch(guarded.output, /run=/u);

  // The same script with `set -o pipefail` stripped is the defect being guarded, and
  // running it proves the assertion above is load-bearing rather than incidental: git
  // dies on the bad objects, the selector reads empty stdin, and the pipeline inherits
  // the selector's exit 0. The real selector would answer `run: true` today and quietly
  // run the full battery against a diff that never happened; the stub's `run: false`
  // shows the worse outcome — `platform-verification` green, having verified nothing.
  // Either way pipefail is required: a broken `git diff` must red the job.
  const unguarded = runSelectionScript({
    script: script.replace('set -o pipefail\n', ''),
    gitMode: 'real',
    env,
  });
  assert.equal(unguarded.status, 0, 'without pipefail the broken diff is masked');
  assert.match(unguarded.output, /^run=false$/mu);
});

// Stands in for a `jq` that dies on its input -- a malformed `selection` exits 5. The
// selector's own output is well-formed by construction, so this is the transport
// failure (a truncated pipe, an OOM-killed jq) rather than a selector bug.
const FAILING_JQ_STUB = ['#!/bin/bash', 'cat > /dev/null', "echo 'jq: parse error' >&2", 'exit 5', ''].join('\n');

test('a failing jq reds selection instead of publishing an empty run= verdict', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());
  const env = {
    EVENT_NAME: 'merge_group',
    PR_BASE_REF: '',
    PR_HEAD_REF: '',
    MG_BASE_SHA: 'base-from-merge-group',
    GITHUB_SHA: 'checked-out-sha',
  };

  const guarded = runSelectionScript({ script, env, jqStub: FAILING_JQ_STUB });
  assert.notEqual(guarded.status, 0, 'a failing jq must red the job');
  assert.doesNotMatch(guarded.output, /run=/u, 'no run= verdict may be published');

  // The same script with the assignment folded back into the `echo` argument is the
  // defect being guarded, and running it proves the assertion above is load-bearing.
  // `set -e` does not see a command substitution in an argument position -- `echo`
  // returns 0 -- so the step publishes `run=`, `platform-verification-reusable` is
  // skipped, and the terminal gate accepts `skipped`: green, having verified nothing.
  const foldedBack = script.replace(
    /^run_value="\$\(jq -r '\.run' <<<"\$\{selection\}"\)"\n(?:.*\n)*?esac\necho "run=\$\{run_value\}"/mu,
    'echo "run=$(jq -r \'.run\' <<<"${selection}")"',
  );
  assert.notEqual(
    foldedBack,
    script,
    'the selection step must assign the jq result, validate it, and only then echo it',
  );
  const laundered = runSelectionScript({ script: foldedBack, env, jqStub: FAILING_JQ_STUB });
  assert.equal(laundered.status, 0, 'in argument position the jq failure is masked');
  assert.match(laundered.output, /^run=$/mu);
});

test('scheduled/manual audit is read-only, summarizes, and uploads deterministic evidence', () => {
  const source = readFileSync(resolve(workflowRoot, 'architecture-policy-audit.yml'), 'utf8');
  assert.match(source, /schedule:/u);
  assert.match(source, /workflow_dispatch:/u);
  assert.match(source, /contents: read/u);
  assert.match(source, /branch-protection-audit\.mjs/u);
  assert.match(source, /GITHUB_STEP_SUMMARY/u);
  assert.match(source, /actions\/upload-artifact@/u);
  assert.doesNotMatch(source, /\b(?:POST|PUT|PATCH|DELETE)\b/u);
});

// The audit's three result files live in a dot-directory, and `actions/upload-artifact`
// leaves dot-directories out unless `include-hidden-files: true` is set. Without it every
// run found no files, `if-no-files-found: error` failed the upload step, and the drift
// gate after it was skipped, so the run was red whether or not the policy had drifted
// (#5020). The step has to keep the evidence on every outcome, and the run has to go red
// only after that.
test('the audit uploads its evidence on every outcome and reds the run only after the upload', () => {
  const source = readFileSync(resolve(workflowRoot, 'architecture-policy-audit.yml'), 'utf8');
  const step = (name) => {
    const start = source.indexOf(`      - name: ${name}\n`);
    assert.ok(start >= 0, `the audit workflow is missing the step '${name}'`);
    const next = source.indexOf('\n      - ', start + 1);
    return { start, text: source.slice(start, next === -1 ? undefined : next) };
  };

  const read = step('Read branch protection and owner state');
  assert.match(read.text, /id: audit/u);
  assert.match(read.text, /continue-on-error: true/u);
  assert.match(read.text, /--out \.architecture-audit\/audit\.json/u);
  assert.match(read.text, /--summary \.architecture-audit\/summary\.md/u);
  assert.match(read.text, /2> \.architecture-audit\/error\.txt/u);

  const upload = step('Upload read-only audit evidence');
  assert.match(upload.text, /if: always\(\)/u);
  assert.match(upload.text, /name: architecture-policy-audit\n/u);
  assert.match(upload.text, /path: \.architecture-audit\n/u);
  assert.match(upload.text, /include-hidden-files: true\n/u);
  assert.match(upload.text, /if-no-files-found: error/u);

  const gate = step('Fail on policy drift');
  assert.match(gate.text, /if: steps\.audit\.outcome != 'success'/u);
  assert.match(gate.text, /run: exit 1/u);
  assert.ok(gate.start > upload.start, 'the drift gate must run after the evidence upload');
});

// A jq that succeeds with a non-boolean is the other half of the #2456 hole (#4060).
// `set -e` cannot see these: both exit 0. An empty `selection` makes real jq print
// nothing (`printf '' | jq -r '.run'`), and a `.run`-less object makes it print
// `null` -- and `run=` / `run=null` each fail the `== 'true'` gate, skip the
// reusable call, and satisfy the terminal gate's exact-`skipped` arm.
const EMPTY_OUTPUT_JQ_STUB = ['#!/bin/bash', 'cat > /dev/null', ''].join('\n');
const NULL_JQ_STUB = ['#!/bin/bash', 'cat > /dev/null', 'echo null', ''].join('\n');

/** Strip the guard the way a regression would: the assignment and echo stay, the check goes. */
function stripRunValueGuard(script) {
  const stripped = script.replace(/^case "\$\{run_value\}" in\n(?:.*\n)*?esac\n/mu, '');
  assert.notEqual(stripped, script, 'the selection step must validate run_value before publishing it');
  return stripped;
}

for (const { label, jqStub, laundered } of [
  { label: 'an empty selection', jqStub: EMPTY_OUTPUT_JQ_STUB, laundered: /^run=$/mu },
  { label: 'a selection with no .run key', jqStub: NULL_JQ_STUB, laundered: /^run=null$/mu },
]) {
  test(`${label} reds selection instead of publishing a non-boolean run verdict`, () => {
    const script = extractSelectionScript(readArchitectureControlWorkflow());
    const env = {
      EVENT_NAME: 'merge_group',
      PR_BASE_REF: '',
      PR_HEAD_REF: '',
      MG_BASE_SHA: 'base-from-merge-group',
      GITHUB_SHA: 'checked-out-sha',
    };

    const guarded = runSelectionScript({ script, env, jqStub });
    assert.notEqual(guarded.status, 0, 'a non-boolean run value must red the job');
    assert.doesNotMatch(guarded.output, /run=/u, 'no run= verdict may be published');
    assert.match(guarded.stdout + guarded.stderr, /::error::selection produced a non-boolean run value/u);

    // Kill-check: without the guard the same script exits 0 and publishes the value,
    // which is what makes the assertions above load-bearing rather than incidental.
    const unguarded = runSelectionScript({ script: stripRunValueGuard(script), env, jqStub });
    assert.equal(unguarded.status, 0, 'unguarded, the non-boolean value is masked');
    assert.match(unguarded.output, laundered);
  });
}

test('a boolean run value still publishes through the guard', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());
  for (const [selectorStub, expected] of [
    [SELECTOR_STUB, 'run=true'],
    [['#!/bin/bash', 'cat > "$SELECTOR_STDIN_LOG"', 'echo \'{ "run": false }\'', ''].join('\n'), 'run=false'],
  ]) {
    const passed = runSelectionScript({
      script,
      selectorStub,
      env: {
        EVENT_NAME: 'merge_group',
        PR_BASE_REF: '',
        PR_HEAD_REF: '',
        MG_BASE_SHA: 'base-from-merge-group',
        GITHUB_SHA: 'checked-out-sha',
      },
    });
    assert.equal(passed.status, 0, `${expected} must pass the guard`);
    assert.match(passed.output, new RegExp(`^${expected}$`, 'mu'));
  }
});

/**
 * Lift the `platform-verification` gate's steps out of the workflow: each step's name,
 * its `${{ ... }}` env bindings, and its `run:` script. A step-level `if:` or
 * `continue-on-error` would change which steps decide the job's conclusion, so both
 * are refused here rather than modeled.
 */
function parseGateSteps(source) {
  const gateJob = sliceJob(source, '  platform-verification:');
  const marker = '\n    steps:\n';
  const at = gateJob.indexOf(marker);
  assert.ok(at >= 0, 'platform-verification must declare steps:');
  const chunks = gateJob.slice(at + marker.length).split(/^ {6}- /mu).slice(1);
  assert.notEqual(chunks.length, 0, 'platform-verification must declare at least one step');
  return chunks.map((chunk) => {
    const name = chunk.match(/^name: (?<name>.+)$/mu)?.groups?.name;
    assert.ok(name, 'every platform-verification step must open with its name');
    assert.doesNotMatch(chunk, /^ {8}if:/mu, `${name}: a gate step must not be conditional`);
    assert.doesNotMatch(chunk, /continue-on-error/u, `${name}: a gate step must not continue on error`);
    const env = new Map(
      [...chunk.matchAll(/^ {10}(?<variable>[A-Z][A-Z0-9_]*): \$\{\{ (?<expression>[^}]+?) \}\}$/gmu)]
        .map(({ groups }) => [groups.variable, groups.expression]),
    );
    const inline = chunk.match(/^ {8}run: (?!\|)(?<command>.+)$/mu)?.groups?.command;
    if (inline !== undefined) return { name, env, script: `${inline}\n` };
    const blockMarker = '\n        run: |\n';
    const block = chunk.indexOf(blockMarker);
    assert.ok(block >= 0, `${name}: must carry a run: script`);
    const lines = [];
    for (const line of chunk.slice(block + blockMarker.length).split('\n')) {
      if (line.trim() === '') {
        lines.push('');
        continue;
      }
      if (!line.startsWith('          ')) break;
      lines.push(line.slice(10));
    }
    return { name, env, script: `${lines.join('\n')}\n` };
  });
}

/**
 * Run the gate's steps in order under `bash -e`, the shell GitHub Actions uses for a
 * `run:` step, stopping at the first non-zero exit the way a job does. Every binding a
 * step declares must be answered by `needs`, so a binding pointed at the wrong job
 * fails here instead of reading as an empty string.
 */
function runGate(steps, needs) {
  for (const step of steps) {
    const env = { PATH: process.env.PATH };
    for (const [variable, expression] of step.env) {
      assert.ok(
        Object.hasOwn(needs, expression),
        `${step.name}: binds ${variable} to \${{ ${expression} }}, which the lane under test does not answer`,
      );
      env[variable] = needs[expression];
    }
    const run = spawnSync('bash', ['-e', '-c', step.script], { encoding: 'utf8', env });
    if (run.status !== 0) return { conclusion: 'failure', step: step.name };
  }
  return { conclusion: 'success' };
}

// The two lanes the gate sees once selection succeeds: the pull-request fast lane and
// any unselected merge group skip the reusable call; a selected merge group runs it.
const UNSELECTED_LANE = Object.freeze({
  'needs.verification-selection.result': 'success',
  'needs.verification-selection.outputs.run': 'false',
  'needs.platform-verification-reusable.result': 'skipped',
});
const SELECTED_LANE = Object.freeze({
  'needs.verification-selection.result': 'success',
  'needs.verification-selection.outputs.run': 'true',
  'needs.platform-verification-reusable.result': 'success',
});
const RELEASE_SURFACE_RESULT = 'needs.platform-release-surface.result';

// `platform-release-surface` is not one of the required contexts on `next`, and before
// #5262 nothing required depended on it: on 2026-11-14 it failed in three merge groups
// whose `platform-verification` and `platform-architecture-control` were both green, and
// all three merges landed. The required `platform-verification` gate now carries it.
test('platform-verification needs platform-release-surface and binds its result', () => {
  const source = readArchitectureControlWorkflow();
  const gateJob = sliceJob(source, '  platform-verification:');
  assert.match(gateJob, /^ {4}if: always\(\)$/mu, 'the gate must report even when a job it needs fails');
  const needsBlock = gateJob.match(/^ {4}needs:\n(?<list>(?: {6}- [A-Za-z0-9_-]+\n)+)/mu)?.groups?.list;
  assert.ok(needsBlock, 'platform-verification must declare a block-sequence needs:');
  const needs = [...needsBlock.matchAll(/- (?<id>[A-Za-z0-9_-]+)/gu)].map(({ groups }) => groups.id);
  assert.deepEqual(
    [...needs].sort(),
    ['platform-release-surface', 'platform-verification-reusable', 'verification-selection'],
  );
  // `needs.<job>` resolves to nothing for a job outside `needs:`, so every job the gate
  // reads must also be one it waits for.
  for (const [, job] of gateJob.matchAll(/needs\.(?<job>[A-Za-z0-9_-]+)\./gu)) {
    assert.ok(needs.includes(job), `platform-verification reads needs.${job} without needing it`);
  }
  assert.match(gateJob, /RELEASE_SURFACE_RESULT: \$\{\{ needs\.platform-release-surface\.result \}\}/u);
  assert.match(gateJob, /test "\$\{RELEASE_SURFACE_RESULT\}" = success/u);
});

// Exact success is only safe to demand of a job that always runs. The workflow has no
// `paths:` filter (the trigger set is pinned above), and the job carries no `if:` and no
// `needs:`, so it runs on every pull request, merge group, and dispatch that runs the
// gate. A condition added later must change the gate in the same edit.
test('platform-release-surface runs whenever the workflow does', () => {
  const releaseJob = sliceJob(
    readArchitectureControlWorkflow(),
    '  platform-release-surface:',
    '  platform-verification-reusable:',
  );
  assert.doesNotMatch(releaseJob, /^ {4}if:/mu);
  assert.doesNotMatch(releaseJob, /^ {4}needs:/mu);
  assert.doesNotMatch(releaseJob, /continue-on-error/u);
});

test('a failed, cancelled, or skipped platform-release-surface fails platform-verification on every lane', () => {
  const steps = parseGateSteps(readArchitectureControlWorkflow());
  for (const [label, lane] of [['unselected', UNSELECTED_LANE], ['selected', SELECTED_LANE]]) {
    assert.deepEqual(
      runGate(steps, { ...lane, [RELEASE_SURFACE_RESULT]: 'success' }),
      { conclusion: 'success' },
      `${label}: a green release surface must leave the gate green`,
    );
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(
        runGate(steps, { ...lane, [RELEASE_SURFACE_RESULT]: result }).conclusion,
        'failure',
        `${label}: a '${result}' release surface must fail platform-verification`,
      );
    }
  }

  // Kill-check: the same gate without the steps that read the release surface is the
  // shape that let the three merges land. It goes green over a failed release surface,
  // which is what makes the assertions above load-bearing.
  const withoutReleaseSurface = steps.filter(
    (step) => ![...step.env.values()].includes(RELEASE_SURFACE_RESULT),
  );
  assert.ok(withoutReleaseSurface.length < steps.length, 'a gate step must bind the release-surface result');
  for (const lane of [UNSELECTED_LANE, SELECTED_LANE]) {
    assert.equal(
      runGate(withoutReleaseSurface, { ...lane, [RELEASE_SURFACE_RESULT]: 'failure' }).conclusion,
      'success',
    );
  }
});

test('with a green release surface the gate keeps its selection rule', () => {
  const steps = parseGateSteps(readArchitectureControlWorkflow());
  const green = { [RELEASE_SURFACE_RESULT]: 'success' };
  const cases = [
    [{ ...UNSELECTED_LANE, 'needs.verification-selection.result': 'failure' }, 'failure'],
    [{ ...UNSELECTED_LANE }, 'success'],
    [{ ...UNSELECTED_LANE, 'needs.platform-verification-reusable.result': 'failure' }, 'failure'],
    [{ ...UNSELECTED_LANE, 'needs.platform-verification-reusable.result': 'cancelled' }, 'failure'],
    [{ ...SELECTED_LANE }, 'success'],
    [{ ...SELECTED_LANE, 'needs.platform-verification-reusable.result': 'skipped' }, 'failure'],
    [{ ...SELECTED_LANE, 'needs.platform-verification-reusable.result': 'failure' }, 'failure'],
    [{ ...SELECTED_LANE, 'needs.platform-verification-reusable.result': 'cancelled' }, 'failure'],
  ];
  for (const [lane, expected] of cases) {
    assert.equal(runGate(steps, { ...lane, ...green }).conclusion, expected, JSON.stringify(lane));
  }
});
