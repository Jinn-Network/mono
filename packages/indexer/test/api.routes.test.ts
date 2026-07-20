/**
 * Tests for the 5 REST routes required by spec §6.5.
 *
 * Following the same pattern as api.builders.test.ts: the Ponder `db` /
 * `ponder:api` virtual module cannot be imported from Vitest. Route logic is
 * extracted into pure functions in `src/api/routes.ts` that accept typed rows
 * and return JSON-serialisable results. The Hono route handlers in
 * `src/api/index.ts` call these functions; the tests call them directly.
 *
 * Routes tested:
 *   1. listPluginsByNetwork  — GET /plugins?solverNet=<id>[&includeRevoked=false]
 *   2. listPluginsByBuilder  — GET /plugins?builder=<address>
 *   3. getPluginScores       — GET /plugins/:cid/scores  (ebu7 dep, returns [])
 *   4. listBuilderArtifacts  — GET /builders/:address/artifacts
 *   5. listBuilderScores     — GET /builders/:address/scores  (ebu7 dep, returns [])
 */
import { describe, it, expect } from 'vitest';
import {
  listPluginsByNetwork,
  listPluginsByBuilder,
  getPluginScores,
  listBuilderArtifacts,
  listBuilderScores,
  type PluginPublicationRow,
  type AttemptEnvelopeMetaRow,
  type VerdictRow,
} from '../src/api/routes.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PUB_SHA = `0x${'aa'.repeat(32)}` as const;
const FORK_SHA = `0x${'bb'.repeat(32)}` as const;

function makePub(opts: {
  agentId: string;
  cid: string;
  name?: string;
  version?: string;
  supports?: string[];
  revoked?: boolean;
  revokedReason?: string | null;
  publishedAt?: bigint;
  blockNumber?: bigint;
}): PluginPublicationRow {
  return {
    id: `${opts.agentId}:${opts.cid}`,
    builderAgentId: opts.agentId,
    pluginCid: opts.cid,
    pluginName: opts.name ?? '@builder/swe-skill',
    pluginVersion: opts.version ?? '0.1.0',
    pluginSha256: PUB_SHA,
    supports: opts.supports ?? ['swe-rebench-v2.v1'],
    publishedAt: opts.publishedAt ?? 1_715_700_000n,
    revoked: opts.revoked ?? false,
    revokedReason: opts.revokedReason ?? null,
    blockNumber: opts.blockNumber ?? 100n,
    txIndex: 0,
    logIndex: 0,
    txHash: `0x${'00'.repeat(32)}`,
    chainId: 84532,
  };
}

function makeEnvelopeMeta(opts: {
  requestId: `0x${string}`;
  pluginCid: string;
  sha256?: string;
}): AttemptEnvelopeMetaRow {
  return {
    requestId: opts.requestId,
    manifestCid: 'bafyenvcid',
    pluginsJson: JSON.stringify([{
      name: '@builder/swe-skill',
      version: '0.1.0',
      cid: opts.pluginCid,
      sha256: (opts.sha256 ?? PUB_SHA).replace(/^0x/i, ''),
    }]),
    enrichedAtBlock: 110n,
    chainId: 84532,
  };
}

function makeVerdict(opts: {
  requestId: `0x${string}`;
  verdict?: string;
  score?: number;
  ts?: number;
}): VerdictRow {
  return {
    requestId: opts.requestId,
    taskId: '7',
    operatorAgentId: '99',
    verdict: opts.verdict ?? 'Pass',
    score: opts.score ?? 100,
    ts: opts.ts ?? 1_715_710_000,
  };
}

// ── Route 1: GET /plugins?solverNet=<id> ─────────────────────────────────────

