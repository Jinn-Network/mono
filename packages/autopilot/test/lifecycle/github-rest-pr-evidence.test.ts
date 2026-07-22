import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import { ConditionalRestClient } from '../../src/lifecycle/github-rest.js';
import {
  ConditionalPullRequestEvidenceProbe,
} from '../../src/lifecycle/github-rest-pr-evidence.js';
import type { PullRequestSnapshot } from '../../src/lifecycle/snapshot.js';
import { gitOid } from '../../src/lifecycle/types.js';
import { GitHubUsageMeter } from '../../src/lifecycle/github-usage.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function pr(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 101,
    title: 'feat: conditional evidence',
    body: 'Closes #42',
    author: 'oaksprout',
    baseRefName: 'next',
    headRefName: 'autopilot/42',
    headOid: gitOid(HEAD),
    headCommittedAt: '2026-07-22T09:00:00.000Z',
    isDraft: false,
    state: 'OPEN',
    labels: ['engine:review'],
    closingIssueNumbers: [42],
    mergeability: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    reviews: [],
    ...overrides,
  };
}

interface Response {
  readonly status: 200 | 304;
  readonly body?: unknown;
  readonly etag?: string;
  readonly link?: string;
}

function included(response: Response): string {
  const body = response.status === 200 ? JSON.stringify(response.body) : '';
  return [
    `HTTP/2.0 ${response.status} ${response.status === 200 ? 'OK' : 'Not Modified'}`,
    `etag: ${response.etag ?? '"same"'}`,
    'x-ratelimit-remaining: 4998',
    'x-ratelimit-used: 2',
    'x-ratelimit-reset: 1784725200',
    'x-ratelimit-resource: core',
    ...(response.status === 200 ? ['content-type: application/json'] : []),
    ...(response.link === undefined ? [] : [`link: ${response.link}`]),
    '',
    body,
  ].join('\r\n');
}

function equalBodies(): Record<string, unknown> {
  return {
    detail: {
      number: 101,
      title: 'feat: conditional evidence',
      body: 'Closes #42',
      state: 'open',
      draft: false,
      user: { login: 'oaksprout' },
      head: { ref: 'autopilot/42', sha: HEAD },
      base: { ref: 'next' },
      labels: [{ name: 'engine:review' }],
      mergeable: true,
      mergeable_state: 'clean',
      closed_at: null,
      merged_at: null,
    },
    reviews: [],
    comments: [],
    checks: {
      total_count: 1,
      check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    },
    statuses: {
      state: 'success',
      total_count: 0,
      statuses: [],
    },
  };
}

function probeWith(
  bodies: Record<string, unknown>,
  later304 = false,
): {
  readonly probe: ConditionalPullRequestEvidenceProbe;
  readonly meter: GitHubUsageMeter;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const seen = new Set<string>();
  const run: CommandRunner = async (_command, args) => {
    const endpoint = args[2]!;
    calls.push(endpoint);
    if (later304 && seen.has(endpoint)) return included({ status: 304 });
    seen.add(endpoint);
    const kind = endpoint === 'repos/Jinn-Network/mono/pulls/101'
      ? 'detail'
      : endpoint.includes('/reviews?')
      ? 'reviews'
      : endpoint.includes('/comments?')
        ? 'comments'
        : endpoint.includes('/check-runs?')
          ? 'checks'
          : 'statuses';
    return included({ status: 200, body: bodies[kind] });
  };
  const meter = new GitHubUsageMeter();
  return {
    probe: new ConditionalPullRequestEvidenceProbe(
      new ConditionalRestClient(run, { usageMeter: meter }),
    ),
    meter,
    calls,
  };
}

