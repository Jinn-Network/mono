import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  formatIssueRelayAdoptionReceiptComment,
  formatIssueRelayEvaluationAnchorComment,
  type IssueRelayAdoptionReceiptV1,
  type IssueRelayEvaluationAnchorV1,
  type IssueRelayRoundV1,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import {
  createIssueRelayGitHubRestReadPort,
  observeExactIssueRelayEvaluationReceipts,
  type IssueRelayGitHubComment,
  type IssueRelayGitHubCommentPage,
  type IssueRelayGitHubReadPort,
} from '../../src/issue-relay/github-receipt-observer.js';

const BOT = 'jinn-relay[bot]';
const issueNumber = 42;
const prNumber = 314;
const baseOid = '1'.repeat(40);
const head = '2'.repeat(40);
const snapshotDigest = `sha256:${'a'.repeat(64)}` as const;
const checksDigest = `sha256:${'b'.repeat(64)}` as const;
const solutionSafe = `0x${'1'.repeat(40)}`;

const round: IssueRelayRoundV1 = {
  schemaVersion: 'jinn-issue-relay-round.v1',
  generation: `R_kgDOExample:${issueNumber}:${snapshotDigest}`,
  round: 0,
  snapshotDigest,
  targetRepository: 'Jinn-Network/mono',
  workspaceRepository: 'Jinn-Network/mono',
  inputHead: baseOid,
  purpose: 'initial',
  findings: [],
};

const correlation = {
  generation: round.generation,
  round: round.round,
  snapshotDigest,
  taskId: '501',
  attemptIndex: 0,
  requestId: `0x${'3'.repeat(64)}`,
  deliveryEnvelopeCid: 'bafy-solution',
} as const;

const receipt: Extract<
  IssueRelayAdoptionReceiptV1,
  { disposition: 'accepted' }
> = {
  schemaVersion: 'jinn-issue-relay-adoption.v1',
  disposition: 'accepted',
  correlation,
  targetRepository: round.targetRepository,
  workspaceRepository: 'Jinn-Network/mono-relay',
  issueNumber,
  prNumber,
  headRef: 'jinn/issue-relay/example',
  inputHead: round.inputHead,
  resultingHead: head,
  patchDigest: `sha256:${'c'.repeat(64)}`,
  solutionSafe,
  adoptedAt: '2026-07-28T12:10:00.000Z',
};

function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(
        (value as Record<string, unknown>)[key],
      )}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const anchor: IssueRelayEvaluationAnchorV1 = {
  schemaVersion: 'jinn-issue-relay-evaluation-anchor.v1',
  correlation,
  targetRepository: round.targetRepository,
  workspaceRepository: receipt.workspaceRepository,
  prNumber,
  targetBase: 'main',
  baseOid,
  headRef: receipt.headRef,
  evaluatedHead: head,
  adoptionReceiptDigest: digest(receipt),
  checksDigest,
  anchoredAt: '2026-07-28T12:12:00.000Z',
};

function markerRound(
  adoption: Readonly<Record<string, unknown>> = {
    disposition: 'accepted',
    resultingHead: head,
    receiptDigest: anchor.adoptionReceiptDigest,
  },
) {
  return {
    round: 0,
    purpose: 'initial',
    workspaceRepository: round.workspaceRepository,
    inputHead: round.inputHead,
    task: {
      taskKey: `issue-relay:${round.generation}:round:0`,
      taskId: correlation.taskId,
      taskCid: 'bafy-task',
      spendWei: '1',
      fundedAt: '2026-07-28T12:05:00.000Z',
    },
    solution: {
      envelopeCid: correlation.deliveryEnvelopeCid,
      operatorSafe: solutionSafe,
      observedAt: '2026-07-28T12:08:00.000Z',
    },
    adoption,
    ...(adoption['disposition'] === 'accepted'
      ? {
          checks: {
            head,
            status: 'passed',
            digest: checksDigest,
          },
        }
      : {}),
  };
}