describe('listPluginsByNetwork', () => {
  const pub1 = makePub({ agentId: '42', cid: 'bafypluginA', supports: ['swe-rebench-v2.v1'] });
  const pub2 = makePub({ agentId: '43', cid: 'bafypluginB', supports: ['prediction.v1', 'swe-rebench-v2.v1'] });
  const pub3 = makePub({ agentId: '44', cid: 'bafypluginC', supports: ['prediction.v1'] });
  const pubRevoked = makePub({ agentId: '45', cid: 'bafypluginD', supports: ['swe-rebench-v2.v1'], revoked: true, revokedReason: 'cve' });

  it('returns plug-ins whose supports array includes the requested solverNet', () => {
    const result = listPluginsByNetwork({
      publications: [pub1, pub2, pub3, pubRevoked],
      solverNet: 'swe-rebench-v2.v1',
      includeRevoked: true,
    });
    const cids = result.map((r) => r.cid);
    expect(cids).toContain('bafypluginA');
    expect(cids).toContain('bafypluginB');
    expect(cids).toContain('bafypluginD');
    expect(cids).not.toContain('bafypluginC');
  });

  it('excludes revoked rows when includeRevoked=false (default)', () => {
    const result = listPluginsByNetwork({
      publications: [pub1, pub2, pub3, pubRevoked],
      solverNet: 'swe-rebench-v2.v1',
      includeRevoked: false,
    });
    const cids = result.map((r) => r.cid);
    expect(cids).toContain('bafypluginA');
    expect(cids).toContain('bafypluginB');
    expect(cids).not.toContain('bafypluginD');
  });

  it('returns an empty array when no plug-in targets the requested solverNet', () => {
    const result = listPluginsByNetwork({
      publications: [pub3],
      solverNet: 'swe-rebench-v2.v1',
      includeRevoked: false,
    });
    expect(result).toHaveLength(0);
  });

  it('maps rows to PublishedArtifact (PluginPublication) shape', () => {
    const result = listPluginsByNetwork({
      publications: [pub1],
      solverNet: 'swe-rebench-v2.v1',
      includeRevoked: false,
    });
    expect(result[0]).toMatchObject({
      builderAgentId: '42',
      cid: 'bafypluginA',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      artifactType: 'plugin',
      revoked: false,
      pluginSha256: PUB_SHA,
    });
    expect(typeof result[0]!.publishedAt).toBe('number');
  });
});

// ── Route 2: GET /plugins?builder=<address> ──────────────────────────────────

describe('listPluginsByBuilder', () => {
  const pub1 = makePub({ agentId: '42', cid: 'bafypluginA' });
  const pub2 = makePub({ agentId: '42', cid: 'bafypluginB', version: '0.2.0' });
  const pub3 = makePub({ agentId: '43', cid: 'bafypluginC' });
  const pubRevoked = makePub({ agentId: '42', cid: 'bafypluginD', revoked: true });

  it('returns all publications for a given builderAgentId', () => {
    const result = listPluginsByBuilder({
      publications: [pub1, pub2, pub3, pubRevoked],
      builderAgentId: '42',
      includeRevoked: true,
    });
    const cids = result.map((r) => r.cid);
    expect(cids).toContain('bafypluginA');
    expect(cids).toContain('bafypluginB');
    expect(cids).toContain('bafypluginD');
    expect(cids).not.toContain('bafypluginC');
  });

  it('excludes revoked rows when includeRevoked=false', () => {
    const result = listPluginsByBuilder({
      publications: [pub1, pub2, pub3, pubRevoked],
      builderAgentId: '42',
      includeRevoked: false,
    });
    expect(result.map((r) => r.cid)).not.toContain('bafypluginD');
    expect(result).toHaveLength(2);
  });

  it('returns an empty array for a builder with no publications', () => {
    const result = listPluginsByBuilder({
      publications: [],
      builderAgentId: '42',
      includeRevoked: false,
    });
    expect(result).toHaveLength(0);
  });

  it('maps rows to PluginPublication shape', () => {
    const result = listPluginsByBuilder({
      publications: [pub1],
      builderAgentId: '42',
      includeRevoked: false,
    });
    expect(result[0]).toMatchObject({
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafypluginA',
      pluginSha256: PUB_SHA,
    });
  });
});

// ── Route 3: GET /plugins/:cid/scores ────────────────────────────────────────
//   ebu7 dependency: returns [] gracefully when attemptEnvelopeMeta unavailable.

describe('getPluginScores', () => {
  const pub = makePub({ agentId: '42', cid: 'bafypluginA' });

  it('returns an empty array when no attemptEnvelopeMeta rows are provided (ebu7 dep)', () => {
    const result = getPluginScores({
      publications: [pub],
      pluginCid: 'bafypluginA',
      attemptEnvelopeMetas: [],
      verdicts: [],
    });
    expect(result).toHaveLength(0);
  });

  it('fails closed when only shape-parsed attempt metadata is populated', () => {
    const meta = makeEnvelopeMeta({ requestId: '0xreq1' as `0x${string}`, pluginCid: 'bafypluginA' });
    const verdict = makeVerdict({ requestId: '0xreq1' as `0x${string}`, verdict: 'Pass', score: 100 });

    const result = getPluginScores({
      publications: [pub],
      pluginCid: 'bafypluginA',
      attemptEnvelopeMetas: [meta],
      verdicts: [verdict],
    });
    expect(result).toEqual([]);
  });

  it('does not expose an unauthenticated fork signal as score history', () => {
    const meta = makeEnvelopeMeta({
      requestId: '0xreq2' as `0x${string}`,
      pluginCid: 'bafypluginA',
      sha256: FORK_SHA,
    });
    const verdict = makeVerdict({ requestId: '0xreq2' as `0x${string}` });

    const result = getPluginScores({
      publications: [pub],
      pluginCid: 'bafypluginA',
      attemptEnvelopeMetas: [meta],
      verdicts: [verdict],
    });
    expect(result).toEqual([]);
  });

  it('fails closed when retained candidates disagree for one request and chain', () => {
    const legitimate = makeEnvelopeMeta({
      requestId: '0xreq2' as `0x${string}`,
      pluginCid: 'bafypluginA',
    });
    const competing = makeEnvelopeMeta({
      requestId: '0xreq2' as `0x${string}`,
      pluginCid: 'bafypluginA',
      sha256: FORK_SHA,
    });
    const verdict = makeVerdict({ requestId: '0xreq2' as `0x${string}` });

    const result = getPluginScores({
      publications: [pub],
      pluginCid: 'bafypluginA',
      attemptEnvelopeMetas: [legitimate, competing],
      verdicts: [verdict],
    });

    expect(result).toEqual([]);
  });

  it('returns empty when the requested cid has no matching publication', () => {
    const result = getPluginScores({
      publications: [],
      pluginCid: 'bafyunknown',
      attemptEnvelopeMetas: [],
      verdicts: [],
    });
    expect(result).toHaveLength(0);
  });
});

