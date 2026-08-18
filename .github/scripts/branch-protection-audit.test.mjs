import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { requiredContexts } from './required-check-set.mjs';

const implementation = import('./branch-protection-audit.mjs');
const BRANCHES = ['next', 'main'];

// Which ref patterns a branch is matched by, mirroring the conditions the flip
// script writes. `next` is also the repository default branch, so it is reached
// through `~DEFAULT_BRANCH` as well as its literal ref.
const BRANCH_PATTERNS = {
  next: ['refs/heads/next', '~DEFAULT_BRANCH'],
  main: ['refs/heads/main'],
};

// The three fixture rulesets are the post-flip end state: a queue-era `next`
// ruleset with no bypass, a `main`-only ruleset that keeps the admin bypass
// promote-main.yml pushes through, and the dedicated guard that stops anyone
// but the queue creating `gh-readonly-queue/**` refs.
function rulesets() {
  return [
    {
      id: 100,
      name: 'Next',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/next', '~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: requiredContexts().map((context) => ({ context })),
          },
        },
        {
          type: 'merge_queue',
          parameters: {
            check_response_timeout_minutes: 180,
            grouping_strategy: 'ALLGREEN',
            max_entries_to_build: 2,
            max_entries_to_merge: 1,
            merge_method: 'MERGE',
            min_entries_to_merge: 1,
            min_entries_to_merge_wait_minutes: 5,
          },
        },
      ],
    },
    {
      id: 200,
      name: 'Base',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: false,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: 'Main base guard' }],
          },
        },
      ],
    },
    {
      id: 300,
      name: 'gh-readonly-queue guard',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [{ actor_id: 1, actor_type: 'Integration', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['refs/heads/gh-readonly-queue/**'], exclude: [] } },
      rules: [{ type: 'creation' }],
    },
  ];
}

// GitHub's effective-rules endpoint reports the rules that apply to a branch,
// each attributed to the ruleset supplying it. A `disabled` ruleset contributes
// nothing; an `evaluate` one still reports, which is why the audit checks
// enforcement separately rather than trusting presence.
function effectiveRules(all, branch) {
  const patterns = BRANCH_PATTERNS[branch] ?? [];
  return all
    .filter((ruleset) => ruleset.enforcement !== 'disabled')
    .filter((ruleset) => ruleset.conditions.ref_name.include.some((pattern) => patterns.includes(pattern)))
    .flatMap((ruleset) => ruleset.rules.map((entry) => ({
      ...entry,
      ruleset_source_type: 'Repository',
      ruleset_source: 'Jinn-Network/mono',
      ruleset_id: ruleset.id,
    })));
}

function fixtureRequest({ mutate, collaboratorStatus = 200, permission = 'write' } = {}) {
  const all = rulesets();
  mutate?.({
    all,
    next: all.find((ruleset) => ruleset.id === 100),
    main: all.find((ruleset) => ruleset.id === 200),
    guard: all.find((ruleset) => ruleset.id === 300),
  });
  const calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (path.startsWith('/users/')) return { status: 200, data: { login: path.split('/').at(-1) } };
    if (path.includes('/collaborators/')) return { status: collaboratorStatus, data: { permission } };
    if (path.endsWith('/rulesets')) return { status: 200, data: all.map(({ id, name }) => ({ id, name })) };
    const detail = /\/rulesets\/(?<id>\d+)$/u.exec(path);
    if (detail) {
      const ruleset = all.find((entry) => entry.id === Number(detail.groups.id));
      return ruleset ? { status: 200, data: ruleset } : { status: 404, data: {} };
    }
    const branch = /\/rules\/branches\/(?<branch>.+)$/u.exec(path);
    if (branch) return { status: 200, data: effectiveRules(all, decodeURIComponent(branch.groups.branch)) };
    return { status: 404, data: {} };
  };
  return { all, calls, request };
}

function rule(ruleset, type) {
  return ruleset.rules.find((entry) => entry.type === type);
}

function dropRule(ruleset, type) {
  ruleset.rules = ruleset.rules.filter((entry) => entry.type !== type);
}

