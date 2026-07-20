import { describe, expect, it, vi } from 'vitest';
import { RETRIEVAL_VISIBLE_TAG } from '@jinn-network/plugin';
import { createVerdictSource } from '../src/bridge-verdict-source.js';
import {
  bridgeAttempts,
  repoFromInstanceId,
  type AttemptRef,
  type BridgeEvidence,
} from '../src/bridge.js';
import type { CapturedTask } from '../src/capture.js';

const ROOT = `0x${'ab'.repeat(32)}` as const;
const TX = `0x${'cd'.repeat(32)}` as const;

function requestId(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`;
}

function verdictRow(index: number, instanceId: string, actualPassed: boolean) {
  return {
    requestId: requestId(index),
    chainId: 84532,
    instanceId,
    actualPassed,
    evaluatorVerdict: actualPassed ? 'PASS' : 'FAIL',
    manifestCid: `bafyVerdict${index}`,
  };
}

function verifiedEvidence(
  ref: AttemptRef,
  trajectorySpans?: BridgeEvidence['trajectorySpans'],
): BridgeEvidence {
  return {
    taskSummary: `Fix the authenticated task ${ref.instanceId}`,
    patch: `diff --git a/src/${ref.instanceId}.ts b/src/${ref.instanceId}.ts\n+ fixed\n`,
    repo: repoFromInstanceId(ref.instanceId) ?? 'unknown/repo',
    baseCommit: 'a'.repeat(40),
    taskCreatedAt: 1_752_969_600,
    instanceId: ref.instanceId,
    verifier: {
      failToPass: ['test_regression'],
      passToPass: ['test_existing_behavior'],
      evalSemanticsVersion: 'swe-rebench-v2',
    },
    ...(trajectorySpans ? { trajectorySpans } : {}),
  };
}

describe('bridge derivation run v0 — offline acceptance', () => {
  it('pages, excludes held-out identities, derives typed/degraded members, and preserves receipt gas', async () => {
    const pages = [
      {
        items: [
          verdictRow(1, 'held__repo-1', true),
          verdictRow(2, 'held__repo-2', false),
        ],
        pageInfo: { hasNextPage: true, endCursor: 'page-1' },
      },
      {
        items: [
          verdictRow(3, 'typed__repo-3', true),
          verdictRow(4, 'degraded__repo-4', false),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    let page = 0;
    const sourceFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { after: string | null };
      };
      expect(body.variables.after).toBe(page === 0 ? null : 'page-1');
      return new Response(JSON.stringify({
        data: { verdictEnvelopeMetas: pages[page++] },
      }));
    }) as unknown as typeof fetch;
    const source = createVerdictSource({
      graphqlUrl: 'https://offline.invalid/graphql',
      fetchImpl: sourceFetch,
    });
    const refs = await source.list({ limit: 4 });
    expect(refs).toHaveLength(4);
    expect(sourceFetch).toHaveBeenCalledTimes(2);

    const publishEvidence = vi.fn().mockRejectedValue(
      new Error('per-record publication must not run in manifest mode'),
    );
    const publishManifestBatch = vi.fn(async (
      candidates: Array<{ task: CapturedTask; ref: AttemptRef }>,
    ) => {
      expect(candidates.map(({ ref }) => ref.requestId)).toEqual([
        requestId(3),
        requestId(4),
      ]);
      for (const { task } of candidates) {
        expect(task.provenance).toBe('derived-from-history');
        expect(task.task.distributionTags).not.toContain(RETRIEVAL_VISIBLE_TAG);
      }
      const typed = candidates[0]!.task;
      expect(typed.task.distributionTags).not.toContain('patch-only');
      expect(typed.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'jinn.agent_turn',
          attributes: expect.objectContaining({
            'jinn.transcript.parser': 'claude-code-stream-json',
            'jinn.transcript.parserVersion': '1.0.0',
          }),
        }),
      ]));
      const degraded = candidates[1]!.task;
      expect(degraded.task.distributionTags).toContain('patch-only');
      expect(degraded.steps.map((step: { name: string }) => step.name)).toEqual([
        'tool:apply_patch',
        'evaluator:verdict',
      ]);

      return {
        memberRefs: ['bafyTypedMember', 'bafyDegradedMember'],
        batches: [{
          manifestCid: 'bafyManifest',
          memberRefs: ['bafyTypedMember', 'bafyDegradedMember'],
          root: ROOT,
          anchorTx: TX,
          gasUsed: 123_456n,
          feeWei: 789_012n,
        }],
      };
    });

    const result = await bridgeAttempts(refs, {
      slateInstanceIds: new Set(['held__repo-1']),
      anchorMode: 'manifest',
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      fetchEvidence: async (ref) => verifiedEvidence(
        ref,
        ref.instanceId === 'typed__repo-3'
          ? [{
              name: 'agent_turn.assistant',
              kind: 'INTERNAL',
              startTimeUnixNano: '100',
              endTimeUnixNano: '101',
              attributes: {
                'jinn.span.kind': 'jinn.agent_turn',
                'message.content': 'Inspect the failure and repair it.',
                'jinn.transcript.sourceFormat': 'claude-code-stream-json',
                'jinn.transcript.parser': 'claude-code-stream-json',
                'jinn.transcript.parserVersion': '1.0.0',
              },
              events: [],
              status: { code: 'OK' },
            }]
          : undefined,
      ),
      publishEvidence,
      publishManifestBatch,
    });

    expect(publishEvidence).not.toHaveBeenCalled();
    expect(publishManifestBatch).toHaveBeenCalledTimes(1);
    expect(result.excludedHeldOut).toEqual([
      { instanceId: 'held__repo-1', reason: 'instance_id' },
      { instanceId: 'held__repo-2', reason: 'repo' },
    ]);
    expect(result.bridged.map(({ envelopeRef }) => envelopeRef)).toEqual([
      'bafyTypedMember',
      'bafyDegradedMember',
    ]);
    expect(result).toMatchObject({
      manifestCid: 'bafyManifest',
      manifestMemberRefs: ['bafyTypedMember', 'bafyDegradedMember'],
      anchorTx: TX,
      gasUsed: 123_456n,
      feeWei: 789_012n,
      manifestConfirmed: true,
    });
  });
});
