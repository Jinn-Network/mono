import { describe, it, expect } from 'vitest';
import {
  attributeRuns,
  type AttemptEnvelopeMetaRow,
  type PluginPublicationRow,
  type VerdictRow,
} from '../src/builder-attribution.js';

const PUB_SHA = `0x${'aa'.repeat(32)}`;
const FORK_SHA = `0x${'bb'.repeat(32)}`;

const pub: PluginPublicationRow = {
  id: '42:bafycid',
  builderAgentId: '42',
  pluginCid: 'bafycid',
  pluginName: '@builder/swe-skill',
  pluginVersion: '0.1.0',
  pluginSha256: PUB_SHA,
  supports: ['swe-rebench-v2.v1'],
  publishedAt: 1_715_700_000n,
  revoked: false,
  revokedReason: null,
  blockNumber: 100n,
  txIndex: 0,
  logIndex: 0,
  txHash: `0x${'00'.repeat(32)}`,
  chainId: 84532,
};

function meta(opts: { requestId: `0x${string}`; pluginCid: string; sha256: string; block?: bigint }): AttemptEnvelopeMetaRow {
  return {
    requestId: opts.requestId,
    manifestCid: 'bafyenvcid',
    pluginsJson: JSON.stringify([{ name: 'p', version: '0.1.0', cid: opts.pluginCid, sha256: opts.sha256 }]),
    enrichedAtBlock: opts.block ?? 110n,
    chainId: 84532,
  };
}

function verdict(opts: { requestId: `0x${string}`; verdict: string; score?: number; ts?: number }): VerdictRow {
  return {
    requestId: opts.requestId,
    verdict: opts.verdict,
    score: opts.score,
    ts: opts.ts ?? 1_715_710_000,
    operatorAgentId: '99',
    taskId: '7',
  };
}

describe('attributeRuns (attd join)', () => {
  it('does not attribute an unauthenticated envelope projection', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass', score: 100 })],
    });
    expect(out).toEqual([]);
  });

  it('does not expose an unauthenticated fork signal', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafycid', sha256: FORK_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass' })],
    });
    expect(out).toEqual([]);
  });

  it('returns no row when there is no matching publication (operator-only attribution)', () => {
    const out = attributeRuns({
      publications: [],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafyunknown', sha256: PUB_SHA.slice(2) })],
      verdicts: [verdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass' })],
    });
    expect(out).toHaveLength(0);
  });

  it('returns no row when the envelope has a publication match but no verdict yet', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [meta({ requestId: '0xreq2' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) })],
      verdicts: [],
    });
    expect(out).toHaveLength(0);
  });

  it('does not aggregate unauthenticated score history', () => {
    const out = attributeRuns({
      publications: [pub],
      attemptEnvelopeMetas: [
        meta({ requestId: '0xreqA' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) }),
        meta({ requestId: '0xreqB' as `0x${string}`, pluginCid: 'bafycid', sha256: PUB_SHA.slice(2) }),
        meta({ requestId: '0xreqC' as `0x${string}`, pluginCid: 'bafycid', sha256: FORK_SHA.slice(2) }),
      ],
      verdicts: [
        verdict({ requestId: '0xreqA' as `0x${string}`, verdict: 'Pass', score: 100, ts: 1 }),
        verdict({ requestId: '0xreqB' as `0x${string}`, verdict: 'Fail', score: 0, ts: 2 }),
        verdict({ requestId: '0xreqC' as `0x${string}`, verdict: 'Pass', score: 100, ts: 3 }),
      ],
    });
    expect(out).toEqual([]);
  });
});
