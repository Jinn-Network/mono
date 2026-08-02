import assert from 'node:assert/strict';
import { test } from 'node:test';

const implementation = import('./branch-protection-audit.mjs');
const BRANCHES = ['integration/evidence-v1', 'next', 'main'];

function protection() {
  return {
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      require_code_owner_reviews: true,
      dismiss_stale_reviews: true,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    required_status_checks: {
      strict: true,
      contexts: ['platform-architecture-control', 'platform-verification', 'extra-check'],
      checks: [],
    },
    allow_force_pushes: { enabled: false },
    enforce_admins: { enabled: true },
  };
}

function fixtureRequest({ mutateBranch, collaboratorStatus = 200, permission = 'write' } = {}) {
  const calls = [];
  const request = async (method, path) => {
    calls.push({ method, path });
    if (path.startsWith('/users/')) return { status: 200, data: { login: path.split('/').at(-1) } };
    if (path.includes('/collaborators/')) return { status: collaboratorStatus, data: { permission } };
    const branch = decodeURIComponent(path.split('/').at(-2));
    const data = protection();
    mutateBranch?.(branch, data);
    return { status: 200, data };
  };
  return { calls, request };
}

test('audits all protected branches and both required usernames using GET only', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const fixture = fixtureRequest();
  const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
  assert.deepEqual(report.branches.map((entry) => entry.branch), BRANCHES);
  assert.deepEqual(report.owners.map((entry) => entry.username), ['oaksprout', 'ritsukai']);
  assert.ok(fixture.calls.every((call) => call.method === 'GET'));
  assert.equal('generatedAt' in report, false);
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

test('rejects every branch-protection drift variant', async (t) => {
  const { auditRepositoryArchitecture } = await implementation;
  const cases = [
    ['approval count', (p) => { p.required_pull_request_reviews.required_approving_review_count = 0; }],
    ['code owners', (p) => { p.required_pull_request_reviews.require_code_owner_reviews = false; }],
    ['stale dismissal', (p) => { p.required_pull_request_reviews.dismiss_stale_reviews = false; }],
    ['architecture context', (p) => { p.required_status_checks.contexts = ['platform-verification']; }],
    ['verification context', (p) => { p.required_status_checks.contexts = ['platform-architecture-control']; }],
    ['force push', (p) => { p.allow_force_pushes.enabled = true; }],
    ['admin enforcement', (p) => { p.enforce_admins.enabled = false; }],
    ['user bypass', (p) => { p.required_pull_request_reviews.bypass_pull_request_allowances.users = [{ login: 'x' }]; }],
    ['team bypass', (p) => { p.required_pull_request_reviews.bypass_pull_request_allowances.teams = [{ slug: 'x' }]; }],
    ['app bypass', (p) => { p.required_pull_request_reviews.bypass_pull_request_allowances.apps = [{ slug: 'x' }]; }],
    ['malformed bypass', (p) => { p.required_pull_request_reviews.bypass_pull_request_allowances = 'invalid'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = fixtureRequest({ mutateBranch: (branch, value) => { if (branch === 'next') mutate(value); } });
      await assert.rejects(
        auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request }),
        /next/u,
      );
    });
  }
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
    const report = await auditRepositoryArchitecture({ repository: 'Jinn-Network/mono', request: fixture.request });
    assert.ok(report.owners.every((owner) => owner.collaborator === 'visibility-unavailable'));
  });
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
  await assert.rejects(request('POST', '/repos/Jinn-Network/mono/branches/main/protection'), /GET/u);
  assert.equal(called, false);
});

test('drift errors carry deterministic machine-readable evidence for every branch', async () => {
  const { auditRepositoryArchitecture } = await implementation;
  const run = async () => {
    const fixture = fixtureRequest({
      mutateBranch: (branch, value) => {
        if (branch === 'next') value.allow_force_pushes.enabled = true;
      },
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
  assert.equal('generatedAt' in first, false);
});
