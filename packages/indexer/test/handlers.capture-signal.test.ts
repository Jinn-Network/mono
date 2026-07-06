/**
 * Capture-envelope enrichment + distribution-signal tests (#1314).
 *
 * The critical net is seed exclusion: `provenance: 'imported'` rows appear in
 * NO count in the default signal — buildDistributionSignal reports them only
 * as `seedsExcluded`, and `?include=seeded` folds them back in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleMetadataSet,
  parseCaptureWrapperLite,
  parseTraceEnvelopeSignalLite,
  type HandlerContext,
} from '../src/handlers.js';
import {
  solverNetManifest,
  envelope,
  captureEnvelopeMeta,
} from '../ponder.schema.js';
import { createInMemoryDb, type InMemoryDb, type PkMap } from './helpers/in-memory-db.js';
import { metadataSetEvent, envelopePayloadV2 } from './helpers/events.js';
import type { FetchLike } from '../src/ipfs.js';
import { buildDistributionSignal, type CaptureEnvelopeMetaRow } from '../src/api/routes.js';

const CHAIN_ID = 84532;
const WRAPPER_CID = 'bafywrapper';
const ARTIFACT_CID = 'bafytraceartifact';
const MANIFEST_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;
const CONTRIBUTOR = '0x1111111111111111111111111111111111111111';

const PKS: PkMap = new Map<unknown, string[]>([
  [solverNetManifest, ['id']],
  [envelope, ['agentId', 'metadataKey', 'chainId']],
  [captureEnvelopeMeta, ['manifestCid', 'chainId']],
]);

function traceEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.trace-envelope.v0',
    task: {
      summary: 'Fix failing vitest suite',
      distributionTags: ['typescript', 'testing'],
    },
    environment: {
      harness: { name: 'jinn-agent', version: '0.4.2' },
      model: 'gpt-5.4-mini',
      tools: ['read', 'edit', 'bash'],
    },
    steps: [
      { spanId: '1', name: 'read' },
      { spanId: '2', name: 'edit' },
      { spanId: '3', name: 'bash' },
    ],
    outcome: { status: 'completed', verifiabilityTier: 'tests-passed' },
    provenance: 'contributed',
    ...overrides,
  };
}

/** The wrapper envelope body as published by harness-layer publish(). */
function wrapperBody(): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.execution.v1',
    participant: { safeAddress: CONTRIBUTOR },
    artifacts: [
      {
        artifactType: 'jinn.trace-envelope.v0',
        sha256: 'a'.repeat(64),
        sources: [{ kind: 'ipfs', cid: ARTIFACT_CID, sha256: 'a'.repeat(64) }],
      },
    ],
  };
}

/** The donation-encoded artifact body (base64 `data` carries the trace). */
function artifactBody(trace: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.artifact.donation.v1',
    artifactType: 'jinn.trace-envelope.v0',
    data: Buffer.from(JSON.stringify(trace), 'utf-8').toString('base64'),
  };
}

function ipfsFetch(bodies: Record<string, unknown>): FetchLike {
  return (async (url: string) => {
    const cid = Object.keys(bodies).find((c) => String(url).includes(c));
    if (!cid) return { ok: false, status: 404, statusText: 'not found' };
    return {
      ok: true,
      status: 200,
      json: async () => bodies[cid],
      text: async () => JSON.stringify(bodies[cid]),
    };
  }) as unknown as FetchLike;
}

let db: InMemoryDb;
let context: HandlerContext;

beforeEach(() => {
  db = createInMemoryDb(PKS);
  context = { db, chain: { id: CHAIN_ID } } as HandlerContext;
});

const ANCHOR_TX = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

async function runCaptureEvent(
  bodies: Record<string, unknown>,
  eventOverrides: { timestamp?: bigint; txHash?: `0x${string}` } = {},
): Promise<void> {
  await handleMetadataSet({
    event: metadataSetEvent(
      {
        metadataKey: `capture:${WRAPPER_CID}`,
        metadataValue: envelopePayloadV2({ tier: 0, manifestHash: MANIFEST_HASH }),
      },
      eventOverrides,
    ),
    context,
    solverNetManifest,
    envelope,
    captureEnvelopeMeta,
    enrichCaptures: true,
    ipfsGateway: 'https://gw.example',
    fetchImpl: ipfsFetch(bodies),
  });
}

