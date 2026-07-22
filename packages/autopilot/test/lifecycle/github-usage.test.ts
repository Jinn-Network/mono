import { describe, expect, it } from 'vitest';
import {
  FULL_SCAN_RESERVE,
  GitHubUsageMeter,
  TARGETED_PR_RESERVE,
  assertRateLimitReserve,
  makeGitHubUsageCommandRunner,
} from '../../src/lifecycle/github-usage.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

describe('GitHubUsageMeter', () => {
  it('aggregates GraphQL cost and remaining plus REST, 304, and cache-hit counts', () => {
    const meter = new GitHubUsageMeter();

    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 7,
          remaining: 4_993,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 11,
          remaining: 4_982,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordRestRequest(200);
    meter.recordRestRequest(304);
    meter.recordCacheHit();

    expect(meter.read()).toEqual({
      graphqlRequests: 2,
      graphqlCost: 18,
      graphqlRemaining: 4_982,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
      restRequests: 2,
      restNotModified: 1,
      cacheHits: 1,
    });
  });

  it('fails closed without mutating usage when GraphQL rate-limit evidence is incomplete', () => {
    const meter = new GitHubUsageMeter();

    expect(() => meter.recordGraphQlResponse({ data: { rateLimit: { remaining: 42 } } }))
      .toThrow(/rateLimit|cost|resetAt/i);
    expect(meter.read()).toMatchObject({ graphqlRequests: 0, graphqlCost: 0 });
  });

  it('keeps remaining and resetAt paired to the newest quota window', () => {
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 3,
          remaining: 2,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 4_999,
          resetAt: '2026-07-22T14:00:00.000Z',
        },
      },
    });
    // A late response from the old window must not re-pair its low balance
    // with the newer window's reset timestamp.
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 2,
          remaining: 1,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });

    expect(meter.read()).toMatchObject({
      graphqlRequests: 3,
      graphqlCost: 6,
      graphqlRemaining: 4_999,
      graphqlResetAt: '2026-07-22T14:00:00.000Z',
    });
  });

  it('reconciles opaque gh GraphQL usage with credential-preserving probes', async () => {
    const calls: Array<{
      readonly args: readonly string[];
      readonly token: string | undefined;
    }> = [];
    let probe = 0;
    const raw: CommandRunner = async (_command, args, options) => {
      calls.push({ args, token: options?.env?.GH_TOKEN });
      if (args[0] !== 'api' || args[1] !== 'graphql') return 'edited';
      probe += 1;
      return JSON.stringify({
        data: {
          rateLimit: probe === 1
            ? {
                cost: 1,
                remaining: 998,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 2,
                limit: 1_000,
              }
            : {
                cost: 1,
                remaining: 990,
                resetAt: '2026-07-22T13:00:00.000Z',
                used: 10,
                limit: 1_000,
              },
        },
      });
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['project', 'item-edit'], {
      env: { GH_TOKEN: 'selected-token' },
    })).resolves.toBe('edited');

    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual([
      'api',
      'graphql',
      '-f',
      expect.stringContaining('rateLimit { cost remaining resetAt used limit }'),
    ]);
    expect(calls[1]?.args).toEqual(['project', 'item-edit']);
    expect(calls[2]?.args).toEqual(calls[0]?.args);
    expect(calls.map((call) => call.token)).toEqual([
      'selected-token',
      'selected-token',
      'selected-token',
    ]);
    expect(meter.read()).toMatchObject({
      graphqlRequests: 2,
      graphqlCost: 9,
      graphqlRemaining: 990,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
    });
  });

  it('fails before an opaque command when its opening probe evidence is malformed', async () => {
    let opaqueExecuted = false;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] === 'api' && args[1] === 'graphql') {
        return JSON.stringify({ data: { rateLimit: { remaining: 999 } } });
      }
      opaqueExecuted = true;
      return 'edited';
    };
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await expect(run('gh', ['project', 'item-edit'])).rejects.toThrow(/rateLimit|cost/i);
    expect(opaqueExecuted).toBe(false);
    expect(() => meter.read()).toThrow(/incomplete/i);
  });

  it('does not start an opaque mutation span below floor plus its modeled reserve', async () => {
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 509,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    let called = false;
    const run = makeGitHubUsageCommandRunner(async () => {
      called = true;
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(called).toBe(false);
  });

  it('uses the fresh opening probe to enforce the opaque reserve with no prior evidence', async () => {
    const calls: string[] = [];
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      if (args[0] === 'api') {
        calls.push('opening-probe');
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 509,
              resetAt: '2026-07-22T13:00:00.000Z',
              used: 491,
              limit: 1_000,
            },
          },
        });
      }
      calls.push('opaque-mutation');
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(calls).toEqual(['opening-probe']);
    expect(meter.read()).toMatchObject({
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 509,
    });
  });

  it('uses the fresh opening probe when quota drifted below the prior metered balance', async () => {
    const calls: string[] = [];
    const meter = new GitHubUsageMeter();
    meter.recordGraphQlResponse({
      data: {
        rateLimit: {
          cost: 1,
          remaining: 700,
          resetAt: '2026-07-22T13:00:00.000Z',
        },
      },
    });
    const run = makeGitHubUsageCommandRunner(async (_command, args) => {
      if (args[0] === 'api') {
        calls.push('opening-probe');
        return JSON.stringify({
          data: {
            rateLimit: {
              cost: 1,
              remaining: 509,
              resetAt: '2026-07-22T13:00:00.000Z',
              used: 491,
              limit: 1_000,
            },
          },
        });
      }
      calls.push('opaque-mutation');
      return 'unexpected';
    }, meter, { rateLimitFloor: 500 });

    await expect(run('gh', ['project', 'item-edit']))
      .rejects.toThrow(/510|reserve|rate-limit/i);
    expect(calls).toEqual(['opening-probe']);
    expect(meter.read().graphqlRemaining).toBe(509);
  });

  it('publishes the minimum remaining quota paired to its credential window', async () => {
    const raw: CommandRunner = async (_command, _args, options) => JSON.stringify({
      data: {
        rateLimit: options?.env?.GH_TOKEN === 'implementer-secret'
          ? {
              cost: 3,
              remaining: 501,
              resetAt: '2026-07-22T13:00:00.000Z',
            }
          : {
              cost: 2,
              remaining: 4_999,
              resetAt: '2026-07-22T14:00:00.000Z',
            },
      },
    });
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(raw, meter);

    await run('gh', ['api', 'graphql'], { env: { GH_TOKEN: 'implementer-secret' } });
    await run('gh', ['api', 'graphql'], { env: { GH_TOKEN: 'reviewer-secret' } });

    expect(meter.read()).toMatchObject({
      graphqlCost: 5,
      graphqlRemaining: 501,
      graphqlResetAt: '2026-07-22T13:00:00.000Z',
    });
    expect(JSON.stringify(meter.read())).not.toMatch(/implementer-secret|reviewer-secret/);
  });

  it('serializes concurrent opaque commands into disjoint probe intervals', async () => {
    const ledger: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const probes = [
      { cost: 1, remaining: 999, used: 1 },
      { cost: 1, remaining: 993, used: 7 },
      { cost: 1, remaining: 992, used: 8 },
      { cost: 1, remaining: 988, used: 12 },
    ];
    let probeIndex = 0;
    const raw: CommandRunner = async (_command, args) => {
      if (args[0] === 'api') {
        ledger.push(`probe-${probeIndex + 1}`);
        const evidence = probes[probeIndex++]!;
        return JSON.stringify({
          data: {
            rateLimit: {
              ...evidence,
              resetAt: '2026-07-22T13:00:00.000Z',
              limit: 1_000,
            },
          },
        });
      }
      const name = args[2]!;
      ledger.push(`command-${name}`);
      if (name === 'first') {
        markFirstStarted();
        await firstBlocked;
      }
      return name;
    };
    const run = makeGitHubUsageCommandRunner(raw, new GitHubUsageMeter());

    const first = run('gh', ['project', 'item-edit', 'first']);
    await firstStarted;
    const second = run('gh', ['project', 'item-edit', 'second']);
    await Promise.resolve();
    await Promise.resolve();

    expect(ledger).toEqual(['probe-1', 'command-first']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(ledger).toEqual([
      'probe-1',
      'command-first',
      'probe-2',
      'probe-3',
      'command-second',
      'probe-4',
    ]);
  });

  it('fails closed instead of counting hidden REST pagination as one request', async () => {
    let called = false;
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => {
      called = true;
      return '[]';
    }, meter);

    await expect(run('gh', [
      'api',
      'repos/Jinn-Network/mono/issues/42/comments',
      '--paginate',
    ])).rejects.toThrow(/pagination|page count/i);
    expect(called).toBe(false);
    expect(() => meter.read()).toThrow(/incomplete/i);
  });

  it('records the HTTP status exposed by an included REST response', async () => {
    const meter = new GitHubUsageMeter();
    const run = makeGitHubUsageCommandRunner(async () => [
      'HTTP/2.0 304 Not Modified',
      'etag: "cached"',
      '',
      '',
    ].join('\r\n'), meter);

    await run('gh', ['api', '--include', 'repos/Jinn-Network/mono/issues']);

    expect(meter.read()).toMatchObject({
      restRequests: 1,
      restNotModified: 1,
    });
  });

  it('records a thrown included 304 from error stdout exactly once and rethrows it', async () => {
    const meter = new GitHubUsageMeter();
    const failure = Object.assign(new Error('Command failed: gh api --include'), {
      stdout: [
        'HTTP/2.0 304 Not Modified',
        'etag: "cached"',
        '',
        '',
      ].join('\r\n'),
      stderr: 'gh: HTTP 304',
      code: 1,
    });
    const run = makeGitHubUsageCommandRunner(async () => {
      throw failure;
    }, meter);

    await expect(run('gh', ['api', '--include', 'repos/Jinn-Network/mono/issues']))
      .rejects.toBe(failure);
    expect(meter.read()).toMatchObject({
      restRequests: 1,
      restNotModified: 1,
      cacheHits: 0,
    });
  });
});

describe('GitHub quota reserves', () => {
  it('pins the full-scan and targeted-PR reserves', () => {
    expect(FULL_SCAN_RESERVE).toBe(450);
    expect(TARGETED_PR_RESERVE).toBe(10);
  });

  it('allows the exact reserve boundary and rejects one point below it', () => {
    expect(() => assertRateLimitReserve(950, FULL_SCAN_RESERVE)).not.toThrow();
    expect(() => assertRateLimitReserve(949, FULL_SCAN_RESERVE)).toThrow(/950/);
    expect(() => assertRateLimitReserve(510, TARGETED_PR_RESERVE)).not.toThrow();
    expect(() => assertRateLimitReserve(509, TARGETED_PR_RESERVE)).toThrow(/510/);
  });

  it('retains the absolute 500-point floor even when callers request a lower floor', () => {
    expect(() => assertRateLimitReserve(949, FULL_SCAN_RESERVE, 100)).toThrow(/950/);
  });
});
