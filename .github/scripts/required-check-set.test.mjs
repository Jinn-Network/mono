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

function onBlock(file) {
  const body = sourceOf(file).match(/^on:\n(?<body>[\s\S]*?)(?=^\S)/mu)?.groups?.body;
  assert.notEqual(body, undefined, `${file}: has no top-level on: block`);
  return body;
}

function triggerBlock(file, trigger) {
  const on = onBlock(file);
  const head = on.match(new RegExp(`^ {2}${trigger}:[ \\t]*$`, 'mu'));
  if (!head) return null;
  const rest = on.slice(head.index + head[0].length + 1);
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

const QUEUE_REF_PREFIX = 'gh-readonly-queue';

function admitsQueueBranch(entries) {
  if (entries === null || entries.length === 0) return true;
  return entries.some((entry) => entry === '*'
    || entry === '**'
    || entry.startsWith(QUEUE_REF_PREFIX));
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
const gateMembers = REQUIRED_CHECK_SET.filter((member) => member.kind === 'job'
  && member.context.endsWith('-gate'));

test('the required-check set is a frozen, well-formed contract', () => {
  assert.ok(Object.isFrozen(REQUIRED_CHECK_SET), 'REQUIRED_CHECK_SET must be frozen');
  for (const member of REQUIRED_CHECK_SET) {
    assert.ok(Object.isFrozen(member), `${member.context}: each member must be frozen`);
    assert.deepEqual(Object.keys(member).sort(), ['context', 'kind', 'workflow']);
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
      continue;
    }
    assert.equal(
      reporters.length,
      0,
      `${member.context}: an API-posted check-run must not also be a job check name, found ${found}`,
    );
    const declarers = workflowFiles.filter((file) => sourceOf(file).includes(`"context": "${member.context}"`));
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

test('the check-run producer posts its context however the gate job ends', () => {
  for (const member of REQUIRED_CHECK_SET.filter((entry) => entry.kind === 'check-run')) {
    const jobs = jobBlocks(member.workflow);
    const posters = jobs.filter((job) => job.block.includes('post-check-run-verdict.mjs'));
    assert.equal(posters.length, 1, `${member.workflow}: exactly one job may post ${member.context}`);
    const [poster] = posters;
    assert.match(
      poster.block,
      /^ {4}if: always\(\)/mu,
      `${member.workflow}: ${poster.id} must run with if: always() so ${member.context} is reported even when the gate job is cancelled`,
    );
    const needs = parseNeeds(poster.block);
    const others = jobs.map((job) => job.id).filter((id) => id !== poster.id);
    assert.deepEqual(
      [...needs].sort(),
      [...others].sort(),
      `${member.workflow}: ${poster.id} must need every other job so ${member.context} covers the whole workflow`,
    );
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
          `${file}: the push trigger declares no branches: list, so it fires on every gh-readonly-queue/** ref the queue creates`,
        );
        assert.notEqual(entries.length, 0, `${file}: the push trigger's branches: list is empty`);
      }
      for (const entry of entries ?? []) {
        assert.ok(
          !entry.startsWith(QUEUE_REF_PREFIX),
          `${file}: the ${trigger} branches: entry ${entry} targets the merge-queue ref space`,
        );
        assert.ok(
          entry !== '*' && entry !== '**',
          `${file}: the ${trigger} branches: entry ${entry} is a bare wildcard and admits gh-readonly-queue/** refs`,
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