// ── Route 4: GET /builders/:address/artifacts ─────────────────────────────────

describe('listBuilderArtifacts', () => {
  const pub1 = makePub({ agentId: '42', cid: 'bafypluginA' });
  const pub2 = makePub({ agentId: '42', cid: 'bafypluginB' });
  const pub3 = makePub({ agentId: '43', cid: 'bafypluginC' });
  const pubRevoked = makePub({ agentId: '42', cid: 'bafypluginD', revoked: true });

  it('returns all published artifacts for a given builderAgentId (including revoked)', () => {
    const result = listBuilderArtifacts({
      publications: [pub1, pub2, pub3, pubRevoked],
      builderAgentId: '42',
    });
    const cids = result.map((r) => r.cid);
    expect(cids).toContain('bafypluginA');
    expect(cids).toContain('bafypluginB');
    expect(cids).toContain('bafypluginD');
    expect(cids).not.toContain('bafypluginC');
  });

  it('shapes results as PublishedArtifact[] with artifactType discriminator', () => {
    const result = listBuilderArtifacts({
      publications: [pub1],
      builderAgentId: '42',
    });
    expect(result[0]).toMatchObject({
      artifactType: 'plugin',
      builderAgentId: '42',
      cid: 'bafypluginA',
      name: '@builder/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
    });
  });

  it('returns an empty array when the builder has no artifacts', () => {
    const result = listBuilderArtifacts({ publications: [], builderAgentId: '99' });
    expect(result).toHaveLength(0);
  });
});

// ── Route 5: GET /builders/:address/scores ────────────────────────────────────
//   ebu7 dependency: returns [] gracefully when attemptEnvelopeMeta unavailable.

describe('listBuilderScores', () => {
  const pub1 = makePub({ agentId: '42', cid: 'bafypluginA' });
  const pub2 = makePub({ agentId: '42', cid: 'bafypluginB' });

  it('returns an empty array when no attemptEnvelopeMeta rows are provided (ebu7 dep)', () => {
    const result = listBuilderScores({
      publications: [pub1, pub2],
      builderAgentId: '42',
      attemptEnvelopeMetas: [],
      verdicts: [],
    });
    expect(result).toHaveLength(0);
  });

  it('does not return unauthenticated per-artifact score rows', () => {
    const metaA = makeEnvelopeMeta({ requestId: '0xreqA' as `0x${string}`, pluginCid: 'bafypluginA' });
    const metaB = makeEnvelopeMeta({ requestId: '0xreqB' as `0x${string}`, pluginCid: 'bafypluginB' });
    const verdictA = makeVerdict({ requestId: '0xreqA' as `0x${string}`, verdict: 'Pass', score: 100 });
    const verdictB = makeVerdict({ requestId: '0xreqB' as `0x${string}`, verdict: 'Fail', score: 0 });

    const result = listBuilderScores({
      publications: [pub1, pub2],
      builderAgentId: '42',
      attemptEnvelopeMetas: [metaA, metaB],
      verdicts: [verdictA, verdictB],
    });

    expect(result).toEqual([]);
  });

  it('does not return score rows for another builder\'s plug-ins', () => {
    const pub3 = makePub({ agentId: '99', cid: 'bafypluginC' });
    const meta = makeEnvelopeMeta({ requestId: '0xreqC' as `0x${string}`, pluginCid: 'bafypluginC' });
    const verdict = makeVerdict({ requestId: '0xreqC' as `0x${string}` });

    const result = listBuilderScores({
      publications: [pub1, pub2, pub3],
      builderAgentId: '42',
      attemptEnvelopeMetas: [meta],
      verdicts: [verdict],
    });

    expect(result).toHaveLength(0);
  });
});