describe('capture envelope enrichment → captureEnvelopeMeta', () => {
  it('writes tags, provenance, contributor and summary from the two-hop fetch', async () => {
    await runCaptureEvent({
      [WRAPPER_CID]: wrapperBody(),
      [ARTIFACT_CID]: artifactBody(traceEnvelope()),
    });
    const rows = db.rows(captureEnvelopeMeta);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      manifestCid: WRAPPER_CID,
      chainId: CHAIN_ID,
      contributor: CONTRIBUTOR,
      taskSummary: 'Fix failing vitest suite',
      tagsJson: JSON.stringify(['typescript', 'testing']),
      provenance: 'contributed',
      verifiabilityTier: 'tests-passed',
      enrichmentStatus: 'ok',
    });
    // The plain envelope anchor row is still written alongside.
    expect(db.rows(envelope)).toHaveLength(1);
  });

  it('writes the #1406 detail columns: harness, model, tools, stepCount, anchorTx, createdAt', async () => {
    await runCaptureEvent(
      {
        [WRAPPER_CID]: wrapperBody(),
        [ARTIFACT_CID]: artifactBody(traceEnvelope()),
      },
      { timestamp: 1_720_000_000n, txHash: ANCHOR_TX },
    );
    expect(db.rows(captureEnvelopeMeta)[0]).toMatchObject({
      harness: 'jinn-agent 0.4.2',
      model: 'gpt-5.4-mini',
      toolsJson: JSON.stringify(['read', 'edit', 'bash']),
      stepCount: 3,
      anchorTx: ANCHOR_TX,
      createdAtTimestamp: 1_720_000_000n,
    });
  });

  it('records imported provenance for seeds', async () => {
    await runCaptureEvent({
      [WRAPPER_CID]: wrapperBody(),
      [ARTIFACT_CID]: artifactBody(traceEnvelope({ provenance: 'imported' })),
    });
    expect(db.rows(captureEnvelopeMeta)[0]).toMatchObject({ provenance: 'imported' });
  });

  it('writes no meta row when IPFS fetch fails (anchor row still lands)', async () => {
    await runCaptureEvent({}); // 404 everywhere
    expect(db.rows(captureEnvelopeMeta)).toHaveLength(0);
    expect(db.rows(envelope)).toHaveLength(1);
  });

  it('does nothing when enrichCaptures is off', async () => {
    await handleMetadataSet({
      event: metadataSetEvent({
        metadataKey: `capture:${WRAPPER_CID}`,
        metadataValue: envelopePayloadV2({ tier: 0, manifestHash: MANIFEST_HASH }),
      }),
      context,
      solverNetManifest,
      envelope,
      captureEnvelopeMeta,
      enrichCaptures: false,
      ipfsGateway: 'https://gw.example',
      fetchImpl: ipfsFetch({
        [WRAPPER_CID]: wrapperBody(),
        [ARTIFACT_CID]: artifactBody(traceEnvelope()),
      }),
    });
    expect(db.rows(captureEnvelopeMeta)).toHaveLength(0);
  });
});

describe('parseCaptureWrapperLite', () => {
  it('extracts contributor + trace artifact cid', () => {
    expect(parseCaptureWrapperLite(wrapperBody())).toEqual({
      contributor: CONTRIBUTOR,
      traceArtifactCid: ARTIFACT_CID,
    });
  });

  it('returns null when no trace-envelope artifact is present', () => {
    expect(parseCaptureWrapperLite({ participant: {}, artifacts: [] })).toBeNull();
    expect(parseCaptureWrapperLite(null)).toBeNull();
  });
});