function generationMarker(overrides: Record<string, unknown> = {}): string {
  const marker = {
    schemaVersion: 'jinn-issue-relay-generation.v1',
    generation: round.generation,
    snapshot: {
      repository: {
        slug: round.targetRepository,
        nodeId: 'R_kgDOExample',
        visibility: 'PUBLIC',
        defaultBranch: 'main',
        baseOid,
      },
      issue: {
        number: issueNumber,
        url: `https://github.com/${round.targetRepository}/issues/${issueNumber}`,
        title: 'Evaluate the adopted Relay head',
        body: 'Review the complete cumulative change.',
        authorLogin: 'maintainer',
        authorId: 'U_kgDOMaintainer',
        updatedAt: '2026-07-28T12:00:00.000Z',
      },
      optIn: {
        label: 'engine:marketplace',
        actorLogin: 'maintainer',
        createdAt: '2026-07-28T12:01:00.000Z',
        permission: 'MAINTAIN',
      },
      language: 'typescript',
      verificationProfile: 'jinn-mono.v1',
      acceptanceEvidence: ['The exact adopted head is evaluated.'],
      admissionPolicyVersion: 'jinn-issue-relay-admission.v1',
      capturedAt: '2026-07-28T12:02:00.000Z',
      schemaVersion: 'jinn-issue-relay-snapshot.v1',
      snapshotDigest,
    },
    phase: 'evaluating',
    deadlineAt: '2026-07-29T12:02:00.000Z',
    rounds: [markerRound()],
    pr: {
      number: prNumber,
      branch: receipt.headRef,
      head,
      draft: true,
      targetRepository: round.targetRepository,
      targetRepositoryId: 'R_kgDOExample',
      forkRepository: receipt.workspaceRepository,
      forkRepositoryId: 'R_kgDORelayFork',
      forkParentRepositoryId: 'R_kgDOExample',
      visibility: 'PUBLIC',
      managedFork: true,
    },
    updatedAt: '2026-07-28T12:12:00.000Z',
    ...overrides,
  };
  return [
    '<!-- jinn-issue-relay:generation:v1 -->',
    '',
    '```json',
    JSON.stringify(marker),
    '```',
  ].join('\n');
}

function comment(
  id: number,
  body: string,
  authorLogin = BOT,
  updatedAt = '2026-07-28T12:12:00.000Z',
): IssueRelayGitHubComment {
  return {
    id,
    authorLogin,
    body,
    createdAt: '2026-07-28T12:12:00.000Z',
    updatedAt,
  };
}

function assuranceComment(...blocks: readonly string[]): string {
  return [
    '<!-- jinn-issue-relay:assurance:v1 -->',
    '',
    '# Relay assurance',
    '',
    ...blocks.flatMap((block) => [block, '']),
  ].join('\n');
}

function port(input: {
  issuePages?: Readonly<Record<string, IssueRelayGitHubCommentPage>>;
  prPages?: Readonly<Record<string, IssueRelayGitHubCommentPage>>;
  headSha?: string;
  workspaceRepository?: string;
} = {}): IssueRelayGitHubReadPort & {
  listIssueComments: ReturnType<typeof vi.fn>;
  listPullRequestComments: ReturnType<typeof vi.fn>;
} {
  const issuePages = input.issuePages ?? {
    first: { comments: [comment(1, generationMarker())] },
  };
  const prPages = input.prPages ?? {
    first: {
      comments: [
        comment(2, assuranceComment(
          formatIssueRelayAdoptionReceiptComment(receipt),
          formatIssueRelayEvaluationAnchorComment(anchor),
        )),
      ],
    },
  };
  return {
    listIssueComments: vi.fn(async ({ cursor }) =>
      issuePages[cursor ?? 'first'] ?? { comments: [] }),
    listPullRequestComments: vi.fn(async ({ cursor }) =>
      prPages[cursor ?? 'first'] ?? { comments: [] }),
    readPullRequest: vi.fn(async () => ({
      number: prNumber,
      targetRepository: round.targetRepository,
      workspaceRepository:
        input.workspaceRepository ?? receipt.workspaceRepository,
      targetBase: anchor.targetBase,
      baseOid,
      headRef: receipt.headRef,
      headSha: input.headSha ?? head,
      checks: {
        digest: checksDigest,
        required: [{
          name: 'relay/typecheck',
          status: 'passed' as const,
          url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
        }],
        optional: [],
      },
    })),
  };
}