test('audits both protected branches and both required usernames using GET only', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const fixture = fixtureRequest();
  const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
  assert.deepEqual(report.branches.map((entry) => entry.branch), BRANCHES);
  assert.deepEqual(report.owners.map((entry) => entry.username), ['oaksprout', 'ritsukai']);
  assert.ok(fixture.calls.every((call) => call.method === 'GET'));
  assert.equal('generatedAt' in report, false);
  assert.ok(report.branches.every((entry) => entry.compliant));
});

test('reads rulesets, never classic branch protection', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const fixture = fixtureRequest();
  await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
  const paths = fixture.calls.map((call) => call.path);
  assert.ok(!paths.some((path) => path.endsWith('/protection')), 'classic protection endpoint must not be read');
  assert.ok(paths.includes('/repos/Jinn-Network/mono/rulesets'));
  assert.ok(paths.includes('/repos/Jinn-Network/mono/rulesets/100'));
  for (const branch of BRANCHES) {
    assert.ok(paths.includes(`/repos/Jinn-Network/mono/rules/branches/${branch}`));
  }
});

test('the required contexts come from the required-check set, not a local restatement', async () => {
  const { auditRepositoryArchitecture, REQUIRED_CONTEXTS } = await implementation;
  assert.deepEqual([...REQUIRED_CONTEXTS], requiredContexts());
  const fixture = fixtureRequest();
  const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
  assert.deepEqual([...report.requiredContexts], requiredContexts());
});

test('rejects a valid-format repository other than the pinned architecture repository', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const fixture = fixtureRequest();
  await assert.rejects(
    auditRepositoryArchitecture({ repository: 'attacker/mono', request: fixture.request }),
    /exactly Jinn-Network\/mono/u,
  );
  assert.equal(fixture.calls.length, 0);
});

test('requires the resolved GitHub login to remain the current handle case-insensitively', async (t) => {
  const { auditRepositoryArchitecture } = await implementation;
  await t.test('accepts GitHub case normalization', async () => {
    const fixture = fixtureRequest();
    const request = async (method, path) => (
      path === '/users/oaksprout' ? { status: 200, data: { login: 'OakSprout' } } : fixture.request(method, path)
    );
    const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request });
    assert.equal(report.owners[0].resolved, true);
  });
  for (const [name, data] of [
    ['renamed', { login: 'renamed-user' }],
    ['malformed', {}],
  ]) {
    await t.test(`rejects ${name} response`, async () => {
      const fixture = fixtureRequest();
      const request = async (method, path) => (
        path === '/users/oaksprout' ? { status: 200, data } : fixture.request(method, path)
      );
      await assert.rejects(
        auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request }),
        /resolved GitHub login/u,
      );
    });
  }
});