describe('ConditionalPullRequestEvidenceProbe', () => {
  it('normalizes a cold 200 against full evidence, then reuses all four ETags on 304', async () => {
    const context = probeWith(equalBodies(), true);

    await expect(context.probe.changed(pr())).resolves.toBe(false);
    await expect(context.probe.changed(pr())).resolves.toBe(false);

    expect(context.calls).toHaveLength(10);
    expect(context.meter.read()).toMatchObject({
      restRequests: 10,
      restNotModified: 5,
      cacheHits: 5,
    });
  });

  it('normalizes documented null PR body and user values to empty strings', async () => {
    const bodies = equalBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      body: null,
      user: null,
    };

    await expect(probeWith(bodies).probe.changed(pr({ body: '', author: '' })))
      .resolves.toBe(false);
  });

  it.each(['body', 'user'] as const)(
    'still fails closed when documented PR field %s is undefined',
    async (field) => {
      const bodies = equalBodies();
      const detail = { ...(bodies.detail as Record<string, unknown>) };
      delete detail[field];
      bodies.detail = detail;

      await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow(/body|user/i);
    },
  );

  it('detects a decisive review even when the PR index timestamp is unchanged', async () => {
    const bodies = equalBodies();
    bodies.reviews = [{
      user: { login: 'reviewer' },
      state: 'APPROVED',
      commit_id: HEAD,
      body: 'approved',
      submitted_at: '2026-07-22T10:01:00.000Z',
    }];

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it('detects a structured Human comment transition', async () => {
    const bodies = equalBodies();
    bodies.comments = [{
      body: '<!-- jinn-autopilot-human:v2 issue=42 pr=101 phase=reviewing code=review-escalation -->\n\nNeeds a product decision.',
      created_at: '2026-07-22T10:02:00.000Z',
    }];

    await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
  });

  it.each([
    ['check run', {
      checks: {
        total_count: 1,
        check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      },
    }],
    ['commit status', {
      checks: { total_count: 0, check_runs: [] },
      statuses: {
        state: 'failure',
        total_count: 1,
        statuses: [{ context: 'legacy-ci', state: 'failure' }],
      },
    }],
  ])('detects a %s transition without relying on pull_request.updated_at', async (_label, change) => {
    await expect(probeWith({ ...equalBodies(), ...change }).probe.changed(pr()))
      .resolves.toBe(true);
  });

  it.each([
    ['dirty', false, 'dirty'],
    ['behind', true, 'behind'],
  ] as const)(
    'detects an exact-detail mergeability transition to %s with unchanged head and updated_at',
    async (_label, mergeable, mergeableState) => {
      const bodies = equalBodies();
      bodies.detail = {
        ...(bodies.detail as Record<string, unknown>),
        mergeable,
        mergeable_state: mergeableState,
      };

      await expect(probeWith(bodies).probe.changed(pr())).resolves.toBe(true);
    },
  );

  it('fails closed when the exact PR detail identity or head does not match', async () => {
    const bodies = equalBodies();
    bodies.detail = {
      ...(bodies.detail as Record<string, unknown>),
      head: { ref: 'autopilot/42', sha: 'b'.repeat(40) },
    };

    await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow(/head|identity/i);
  });

  it.each([
    {
      label: 'unknown review state',
      bodies: {
        ...equalBodies(),
        reviews: [{
          user: { login: 'reviewer' },
          state: 'SURPRISE',
          commit_id: HEAD,
          body: '',
          submitted_at: '2026-07-22T10:01:00.000Z',
        }],
      },
    },
    { label: 'truncated comments', bodies: equalBodies(), truncated: 'comments' },
    {
      label: 'incomplete check count',
      bodies: {
        ...equalBodies(),
        checks: { total_count: 2, check_runs: [] },
      },
    },
  ] as Array<{
    label: string;
    bodies: Record<string, unknown>;
    truncated?: string;
  }>)('fails closed on $label', async ({ bodies, truncated }) => {
    if (truncated === undefined) {
      await expect(probeWith(bodies).probe.changed(pr())).rejects.toThrow();
      return;
    }
    const run: CommandRunner = async (_command, args) => {
      const endpoint = args[2]!;
      const body = endpoint === 'repos/Jinn-Network/mono/pulls/101'
        ? bodies.detail
        : endpoint.includes('/reviews?')
        ? bodies.reviews
        : endpoint.includes('/comments?')
          ? bodies.comments
          : endpoint.includes('/check-runs?')
            ? bodies.checks
            : bodies.statuses;
      return included({
        status: 200,
        body,
        ...(endpoint.includes(`/${truncated}?`)
          ? { link: `<https://api.github.com/${endpoint.replace('page=1', 'page=2')}>; rel="next"` }
          : {}),
      });
    };
    const probe = new ConditionalPullRequestEvidenceProbe(new ConditionalRestClient(run));
    await expect(probe.changed(pr())).rejects.toThrow(/truncated|pagination/i);
  });
});