function observe(github: IssueRelayGitHubReadPort, maxPages?: number) {
  return observeExactIssueRelayEvaluationReceipts({
    round,
    issueNumber,
    correlation,
    relayBotLogin: BOT,
    github,
    ...(maxPages === undefined ? {} : { maxPages }),
  });
}

describe('observeExactIssueRelayEvaluationReceipts', () => {
  it('consumes receipt and anchor evidence from the one composed assurance comment', async () => {
    const assurance = [
      '<!-- jinn-issue-relay:assurance:v1 -->',
      '',
      '# IN PROGRESS',
      '',
      '<details>',
      '<summary>Technical receipts and evidence</summary>',
      '',
      formatIssueRelayAdoptionReceiptComment(receipt),
      '',
      formatIssueRelayEvaluationAnchorComment(anchor),
      '',
      '</details>',
    ].join('\n');
    const github = port({
      prPages: {
        first: { comments: [comment(2, assurance)] },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'accepted',
      receipt,
      anchor,
    });
  });

  it('paginates both surfaces within a hard bound and accepts exact Relay receipts', async () => {
    const github = port({
      issuePages: {
        first: { comments: [], nextCursor: 'second' },
        second: { comments: [comment(1, generationMarker())] },
      },
      prPages: {
        first: {
          comments: [comment(2, 'unrelated Relay progress comment')],
          nextCursor: 'second',
        },
        second: {
          comments: [comment(3, assuranceComment(
            formatIssueRelayAdoptionReceiptComment(receipt),
            formatIssueRelayEvaluationAnchorComment(anchor),
          ))],
        },
      },
    });

    await expect(observe(github, 2)).resolves.toMatchObject({
      state: 'accepted',
      marker: { generation: round.generation },
      receipt,
      anchor,
      pullRequest: { headSha: head },
    });
    expect(github.listIssueComments).toHaveBeenCalledTimes(2);
    expect(github.listPullRequestComments).toHaveBeenCalledTimes(2);
  });

  it('ignores marker-shaped comments from every author except the exact Relay bot', async () => {
    const github = port({
      issuePages: {
        first: {
          comments: [
            comment(1, generationMarker(), 'attacker'),
            comment(2, generationMarker(), 'jinn-relay-lookalike[bot]'),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/generation marker/i),
    });
  });

  it('rejects an issue marker that binds the generation to another PR', async () => {
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            pr: {
              number: prNumber + 1,
              branch: receipt.headRef,
              head,
              draft: true,
            },
          }))],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/pull request|PR/i),
    });
  });

  it('rejects a production marker whose managed-fork identity contradicts the receipt', async () => {
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            pr: {
              number: prNumber,
              branch: receipt.headRef,
              head,
              draft: true,
              targetRepository: round.targetRepository,
              targetRepositoryId: 'R_kgDOExample',
              forkRepository: 'attacker/mono',
              forkRepositoryId: 'R_kgDOAttackerFork',
              forkParentRepositoryId: 'R_kgDOExample',
              visibility: 'PUBLIC',
              managedFork: true,
            },
          }))],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/managed-fork identity/i),
    });
  });

  it('keeps an otherwise exact receipt pending after the PR head moves', async () => {
    await expect(observe(port({ headSha: '9'.repeat(40) }))).resolves.toMatchObject({
      state: 'pending',
      detail: expect.stringMatching(/head/i),
    });
  });

  it('fails closed when accepted and rejected receipts bind the same delivery', async () => {
    const rejected: IssueRelayAdoptionReceiptV1 = {
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation,
      reason: 'unsafe-patch',
      detail: 'Rejected by host policy.',
      recordedAt: '2026-07-28T12:10:00.000Z',
    };
    const github = port({
      prPages: {
        first: {
          comments: [
            comment(2, assuranceComment(
              formatIssueRelayAdoptionReceiptComment(receipt),
              formatIssueRelayAdoptionReceiptComment(rejected),
              formatIssueRelayEvaluationAnchorComment(anchor),
            )),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/accepted.*rejected/i),
    });
  });

  it('observes a rejected receipt only when the marker has the same rejected disposition and digest', async () => {
    const rejected: Extract<
      IssueRelayAdoptionReceiptV1,
      { disposition: 'rejected' }
    > = {
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation,
      reason: 'unsafe-patch',
      detail: 'Rejected by host policy.',
      recordedAt: '2026-07-28T12:10:00.000Z',
    };
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            rounds: [markerRound({
              disposition: 'rejected',
              receiptDigest: digest(rejected),
            })],
          }))],
        },
      },
      prPages: {
        first: {
          comments: [
            comment(2, assuranceComment(
              formatIssueRelayAdoptionReceiptComment(rejected),
            )),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'rejected',
      receipt: rejected,
      detail: expect.stringMatching(/rejected/i),
    });
  });

  it('rejects an accepted receipt when the marker declares rejected adoption with accepted-only fields', async () => {
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            rounds: [markerRound({
              disposition: 'rejected',
              resultingHead: head,
              receiptDigest: digest(receipt),
            })],
          }))],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/adoption.*disposition|adoption.*shape/i),
    });
  });

  it('rejects a rejected receipt when the marker declares accepted adoption', async () => {
    const rejected: Extract<
      IssueRelayAdoptionReceiptV1,
      { disposition: 'rejected' }
    > = {
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation,
      reason: 'unsafe-patch',
      detail: 'Rejected by host policy.',
      recordedAt: '2026-07-28T12:10:00.000Z',
    };
    const github = port({
      prPages: {
        first: {
          comments: [
            comment(2, assuranceComment(
              formatIssueRelayAdoptionReceiptComment(rejected),
            )),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/adoption.*disposition/i),
    });
  });

  it('rejects a rejected receipt when the marker digest names a different receipt', async () => {
    const rejected: Extract<
      IssueRelayAdoptionReceiptV1,
      { disposition: 'rejected' }
    > = {
      schemaVersion: 'jinn-issue-relay-adoption.v1',
      disposition: 'rejected',
      correlation,
      reason: 'unsafe-patch',
      detail: 'Rejected by host policy.',
      recordedAt: '2026-07-28T12:10:00.000Z',
    };
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            rounds: [markerRound({
              disposition: 'rejected',
              receiptDigest: digest(receipt),
            })],
          }))],
        },
      },
      prPages: {
        first: {
          comments: [
            comment(2, assuranceComment(
              formatIssueRelayAdoptionReceiptComment(rejected),
            )),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/receipt.*digest/i),
    });
  });

  it('rejects an accepted receipt when marker and anchor agree on the wrong receipt digest', async () => {
    const wrongReceiptDigest = `sha256:${'d'.repeat(64)}` as const;
    const wrongAnchor: IssueRelayEvaluationAnchorV1 = {
      ...anchor,
      adoptionReceiptDigest: wrongReceiptDigest,
    };
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            rounds: [markerRound({
              disposition: 'accepted',
              resultingHead: head,
              receiptDigest: wrongReceiptDigest,
            })],
          }))],
        },
      },
      prPages: {
        first: {
          comments: [
            comment(2, assuranceComment(
              formatIssueRelayAdoptionReceiptComment(receipt),
              formatIssueRelayEvaluationAnchorComment(wrongAnchor),
            )),
          ],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/receipt.*digest/i),
    });
  });

  it('rejects accepted marker adoption without the accepted resulting head', async () => {
    const github = port({
      issuePages: {
        first: {
          comments: [comment(1, generationMarker({
            rounds: [markerRound({
              disposition: 'accepted',
              receiptDigest: digest(receipt),
            })],
          }))],
        },
      },
    });

    await expect(observe(github)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/adoption.*shape/i),
    });
  });

  it('fails closed when a supposedly immutable comment changes across pages', async () => {
    const original = comment(1, generationMarker());
    const edited = { ...original, body: generationMarker({ phase: 'ready' }) };
    const github = port({
      issuePages: {
        first: { comments: [original], nextCursor: 'second' },
        second: { comments: [edited] },
      },
    });

    await expect(observe(github, 2)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/changed|mutable/i),
    });
  });

  it('fails closed instead of following unbounded or cyclic pagination', async () => {
    const github = port({
      issuePages: {
        first: { comments: [], nextCursor: 'second' },
        second: { comments: [], nextCursor: 'second' },
      },
    });

    await expect(observe(github, 2)).resolves.toMatchObject({
      state: 'contradictory',
      detail: expect.stringMatching(/pagination|bound|cursor/i),
    });
  });
});