test('rejects every queue-era ruleset drift variant', async (t) => {
  const { auditRepositoryArchitecture } = await implementation;
  const cases = [
    // `next` — the queue branch's posture (DR-2026-08-18-b D2/D5).
    ['missing merge_queue rule', ({ next }) => dropRule(next, 'merge_queue'), /next: no ruleset in effect supplies a merge_queue rule/u],
    ['wrong max_entries_to_merge', ({ next }) => { rule(next, 'merge_queue').parameters.max_entries_to_merge = 5; }, /next: merge_queue max_entries_to_merge is 5/u],
    ['wrong min_entries_to_merge', ({ next }) => { rule(next, 'merge_queue').parameters.min_entries_to_merge = 2; }, /next: merge_queue min_entries_to_merge is 2/u],
    ['wrong max_entries_to_build', ({ next }) => { rule(next, 'merge_queue').parameters.max_entries_to_build = 5; }, /next: merge_queue max_entries_to_build is 5/u],
    ['wrong grouping strategy', ({ next }) => { rule(next, 'merge_queue').parameters.grouping_strategy = 'HEADGREEN'; }, /next: merge_queue grouping_strategy is HEADGREEN/u],
    ['wrong merge method', ({ next }) => { rule(next, 'merge_queue').parameters.merge_method = 'SQUASH'; }, /next: merge_queue merge_method is SQUASH/u],
    ['wrong check-response timeout', ({ next }) => { rule(next, 'merge_queue').parameters.check_response_timeout_minutes = 60; }, /next: merge_queue check_response_timeout_minutes is 60/u],
    ['missing required context', ({ next }) => {
      const parameters = rule(next, 'required_status_checks').parameters;
      parameters.required_status_checks = parameters.required_status_checks
        .filter((check) => check.context !== 'hermetic-gate');
    }, /next: required status contexts missing: hermetic-gate/u],
    ['missing required_status_checks rule', ({ next }) => dropRule(next, 'required_status_checks'), /next: no ruleset in effect supplies a required_status_checks rule/u],
    ['dismiss-stale false', ({ next }) => { rule(next, 'pull_request').parameters.dismiss_stale_reviews_on_push = false; }, /next: pull_request does not dismiss stale reviews on push/u],
    ['code-owner review off', ({ next }) => { rule(next, 'pull_request').parameters.require_code_owner_review = false; }, /next: pull_request does not require code-owner review/u],
    ['zero approvals', ({ next }) => { rule(next, 'pull_request').parameters.required_approving_review_count = 0; }, /next: pull_request requires 0 approving reviews/u],
    ['missing pull_request rule', ({ next }) => dropRule(next, 'pull_request'), /next: no ruleset in effect supplies a pull_request rule/u],
    ['missing deletion rule', ({ next }) => dropRule(next, 'deletion'), /next: no ruleset in effect supplies a deletion rule/u],
    ['missing non_fast_forward rule', ({ next }) => dropRule(next, 'non_fast_forward'), /next: no ruleset in effect supplies a non_fast_forward rule/u],
    ['non-empty bypass on next', ({ next }) => { next.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; }, /next: ruleset 100 \(Next\) carries 1 bypass actor\(s\)/u],
    ['next ruleset only evaluated', ({ next }) => { next.enforcement = 'evaluate'; }, /next: ruleset 100 \(Next\) enforcement is evaluate, not active/u],
    // `main` — the retained posture, including the bypass promote-main.yml needs.
    ['missing admin bypass on main', ({ main }) => { main.bypass_actors = []; }, /main: ruleset 200 \(Base\) has lost the admin bypass actor/u],
    ['admin bypass downgraded to pull_request mode', ({ main }) => { main.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]; }, /main: ruleset 200 \(Base\) has lost the admin bypass actor/u],
    ['missing Main base guard context', ({ main }) => { rule(main, 'required_status_checks').parameters.required_status_checks = []; }, /main: required status contexts missing: Main base guard/u],
    ['main loses its required_status_checks rule', ({ main }) => dropRule(main, 'required_status_checks'), /main: no ruleset in effect supplies a required_status_checks rule/u],
    ['main loses code-owner review', ({ main }) => { rule(main, 'pull_request').parameters.require_code_owner_review = false; }, /main: pull_request does not require code-owner review/u],
    ['main loses non_fast_forward', ({ main }) => dropRule(main, 'non_fast_forward'), /main: no ruleset in effect supplies a non_fast_forward rule/u],
    // Repository-wide: the forgeable queue-ref hazard.
    ['missing gh-readonly-queue restriction', ({ all, guard }) => { all.splice(all.indexOf(guard), 1); }, /no active ruleset restricts creation of refs\/heads\/gh-readonly-queue/u],
    ['gh-readonly-queue guard without a creation rule', ({ guard }) => dropRule(guard, 'creation'), /no active ruleset restricts creation of refs\/heads\/gh-readonly-queue/u],
    ['gh-readonly-queue guard disabled', ({ guard }) => { guard.enforcement = 'disabled'; }, /no active ruleset restricts creation of refs\/heads\/gh-readonly-queue/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async () => {
      const fixture = fixtureRequest({ mutate });
      await assert.rejects(
        auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request }),
        pattern,
      );
    });
  }
});

test('an unreadable ruleset detail fails loudly rather than passing the bypass check vacuously', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const fixture = fixtureRequest();
  const request = async (method, path) => (
    path.endsWith('/rulesets/100') ? { status: 404, data: {} } : fixture.request(method, path)
  );
  await assert.rejects(
    auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request }),
    (error) => {
      // Every branch is still audited and reported even though the ruleset read
      // failed, so the uploaded evidence never silently loses a branch.
      assert.deepEqual(error.report.branches.map((entry) => entry.branch), BRANCHES);
      assert.match(error.message, /next: ruleset 100 supplies rules but could not be read/u);
      return /ruleset 100: GitHub GET returned 404/u.test(error.message);
    },
  );
});

