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

// Stands in for `platform-verification-selection.mjs`, reproducing the one behaviour
// of it the surrounding shell has to survive: empty stdin yields `run: false`. That
// is the selector's real CLI behaviour — `''.split('\n')` is `['']`, which normalises
// to no paths, so its documented empty-input fail-safe is unreachable from a pipe.
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
function runSelectionScript({ script, env, gitMode = 'stub' }) {
  const dir = mkdtempSync(join(tmpdir(), 'pac-selection-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const gitArgsLog = join(dir, 'git-args.log');
    const selectorStdinLog = join(dir, 'selector-stdin.log');
    const githubOutput = join(dir, 'github-output');
    for (const path of [gitArgsLog, selectorStdinLog, githubOutput]) writeFileSync(path, '');

    if (gitMode === 'stub') writeExecutable(join(bin, 'git'), GIT_STUB);
    writeExecutable(join(bin, 'node'), SELECTOR_STUB);
    writeExecutable(join(bin, 'jq'), JQ_STUB);

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
  // Selection is diff-driven on both lanes: the pull_request branch keeps the base/head
  // pair it has always used, and the merge_group branch reads its base off the merge-group
  // payload so a narrow queue entry stops paying the full battery. Any other event still
  // verifies in full. The three-dot diff needs unshallow history on both.
  const selectionJob = sliceJob(source, '  verification-selection:', '  platform-release-surface:');
  assert.match(selectionJob, /fetch-depth: 0/u);
  assert.match(selectionJob, /timeout-minutes: 5/u);
  assert.match(selectionJob, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u);
  assert.match(selectionJob, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(selectionJob, /MG_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/u);
  assert.match(selectionJob, /^\s+pull_request\)\n\s+diff_base="\$\{BASE_SHA\}"\n\s+diff_head="\$\{HEAD_SHA\}"/mu);
  // One source of truth for the merge-group head. `github.sha` is what the checkout above
  // resolved, so the diff head is by construction the tree being verified;
  // `merge_group.head_sha` as a second, unbound spelling of the same thing is pinned out.
  assert.match(selectionJob, /^\s+merge_group\)\n\s+diff_base="\$\{MG_BASE_SHA\}"\n\s+diff_head="\$\{GITHUB_SHA\}"/mu);
  // Scoped to directives: the surrounding prose explains why `merge_group.head_sha` is
  // not used, and must stay free to name it.
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
  assert.doesNotMatch(source, /npm (?:publish|install)|yarn npm publish|publish-verified-platform/u);
  const topPermissions = source.match(/^permissions:\n(?<body>[\s\S]*?)\njobs:/mu)?.groups?.body;
  assert.equal(topPermissions?.trimEnd(), '  contents: read');
  const controlJob = sliceJob(source, '  platform-architecture-control:', '  platform-verification-reusable:');
  const reusableJob = sliceJob(source, '  platform-verification-reusable:', '  platform-verification:');
  const finalJob = sliceJob(source, '  platform-verification:');
  assert.doesNotMatch(controlJob, /(?:id-token|attestations|artifact-metadata): write/u);
  assert.match(controlJob, /node \.github\/scripts\/generate-architecture\.mjs --check/u);
  assert.match(controlJob, /\.github\/scripts\/benchmark-product-source-boundaries\.test\.mjs/u);
  assert.match(reusableJob, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+attestations: write\n\s+artifact-metadata: write/u);
  assert.doesNotMatch(finalJob, /(?:id-token|attestations|artifact-metadata): write/u);
});

test('the selection script resolves its diff endpoints from the event it is given', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());

  const pullRequest = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'pull_request',
      BASE_SHA: 'base-from-pull-request',
      HEAD_SHA: 'head-from-pull-request',
      MG_BASE_SHA: '',
      GITHUB_SHA: 'checked-out-sha',
    },
  });
  assert.equal(pullRequest.status, 0, pullRequest.stderr);
  assert.match(pullRequest.gitArgs, /^base-from-pull-request\.\.\.head-from-pull-request$/mu);
  assert.match(pullRequest.output, /^run=true$/mu);

  // The merge-group head is `GITHUB_SHA`, not a second payload field.
  const mergeGroup = runSelectionScript({
    script,
    env: {
      EVENT_NAME: 'merge_group',
      BASE_SHA: '',
      HEAD_SHA: '',
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
    env: { EVENT_NAME: 'workflow_dispatch', BASE_SHA: '', HEAD_SHA: '', MG_BASE_SHA: '', GITHUB_SHA: 'checked-out-sha' },
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.match(dispatch.output, /^run=true$/mu);
  assert.equal(dispatch.gitArgs, '');
});

test('the selection script refuses to unselect when a diff endpoint is unresolved', () => {
  const script = extractSelectionScript(readArchitectureControlWorkflow());

  for (const [label, env] of [
    ['merge_group', { EVENT_NAME: 'merge_group', BASE_SHA: '', HEAD_SHA: '', MG_BASE_SHA: '', GITHUB_SHA: 'checked-out-sha' }],
    ['pull_request', { EVENT_NAME: 'pull_request', BASE_SHA: 'base-from-pull-request', HEAD_SHA: '', MG_BASE_SHA: '', GITHUB_SHA: '' }],
  ]) {
    const unresolved = runSelectionScript({ script, env });
    assert.notEqual(unresolved.status, 0, `${label}: an unresolved endpoint must red the job`);
    assert.match(unresolved.stdout, new RegExp(`::error::selection endpoints unresolved on ${label}`, 'u'));
    // No diff was attempted and no verdict was published — the terminal gate sees a
    // non-success selection job rather than an unselected battery.
    assert.equal(unresolved.gitArgs, '', `${label}: no diff should be attempted`);
    assert.equal(unresolved.output, '', `${label}: no run= verdict should be published`);
  }
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
  // dies on the bad objects, the selector reads empty stdin and answers `run: false`,
  // the pipeline inherits the selector's exit 0 — and `platform-verification` reports
  // green on the lane that lands code, having verified nothing.
  const unguarded = runSelectionScript({
    script: script.replace('set -o pipefail\n', ''),
    gitMode: 'real',
    env,
  });
  assert.equal(unguarded.status, 0, 'without pipefail the broken diff is masked');
  assert.match(unguarded.output, /^run=false$/mu);
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