describe('createIssueRelayGitHubRestReadPort', () => {
  it('reads public PR evidence without credentials and derives the configured exact-head check summary', async () => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      const value = url.includes(`/issues/${issueNumber}/comments`)
        ? [{
            id: 1,
            user: { login: BOT },
            body: generationMarker(),
            created_at: '2026-07-28T12:12:00.000Z',
            updated_at: '2026-07-28T12:12:00.000Z',
          }]
        : url.includes(`/issues/${prNumber}/comments`)
          ? [{
              id: 2,
              user: { login: BOT },
              body: assuranceComment(
                formatIssueRelayAdoptionReceiptComment(receipt),
                formatIssueRelayEvaluationAnchorComment(anchor),
              ),
              created_at: '2026-07-28T12:12:00.000Z',
              updated_at: '2026-07-28T12:12:00.000Z',
            }]
          : url.includes('/check-runs')
            ? {
                total_count: 2,
                check_runs: [
                  {
                    name: 'relay/typecheck',
                    status: 'completed',
                    conclusion: 'success',
                    details_url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
                  },
                  {
                    name: 'optional/lint',
                    status: 'completed',
                    conclusion: 'failure',
                    details_url: 'https://github.com/Jinn-Network/mono/actions/runs/2',
                  },
                ],
              }
            : url.includes('/status?')
              ? { total_count: 0, statuses: [] }
              : {
                  number: prNumber,
                  title: 'Fix the Relay issue',
                  body: '## Summary\n\nFixes the Relay issue.',
                  base: {
                    ref: anchor.targetBase,
                    sha: baseOid,
                    repo: { full_name: round.targetRepository },
                  },
                  head: {
                    ref: receipt.headRef,
                    sha: head,
                    repo: { full_name: receipt.workspaceRepository },
                  },
                };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const github = createIssueRelayGitHubRestReadPort({
      baseUrl: 'https://api.github.test',
      fetchImpl: fetchImpl as typeof fetch,
      requiredCheckNames: ['relay/typecheck'],
    });

    await expect(github.listIssueComments({
      repository: round.targetRepository,
      issueNumber,
    })).resolves.toMatchObject({
      comments: [{ id: 1, authorLogin: BOT }],
    });
    await expect(github.listPullRequestComments({
      repository: round.targetRepository,
      prNumber,
    })).resolves.toMatchObject({
      comments: [{ id: 2, authorLogin: BOT }],
    });
    const pullRequest = await github.readPullRequest({
      repository: round.targetRepository,
      prNumber,
    });
    const required = [{
      name: 'relay/typecheck',
      status: 'passed' as const,
      url: 'https://github.com/Jinn-Network/mono/actions/runs/1',
    }];
    const optional = [{
      name: 'optional/lint',
      status: 'failed' as const,
      url: 'https://github.com/Jinn-Network/mono/actions/runs/2',
    }];
    expect(pullRequest).toEqual({
      number: prNumber,
      title: 'Fix the Relay issue',
      body: '## Summary\n\nFixes the Relay issue.',
      targetRepository: round.targetRepository,
      workspaceRepository: receipt.workspaceRepository,
      targetBase: anchor.targetBase,
      baseOid,
      headRef: receipt.headRef,
      headSha: head,
      checks: {
        digest: digest({ head, required, optional }),
        required,
        optional,
      },
    });
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });

  it.each([
    ['check runs', { total_count: undefined, check_runs: [] }, { total_count: 0, statuses: [] }],
    ['commit statuses', { total_count: 0, check_runs: [] }, { statuses: [] }],
  ])('fails closed when %s omits total_count', async (
    _label,
    checkRuns,
    statuses,
  ) => {
    const fetchImpl = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      const value = url.includes('/check-runs')
        ? checkRuns
        : url.includes('/status?')
          ? statuses
          : {
              number: prNumber,
              base: {
                ref: anchor.targetBase,
                sha: baseOid,
                repo: { full_name: round.targetRepository },
              },
              head: {
                ref: receipt.headRef,
                sha: head,
                repo: { full_name: receipt.workspaceRepository },
              },
            };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const github = createIssueRelayGitHubRestReadPort({
      baseUrl: 'https://api.github.test',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(github.readPullRequest({
      repository: round.targetRepository,
      prNumber,
    })).rejects.toThrow(/total_count|incomplete|malformed/i);
  });
});
