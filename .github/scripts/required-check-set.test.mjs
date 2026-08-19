import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { REQUIRED_CHECK_SET, requiredContexts } from './required-check-set.mjs';

const workflowsRoot = resolve(import.meta.dirname, '../workflows');
const workflowFiles = readdirSync(workflowsRoot)
  .filter((file) => file.endsWith('.yml'))
  .sort();
const sources = new Map(workflowFiles.map((file) => [
  file,
  readFileSync(resolve(workflowsRoot, file), 'utf8'),
]));

// Raw-source slicing, no YAML parser: the same house pattern
// `platform-verification-workflow.test.mjs` and `layer-publish-workflow.test.mjs`
// use. `.github/scripts/` has no dependency manifest, so a parser is not
// available to add.

function sourceOf(file) {
  const source = sources.get(file);
  assert.notEqual(source, undefined, `${file}: named by the required-check set but absent from .github/workflows/`);
  return source;
}

function jobsSection(file) {
  const source = sourceOf(file);
  const marker = '\njobs:\n';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${file}: declares no jobs: block`);
  return source.slice(start + marker.length);
}

function jobBlocks(file) {
  const section = jobsSection(file);
  const heads = [...section.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gmu)];
  assert.notEqual(heads.length, 0, `${file}: jobs: block declares no jobs`);
  return heads.map((head, index) => ({
    id: head[1],
    block: section.slice(
      head.index,
      index + 1 < heads.length ? heads[index + 1].index : section.length,
    ),
  }));
}

// The check name GitHub reports for a job is its display `name:` when it has
// one, and its job id otherwise. A job-level `name:` sits at four spaces; a
// step's sits at six or more.
function displayName({ id, block }) {
  return block.match(/^ {4}name:[ \t]+(.+?)[ \t]*$/mu)?.[1] ?? id;
}

const allJobs = workflowFiles.flatMap((file) => jobBlocks(file).map((job) => ({
  file,
  id: job.id,
  block: job.block,
  name: displayName(job),
})));

// Trigger parsing reads a comment-stripped copy of the source. A full-line `#`
// at column 0 otherwise terminates the `on:` block scan below (`(?=^\S)` matches
// `#`), which fails OPEN: a comment written above `push:` hid the trigger
// entirely and this file's queue-reachability test passed a workflow that fires
// on every queue ref. Only lines whose first non-space character is `#` are
// removed, and only for trigger parsing — job blocks are read from the raw
// source, so shell comments inside `run: |` bodies are untouched.
const triggerSources = new Map([...sources].map(([file, source]) => [
  file,
  source.replaceAll(/^[ \t]*#.*$/gmu, ''),
]));

function triggerSourceOf(file) {
  sourceOf(file);
  return triggerSources.get(file);
}

// `on:` has three legal spellings. Block form is what every workflow here uses;
// flow (`on: [pull_request]`) and bare-scalar (`on: push`) forms are accepted so
// they parse into a real trigger list instead of hard-failing with a misleading
// "has no top-level on: block". The key itself may be quoted — YAML 1.1 reads a
// bare `on` as the boolean true, so `"on":` is a legitimate defensive spelling.
function onBlock(file) {
  const source = triggerSourceOf(file);
  const block = source.match(/^["']?on["']?:\n(?<body>[\s\S]*?)(?=^\S)/mu)?.groups?.body;
  if (block !== undefined) return { form: 'block', body: block };
  const inline = source.match(/^["']?on["']?:[ \t]+(?<value>.+?)[ \t]*$/mu)?.groups?.value;
  assert.notEqual(inline, undefined, `${file}: has no top-level on: block`);
  const flow = inline.match(/^\[(?<list>[^\]]*)\]$/u);
  const triggers = (flow ? flow.groups.list.split(',') : [inline])
    .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean);
  return { form: 'inline', triggers };
}

function triggerBlock(file, trigger) {
  const on = onBlock(file);
  // An inline trigger declares no filters at all. Returning the empty body (not
  // null) says "this trigger exists and is unfiltered", which is what makes the
  // reachability assertion below fail CLOSED on `on: [push]`.
  if (on.form === 'inline') return on.triggers.includes(trigger) ? '' : null;
  const head = on.body.match(new RegExp(`^ {2}${trigger}:[ \\t]*$`, 'mu'));
  if (!head) return null;
  const rest = on.body.slice(head.index + head[0].length + 1);
  const next = rest.search(/^ {2}\S/mu);
  return next === -1 ? rest : rest.slice(0, next);
}

// `needs:` appears as a flow sequence, a block sequence, or a bare scalar.
function parseNeeds(block) {
  const flow = block.match(/^ {4}needs:[ \t]*\[(?<list>[^\]]*)\][ \t]*$/mu);
  if (flow) return flow.groups.list.split(',').map((entry) => entry.trim()).filter(Boolean);
  const scalar = block.match(/^ {4}needs:[ \t]+(?<one>[A-Za-z0-9_-]+)[ \t]*$/mu);
  if (scalar) return [scalar.groups.one];
  const head = block.match(/^ {4}needs:[ \t]*$/mu);
  if (!head) return [];
  const entries = [];
  for (const line of block.slice(head.index + head[0].length + 1).split('\n')) {
    const item = line.match(/^ {6}- (?<id>[A-Za-z0-9_-]+)[ \t]*$/u);
    if (!item) break;
    entries.push(item.groups.id);
  }
  return entries;
}

// The `${{ needs.<id>.result }}` bindings a job block declares, as env variable
// name -> job id. Job-level `env:` sits at six spaces, a step's at ten; both are
// legitimate places to bind a result, so match any indent.
function resultBindings(block) {
  return new Map(
    [...block.matchAll(
      /^ {4,}(?<variable>[A-Z][A-Z0-9_]*):[ \t]+\$\{\{[ \t]*needs\.(?<job>[A-Za-z0-9_-]+)\.result[ \t]*\}\}[ \t]*$/gmu,
    )].map((match) => [match.groups.variable, match.groups.job]),
  );
}

// The whole point of a terminal gate is the shell in its `run:` body: `needs:`
// alone makes the gate WAIT for a job, not FAIL on it, because `if: always()`
// means an upstream failure no longer skips the gate. Pinning `needs:` and
// `if:` while leaving the body unread is the hole this closes — the review that
// found it replaced ci.yml's `test "${CHANGES_RESULT}" = success` with a no-op
// and every test in this file stayed green.
//
// MUTATION-VERIFIED: no-op any single `test "${*_RESULT}" = ...` line in a gate
// body, or delete one `*_RESULT:` binding, and this assertion must fail. If a
// future edit makes it pass again, the assertion is broken, not the workflow.
//
// The precedent is `platform-verification-workflow.test.mjs`'s receipt-gate
// block, which pins the same three-part shape (needs -> result binding -> shell
// comparison) for the PAC receipt; `architecture-control-workflow.test.mjs`
// pins the literal `test "${VERIFICATION_RESULT}" = success` strings for the PAC
// gate. Neither covers the operator-surface gates, which is why this exists.
function assertGateConsumesEveryNeed(label, block) {
  const needs = parseNeeds(block);
  assert.notEqual(needs.length, 0, `${label}: a terminal gate must declare needs:`);
  const bindings = resultBindings(block);
  const boundJobs = new Set(bindings.values());
  for (const need of needs) {
    assert.ok(
      boundJobs.has(need),
      `${label}: needs ${need} but never binds \${{ needs.${need}.result }} into an env variable; needs: alone makes the gate WAIT for that job, and with if: always() a red or cancelled ${need} then lands behind a green required context`,
    );
  }
  for (const [variable, job] of bindings) {
    // `test "${X}" = ...` and `[ "${X}" = ... ]` are the same builtin; accept
    // either spelling, and nothing looser.
    assert.match(
      block,
      new RegExp(`(?:test|\\[)[ \\t]+"\\$\\{${variable}\\}"[ \\t]+=[ \\t]`, 'u'),
      `${label}: binds ${variable} from ${job}.result but never compares it; a bound-and-unread result is a job the gate waits for and then ignores`,
    );
  }
}

// A `branches:` filter, or null when the trigger declares none.
function branchEntries(triggerBody) {
  const flow = triggerBody.match(/^ {4}branches:[ \t]*\[(?<list>[^\]]*)\][ \t]*$/mu);
  if (flow) {
    return flow.groups.list
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
      .filter(Boolean);
  }
  // Deliberately only `branches:`. A `branches-ignore:` list inverts the
  // semantics, so reading one as an allowlist would fail open; leaving it
  // unparsed returns null, which `admitsQueueBranch` treats as unfiltered and
  // the reachability assertion then reports loudly.
  const head = triggerBody.match(/^ {4}branches:[ \t]*$/mu);
  if (!head) return null;
  const entries = [];
  for (const line of triggerBody.slice(head.index + head[0].length + 1).split('\n')) {
    const item = line.match(/^ {6}- (?<entry>.+?)[ \t]*$/u);
    if (!item) break;
    entries.push(item.groups.entry.replace(/^['"]|['"]$/gu, ''));
  }
  return entries;
}

// `branches-ignore:` inverts the semantics of `branches:`, so it is never read
// as an allowlist. Detecting it only buys a message that names what is wrong;
// the assertion still rejects.
function branchesIgnoreDeclared(triggerBody) {
  return /^ {4}branches-ignore:/mu.test(triggerBody);
}

const QUEUE_REF_PREFIX = 'gh-readonly-queue';
// A representative ref of the shape the queue creates. Every branch filter is
// evaluated against this rather than against an enumeration of wildcard
// spellings: `**/*` is neither `*` nor `**` nor a `gh-readonly-queue` prefix,
// yet it matches this ref, and the enumeration this replaces passed a
// Docker-publish lane whose push filter was exactly `['**/*']`.
const QUEUE_REF_SAMPLE = `${QUEUE_REF_PREFIX}/next/pr-1-abc`;

function escapeRegExp(literal) {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// GitHub filter-pattern semantics for `branches:`: `*` matches any run of
// characters except `/`, `**` matches any run including `/`, `?` matches zero or
// one character, `+` quantifies the preceding character, `\` escapes, and the
// pattern must match the WHOLE ref.
function branchPatternToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]?';
    } else if (character === '+') {
      source += '+';
    } else if (character === '\\') {
      index += 1;
      source += index < pattern.length ? escapeRegExp(pattern[index]) : '\\\\';
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

function admitsQueueBranch(entries) {
  if (entries === null || entries.length === 0) return true;
  // Negations are skipped rather than subtracted. A `!` entry can therefore
  // never rescue an over-broad positive from this check — the fail-closed
  // direction, since a false "admits" reddens the test and demands a human look
  // while a false "does not admit" would wave a queue-reachable lane through.
  return entries.some((entry) => !entry.startsWith('!')
    && branchPatternToRegExp(entry).test(QUEUE_REF_SAMPLE));
}

function workflowRunUpstreams(triggerBody) {
  const flow = triggerBody.match(/^ {4}workflows:[ \t]*\[(?<list>[^\]]*)\][ \t]*$/mu);
  if (!flow) return null;
  return flow.groups.list
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean);
}

const workflowFileByName = new Map(workflowFiles.map((file) => [
  sourceOf(file).match(/^name:[ \t]+(?<name>.+?)[ \t]*$/mu)?.groups?.name,
  file,
]));

// A workflow reacts to activity on `gh-readonly-queue/**` if its own `push:`
// trigger admits those refs, or if it rides a `workflow_run:` of an upstream
// workflow that does. `merge_group:` is the sanctioned lane and is not branch
// activity, so it is not counted here.
function queueBranchReachable(file, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const push = triggerBlock(file, 'push');
  if (push !== null && admitsQueueBranch(branchEntries(push))) return true;
  const run = triggerBlock(file, 'workflow_run');
  if (run === null || !admitsQueueBranch(branchEntries(run))) return false;
  const upstreams = workflowRunUpstreams(run);
  if (upstreams === null) return true;
  return upstreams.some((name) => {
    const upstream = workflowFileByName.get(name);
    return upstream === undefined || queueBranchReachable(upstream, seen);
  });
}

const producerWorkflows = [...new Set(REQUIRED_CHECK_SET.map((member) => member.workflow))].sort();

// The terminal gate jobs step 0 introduced: one uniquely-named job per operator
// and structure surface that collects its whole workflow. The two PAC contexts
// are shaped differently on purpose (`platform-architecture-control` collects
// nothing; `platform-verification` collects only the selection and reusable
// call) and are pinned by `architecture-control-workflow.test.mjs` instead.
//
// Selected by the `terminal` flag, not by a `-gate` name suffix: a future
// terminal member named anything else would silently drop out of a suffix
// filter and lose its whole-workflow coverage assertion without a single test
// going red.
const gateMembers = REQUIRED_CHECK_SET.filter((member) => member.kind === 'job'
  && member.terminal === true);

test('the required-check set is a frozen, well-formed contract', () => {
  assert.ok(Object.isFrozen(REQUIRED_CHECK_SET), 'REQUIRED_CHECK_SET must be frozen');
  for (const member of REQUIRED_CHECK_SET) {
    assert.ok(Object.isFrozen(member), `${member.context}: each member must be frozen`);
    const keys = Object.keys(member).sort();
    assert.deepEqual(
      keys.filter((key) => key !== 'terminal'),
      ['context', 'kind', 'workflow'],
      `${member.context}: unexpected member keys (${keys.join(', ')})`,
    );
    if ('terminal' in member) {
      assert.equal(member.terminal, true, `${member.context}: terminal is a marker; omit it rather than setting it false`);
    }
    // The inverse of the `terminal`-not-suffix selection above: a member named
    // `*-gate` that forgot the flag would drop out of the terminal-gate test
    // just as silently as the suffix filter dropped a differently-named one.
    if (member.context.endsWith('-gate')) {
      assert.equal(member.terminal, true, `${member.context}: a *-gate context collects its whole workflow, so it must be marked terminal: true`);
    }
    assert.ok(['job', 'check-run'].includes(member.kind), `${member.context}: unknown kind ${member.kind}`);
    assert.ok(sources.has(member.workflow), `${member.context}: names a workflow that does not exist (${member.workflow})`);
  }
  const contexts = REQUIRED_CHECK_SET.map((member) => member.context);
  assert.equal(new Set(contexts).size, contexts.length, 'a context may appear only once in the set');
  assert.deepEqual(requiredContexts(), [...contexts].sort(), 'requiredContexts() must return every member context, sorted');
});

test('every required context has exactly one producer and nothing else shadows it', () => {
  for (const member of REQUIRED_CHECK_SET) {
    const reporters = allJobs.filter((job) => job.name === member.context);
    const found = reporters.map((job) => `${job.file}#${job.id}`).join(', ') || 'none';
    if (member.kind === 'job') {
      assert.equal(
        reporters.length,
        1,
        `${member.context}: exactly one job in .github/workflows/ may report this check name, found ${found}`,
      );
      assert.equal(
        reporters[0].file,
        member.workflow,
        `${member.context}: the set names ${member.workflow} but ${reporters[0].file} reports it`,
      );
      // Inverse of the check-run branch below: a native job already reports this
      // name. An API-posted twin of the same context races the job on trusted
      // SHAs and, when the poster is skipped on fork PRs, silences the required
      // check for outsiders (Permissionless).
      const declaration = new RegExp(`["']context["'][ \\t]*:[ \\t]*["']${escapeRegExp(member.context)}["']`, 'u');
      const declarers = workflowFiles.filter((file) => declaration.test(sourceOf(file)));
      assert.deepEqual(
        declarers,
        [],
        `${member.context}: a job-produced context must not also be posted as a check-run, found ${declarers.join(', ') || 'none'}`,
      );
      continue;
    }
    assert.equal(
      reporters.length,
      0,
      `${member.context}: an API-posted check-run must not also be a job check name, found ${found}`,
    );
    // Whitespace- and quote-tolerant: the poster reads a JSON `context` field,
    // and reformatting the verdict heredoc (single quotes, no space after the
    // colon) must not make this scan quietly stop finding the declaration.
    const declaration = new RegExp(`["']context["'][ \\t]*:[ \\t]*["']${escapeRegExp(member.context)}["']`, 'u');
    const declarers = workflowFiles.filter((file) => declaration.test(sourceOf(file)));
    assert.deepEqual(
      declarers,
      [member.workflow],
      `${member.context}: exactly one workflow may post this check-run context, found ${declarers.join(', ') || 'none'}`,
    );
    assert.match(
      sourceOf(member.workflow),
      /post-check-run-verdict\.mjs/u,
      `${member.workflow}: must post ${member.context} through the shared check-run poster`,
    );
  }
});

test('hermetic-gate is a native job so fork PRs report the required context', () => {
  // The suite itself is fork-safe (no secrets). An API-posted producer is not:
  // fork GITHUB_TOKEN is read-only, so the poster is skipped and the required
  // context never appears — those PRs can never enqueue. The native job is the
  // same shape as the other nine required checks.
  const member = REQUIRED_CHECK_SET.find((entry) => entry.context === 'hermetic-gate');
  assert.notEqual(member, undefined, 'the set must include hermetic-gate');
  assert.equal(
    member.kind,
    'job',
    'hermetic-gate must be kind: job; an API-posted check-run is skipped on fork PRs',
  );
  assert.doesNotMatch(
    sourceOf('hermetic-gate.yml'),
    /post-check-run-verdict\.mjs/u,
    'hermetic-gate.yml must not post the required context through the Checks API',
  );
  const gate = jobBlocks('hermetic-gate.yml').find((job) => displayName(job) === 'hermetic-gate');
  assert.notEqual(gate, undefined, 'hermetic-gate.yml must contain a job whose display name is hermetic-gate');
  assert.match(
    gate.block,
    /^ {4}if: always\(\)[ \t]*$/mu,
    'hermetic-gate must run with if: always() and no fork carve-out, or a fork PR never reports the required context',
  );
});

test('hermetic-gate does not apt-install Playwright system packages on the required path', () => {
  // merge_group run 32272723606 (#2868) hung 53 minutes inside
  // `yarn playwright install --with-deps chromium` on azure.archive.ubuntu.com
  // (Ign, then stall after mixing archive.ubuntu.com). The 60-minute job
  // timeout cancelled a still-running apt, the terminal job reported red, and
  // the queue ejected every entry. GitHub-hosted ubuntu-24.04 already has the
  // Chromium system libraries; the required path must download the browser
  // only, and a hung download must fail the step instead of burning the job
  // budget.
  const suite = jobBlocks('hermetic-gate.yml').find((job) => job.id === 'hermetic');
  assert.notEqual(suite, undefined, 'hermetic-gate.yml must contain the suite job `hermetic`');
  assert.doesNotMatch(
    suite.block,
    /playwright install --with-deps/u,
    'hermetic-gate must not run `playwright install --with-deps`: apt against azure.archive.ubuntu.com hung merge_group run 32272723606 for 53 minutes and ejected the queue',
  );
  assert.match(
    suite.block,
    /yarn playwright install chromium/u,
    'hermetic-gate must still install Chromium for the app-flow journeys',
  );
  const installStep = suite.block.match(
    /^ {6}- name: Install operator console\n(?<body>(?: {8}.*\n)+)/mu,
  );
  assert.notEqual(installStep, null, 'hermetic suite must keep an Install operator console step');
  assert.match(
    installStep.groups.body,
    /^ {8}timeout-minutes: [1-9][0-9]*[ \t]*$/mu,
    'a hung Playwright download must fail the install step, not burn the 60-minute job timeout',
  );
});

test('the check-run producer posts its context however the gate job ends', () => {
  for (const member of REQUIRED_CHECK_SET.filter((entry) => entry.kind === 'check-run')) {
    const jobs = jobBlocks(member.workflow);
    const posters = jobs.filter((job) => job.block.includes('post-check-run-verdict.mjs'));
    assert.equal(posters.length, 1, `${member.workflow}: exactly one job may post ${member.context}`);
    const [poster] = posters;
    // END-ANCHORED, and the ONLY extra clause allowed is the fork carve-out
    // documented on this member in required-check-set.mjs. An unanchored
    // `if: always()` match accepted anything appended to it: the review that
    // found this appended `&& github.event_name != 'merge_group'` and every test
    // here stayed green, which on the one check-run member is 100% queue
    // ejection through a required context that is never reported at all.
    assert.match(
      poster.block,
      /^ {4}if: always\(\)(?: && github\.event\.pull_request\.head\.repo\.fork != true)?[ \t]*$/mu,
      `${member.workflow}: ${poster.id} must run with exactly if: always(), optionally with the documented fork carve-out and nothing else — any further condition can silence ${member.context} on the very event that needs it`,
    );
    const needs = parseNeeds(poster.block);
    const others = jobs.map((job) => job.id).filter((id) => id !== poster.id);
    assert.deepEqual(
      [...needs].sort(),
      [...others].sort(),
      `${member.workflow}: ${poster.id} must need every other job so ${member.context} covers the whole workflow`,
    );
    assertGateConsumesEveryNeed(`${member.workflow}#${poster.id}`, poster.block);
  }
});

test('every producer workflow reports on merge groups and carries no workflow-level path filter', () => {
  for (const workflow of producerWorkflows) {
    assert.notEqual(
      triggerBlock(workflow, 'merge_group'),
      null,
      `${workflow}: produces a required context but declares no merge_group: trigger; the context would never be reported on a merge group and the entry would hang until the check-response timeout ejects it`,
    );
    for (const trigger of ['pull_request', 'push']) {
      const body = triggerBlock(workflow, trigger);
      if (body === null) continue;
      assert.doesNotMatch(
        body,
        /^ {4}paths(?:-ignore)?:/mu,
        `${workflow}: the ${trigger} trigger carries a workflow-level paths filter; a filtered-out workflow reports nothing at all, so the filter belongs on the jobs (DR-2026-08-18-b D3/D6)`,
      );
    }
  }
});

test('every terminal gate runs always() and collects its whole workflow', () => {
  assert.notEqual(gateMembers.length, 0, 'the set must contain terminal gate members');
  for (const member of gateMembers) {
    const jobs = jobBlocks(member.workflow);
    const gate = jobs.find((job) => displayName(job) === member.context);
    assert.notEqual(gate, undefined, `${member.workflow}: no job reports ${member.context}`);
    assert.match(
      gate.block,
      /^ {4}if: always\(\)[ \t]*$/mu,
      `${member.workflow}: ${member.context} must run with if: always(), or a cancelled upstream job leaves the required context unreported`,
    );
    const needs = parseNeeds(gate.block);
    const others = jobs.map((job) => job.id).filter((id) => id !== gate.id);
    assert.deepEqual(
      [...needs].sort(),
      [...others].sort(),
      `${member.workflow}: ${member.context} must need every other job in the workflow, or a red job lands behind a green required context`,
    );
    assertGateConsumesEveryNeed(`${member.workflow}#${member.context}`, gate.block);
  }
});

test('no workflow reacts to branch activity on a merge-queue ref', () => {
  for (const file of workflowFiles) {
    for (const trigger of ['push', 'workflow_run']) {
      const body = triggerBlock(file, trigger);
      if (body === null) continue;
      const entries = branchEntries(body);
      if (trigger === 'push') {
        assert.notEqual(
          entries,
          null,
          branchesIgnoreDeclared(body)
            ? `${file}: the push trigger filters with branches-ignore:, whose semantics are inverted; it is rejected rather than read as an allowlist, because everything not named — including every gh-readonly-queue/** ref — passes it. Use an explicit branches: allowlist`
            : `${file}: the push trigger declares no branches: list, so it fires on every gh-readonly-queue/** ref the queue creates`,
        );
        assert.notEqual(entries.length, 0, `${file}: the push trigger's branches: list is empty`);
      }
      for (const entry of entries ?? []) {
        assert.ok(
          !entry.startsWith(QUEUE_REF_PREFIX),
          `${file}: the ${trigger} branches: entry ${entry} targets the merge-queue ref space`,
        );
        // Kept alongside the glob evaluation below as defense in depth. Under
        // GitHub's semantics a bare `*` does not actually match a queue ref
        // (`*` stops at `/`), but a bare wildcard on a lane that must never see
        // one is a smell worth rejecting on sight.
        assert.ok(
          entry !== '*' && entry !== '**',
          `${file}: the ${trigger} branches: entry ${entry} is a bare wildcard and admits gh-readonly-queue/** refs`,
        );
        assert.ok(
          entry.startsWith('!') || !branchPatternToRegExp(entry).test(QUEUE_REF_SAMPLE),
          `${file}: the ${trigger} branches: entry ${entry} matches ${QUEUE_REF_SAMPLE} under GitHub filter-pattern semantics, so it fires on merge-queue refs`,
        );
      }
    }
    // A `workflow_run:` without its own `branches:` filter is scoped by the
    // upstream workflow it rides, so prove queue-unreachability transitively
    // rather than demanding a redundant filter. `npm-publish-monitor.yml` and
    // `published-artifacts-smoke.yml` are exactly this shape today.
    assert.equal(
      queueBranchReachable(file),
      false,
      `${file}: can be triggered by activity on a gh-readonly-queue/** ref; publish and release lanes must never fire from a speculative queue commit (DR-2026-08-18-b D5)`,
    );
  }
});

test('branch patterns are evaluated with GitHub glob semantics, not a wildcard enumeration', () => {
  // `admits` is "does this branches: entry fire on a merge-queue ref". The
  // enumeration this table replaces answered yes only for `*`, `**`, and a
  // literal `gh-readonly-queue` prefix, so `**/*` read as safe.
  const cases = [
    { pattern: 'next', admits: false },
    { pattern: 'main', admits: false },
    { pattern: 'release/*', admits: false },
    { pattern: 'integration/evidence-v1', admits: false },
    // `*` and `?` stop at `/`; the queue ref has two separators.
    { pattern: '*', admits: false },
    { pattern: 'gh-readonly-queue', admits: false },
    { pattern: 'gh-readonly-queue/*', admits: false },
    // `**` crosses `/`.
    { pattern: '**', admits: true },
    { pattern: '**/*', admits: true },
    { pattern: '*/**', admits: true },
    { pattern: 'gh-readonly-queue/**', admits: true },
    { pattern: 'gh-readonly-queue/next/**', admits: true },
    { pattern: 'gh-readonly-queue/*/pr-1-abc', admits: true },
    // Anchored at both ends: a prefix alone is not a match.
    { pattern: 'gh-readonly-queue/next/pr-1-abc', admits: true },
    { pattern: 'gh-readonly-queue/next/pr-1', admits: false },
    // A literal dot must not read as "any character".
    { pattern: 'gh-readonly-queue/next/pr-1.abc', admits: false },
  ];
  for (const { pattern, admits } of cases) {
    assert.equal(
      branchPatternToRegExp(pattern).test(QUEUE_REF_SAMPLE),
      admits,
      `${pattern}: expected admits=${admits} against ${QUEUE_REF_SAMPLE}`,
    );
    assert.equal(admitsQueueBranch([pattern]), admits, `${pattern}: admitsQueueBranch disagrees with the pattern`);
  }
  // A list admits when any positive entry does; a negation is skipped, never
  // subtracted, so it can only ever leave the answer more conservative.
  assert.equal(admitsQueueBranch(['next', 'release/*']), false);
  assert.equal(admitsQueueBranch(['next', '**/*']), true);
  assert.equal(admitsQueueBranch(['!gh-readonly-queue/**']), false);
  assert.equal(admitsQueueBranch(['**', '!gh-readonly-queue/**']), true);
  // An absent or empty filter is unfiltered, which admits everything.
  assert.equal(admitsQueueBranch(null), true);
  assert.equal(admitsQueueBranch([]), true);
});

test('branch-protection-audit.mjs requires no context outside the set', async () => {
  // Single source of truth, asserted from the outside. The flip PR reworks the
  // audit to derive its list from `requiredContexts()` outright; until then this
  // holds the weaker invariant that keeps the two from contradicting each other
  // — the audit may lag the set, but must never demand a context the set does
  // not define, which would be a required context no workflow here is pinned to
  // report.
  const { REQUIRED_CONTEXTS } = await import('./branch-protection-audit.mjs');
  assert.ok(Array.isArray(REQUIRED_CONTEXTS), 'branch-protection-audit.mjs must export a REQUIRED_CONTEXTS array');
  assert.notEqual(REQUIRED_CONTEXTS.length, 0, 'branch-protection-audit.mjs must audit at least one context');
  const defined = new Set(requiredContexts());
  for (const context of REQUIRED_CONTEXTS) {
    assert.ok(
      defined.has(context),
      `branch-protection-audit.mjs audits ${context}, which the required-check set does not define; add it to required-check-set.mjs or drop it from the audit`,
    );
  }
});

test('the operator-surface selection jobs override the workflow-level working directory', () => {
  for (const workflow of ['ci.yml', 'jinn-agent-ci.yml']) {
    const workflowDefault = sourceOf(workflow)
      .match(/^defaults:\n {2}run:\n {4}working-directory:[ \t]+(?<dir>.+?)[ \t]*$/mu);
    assert.notEqual(workflowDefault, null, `${workflow}: expected a workflow-level working-directory default`);
    assert.notEqual(workflowDefault.groups.dir, '.', `${workflow}: the workflow-level default is already '.'; this guard is pointless`);
    const gate = REQUIRED_CHECK_SET.find((member) => member.workflow === workflow && member.kind === 'job');
    assert.notEqual(gate, undefined, `${workflow}: produces no required job context`);
    const jobs = jobBlocks(workflow);
    for (const jobId of ['changes', gate.context]) {
      const job = jobs.find((entry) => entry.id === jobId);
      assert.notEqual(job, undefined, `${workflow}: no job ${jobId}`);
      assert.match(
        job.block,
        /^ {4}defaults:\n {6}run:\n(?: {8}#.*\n)* {8}working-directory: \.[ \t]*$/mu,
        `${workflow}: job ${jobId} must override the workflow-level working-directory with '.'; it runs git or nothing at all, and the inherited subdirectory either does not exist or misdirects the diff`,
      );
    }
  }
});