describe('parseTraceEnvelopeSignalLite', () => {
  it('decodes the donation encoding', () => {
    const lite = parseTraceEnvelopeSignalLite(artifactBody(traceEnvelope()));
    expect(lite).toMatchObject({
      taskSummary: 'Fix failing vitest suite',
      provenance: 'contributed',
      verifiabilityTier: 'tests-passed',
    });
  });

  it('tolerates a raw trace body and defaults provenance to contributed', () => {
    const lite = parseTraceEnvelopeSignalLite(traceEnvelope());
    expect(lite?.tagsJson).toBe(JSON.stringify(['typescript', 'testing']));
    expect(lite?.provenance).toBe('contributed');
  });

  it('extracts the #1406 detail fields from environment + steps', () => {
    const lite = parseTraceEnvelopeSignalLite(artifactBody(traceEnvelope()));
    expect(lite).toMatchObject({
      harness: 'jinn-agent 0.4.2',
      model: 'gpt-5.4-mini',
      toolsJson: JSON.stringify(['read', 'edit', 'bash']),
      stepCount: 3,
    });
  });

  it('defaults the detail fields when environment/steps are absent', () => {
    const lite = parseTraceEnvelopeSignalLite({
      schemaVersion: 'jinn.trace-envelope.v0',
      task: { summary: 's', distributionTags: ['x'] },
      outcome: { verifiabilityTier: 'user-accepted' },
      provenance: 'contributed',
    });
    expect(lite).toMatchObject({ harness: '', model: '', toolsJson: '[]', stepCount: 0 });
  });

  it('rejects undecodable data', () => {
    expect(parseTraceEnvelopeSignalLite({ data: '!!!not-base64-json!!!' })).toBeNull();
  });
});

describe('buildDistributionSignal', () => {
  function meta(overrides: Partial<CaptureEnvelopeMetaRow> = {}): CaptureEnvelopeMetaRow {
    return {
      manifestCid: 'bafy-x',
      chainId: CHAIN_ID,
      contributor: CONTRIBUTOR,
      taskSummary: 's',
      tagsJson: JSON.stringify(['typescript', 'testing']),
      provenance: 'contributed',
      verifiabilityTier: 'tests-passed',
      ...overrides,
    };
  }

  it('groups by primary tag, sorted by volume, with totals', () => {
    const out = buildDistributionSignal([
      meta(),
      meta({ contributor: '0x2222222222222222222222222222222222222222' }),
      meta({ tagsJson: JSON.stringify(['research']) }),
    ]);
    expect(out.rows[0]).toMatchObject({ cluster: 'typescript', envelopeCount: 2, contributorCount: 2 });
    expect(out.rows[1]).toMatchObject({ cluster: 'research', envelopeCount: 1 });
    expect(out.envelopeTotal).toBe(3);
    expect(out.contributorTotal).toBe(2);
  });

  it('seed exclusion: imported rows appear in NO count and are reported as excluded', () => {
    const out = buildDistributionSignal([
      meta(),
      meta({ provenance: 'imported', tagsJson: JSON.stringify(['seeds-only']) }),
    ]);
    expect(out.rows.map((r) => r.cluster)).toEqual(['typescript']);
    expect(out.envelopeTotal).toBe(1);
    expect(out.seedsExcluded).toBe(1);
    expect(out.includeSeeds).toBe(false);
  });

  it('includeSeeds folds seeds back in (the demonstrate-it-live toggle)', () => {
    const out = buildDistributionSignal(
      [meta(), meta({ provenance: 'imported', tagsJson: JSON.stringify(['seeds-only']) })],
      { includeSeeds: true },
    );
    expect(out.rows.map((r) => r.cluster).sort()).toEqual(['seeds-only', 'typescript']);
    expect(out.seedsExcluded).toBe(0);
    expect(out.includeSeeds).toBe(true);
  });

  it('empty input yields the explicit empty shape', () => {
    expect(buildDistributionSignal([])).toEqual({
      rows: [],
      envelopeTotal: 0,
      contributorTotal: 0,
      seedsExcluded: 0,
      includeSeeds: false,
    });
  });

  it('malformed tagsJson rows are counted nowhere', () => {
    const out = buildDistributionSignal([meta({ tagsJson: 'not json' })]);
    expect(out.rows).toEqual([]);
    expect(out.envelopeTotal).toBe(0);
  });
});