test('fails on unresolved usernames and visible non-collaborators, but records inaccessible visibility', async (t) => {
  const { auditRepositoryArchitecture } = await implementation;
  await t.test('unresolved username', async () => {
    const fixture = fixtureRequest();
    const request = async (method, path) => (
      path === '/users/oaksprout' ? { status: 404, data: {} } : fixture.request(method, path)
    );
    await assert.rejects(auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request }), /username oaksprout/u);
  });
  await t.test('visible non-collaborator', async () => {
    const fixture = fixtureRequest({ collaboratorStatus: 404 });
    await assert.rejects(auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request }), /collaborator/u);
  });
  await t.test('visibility inaccessible', async () => {
    const fixture = fixtureRequest({ collaboratorStatus: 403 });
    await assert.rejects(
      auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request }),
      (error) => {
        assert.ok(error.report.owners.every((owner) => owner.collaborator === 'visibility-unavailable'));
        assert.deepEqual(error.report.branches.map((entry) => entry.branch), BRANCHES);
        return /visibility unavailable/u.test(error.message);
      },
    );
  });
});

test('CLI audit runner preserves visibility-unavailable JSON and summary before failing', async () => {
  const { runArchitectureAudit } = await implementation;
  const root = mkdtempSync(join(tmpdir(), 'jinn-architecture-audit-'));
  try {
    const fixture = fixtureRequest({ collaboratorStatus: 403 });
    const out = join(root, 'audit.json');
    const summary = join(root, 'summary.md');
    await assert.rejects(
      runArchitectureAudit({
        repository: 'Jinn-Network/mono',
        request: fixture.request,
        out,
        summary,
      }),
      /visibility unavailable/u,
    );
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(report.owners.every((owner) => owner.collaborator === 'visibility-unavailable'));
    assert.deepEqual(report.branches.map((entry) => entry.branch), BRANCHES);
    const rendered = readFileSync(summary, 'utf8');
    assert.match(rendered, /visibility-unavailable/u);
    // The per-branch table renders the ruleset-era facts, not the classic ones.
    assert.match(rendered, /\| next \| 100 Next \| 1 \| required \| yes \| 10 \| MERGE ALLGREEN merge 1\/1 build 2 180m \| 0 \|/u);
    assert.match(rendered, /\| main \| 200 Base \| 1 \| required \| no \| 1 \| absent \| 1 \|/u);
    assert.match(rendered, /Queue-ref creation guard `refs\/heads\/gh-readonly-queue\/\*\*`: 300 gh-readonly-queue guard/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('visible collaborators require write-capable permission', async (t) => {
  const { auditRepositoryArchitecture } = await implementation;
  for (const permission of ['write', 'maintain', 'admin']) {
    await t.test(`accepts ${permission}`, async () => {
      const fixture = fixtureRequest({ permission });
      const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
      assert.ok(report.owners.every((owner) => owner.permission === permission));
    });
  }
  for (const permission of ['read', 'triage', '', 'unknown']) {
    await t.test(`rejects ${permission || 'missing'}`, async () => {
      const fixture = fixtureRequest({ permission });
      await assert.rejects(
        auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request }),
        /write-capable collaborator/u,
      );
    });
  }
});

test('request adapter rejects non-GET methods before issuing HTTP', async () => {
  const { createReadOnlyRequest } = await implementation;
  let called = false;
  const request = createReadOnlyRequest({
    token: 'fixture',
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  await assert.rejects(request('PUT', '/repos/Jinn-Network/mono/rulesets/100'), /GET/u);
  assert.equal(called, false);
});

test('drift errors carry deterministic machine-readable evidence for every branch', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const run = async () => {
    const fixture = fixtureRequest({
      mutate: ({ next }) => { rule(next, 'merge_queue').parameters.max_entries_to_merge = 5; },
    });
    try {
      await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
      assert.fail('expected drift');
    } catch (error) {
      return error.report;
    }
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(first, second);
  assert.deepEqual(first.branches.map((entry) => entry.branch), BRANCHES);
  assert.equal(first.branches.find((entry) => entry.branch === 'next').compliant, false);
  assert.equal(first.branches.find((entry) => entry.branch === 'main').compliant, true);
  assert.equal('generatedAt' in first, false);
});
