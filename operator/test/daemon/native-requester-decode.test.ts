/**
 * The shared native discovery decode (one-swap M3, umbrella #2461).
 *
 * This gate is what makes the fleet path's `canonicalFinalized` honest, so its refusals are the
 * load-bearing behaviour, not its happy path: every one of them aborts the source pass, so an
 * announcement that fails any of them never becomes a queued card and therefore never reaches
 * claim admission. Covered directly here because it was previously exercised only indirectly,
 * through `native-solver-production.ts`, which no test constructs.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  type CanonicalTaskCreated,
} from '../../src/native-requester/requester.js';
import { buildNativeRequesterAnnouncementDecode } from '../../src/daemon/native-requester-decode.js';
import { NativeDiscoveryLocalAuthorityError } from '../../src/daemon/native-discovery.js';
import type { NativeDiscoveryDecodeInput } from '../../src/daemon/native-discovery.js';

const COORDINATOR = '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98';
const CREATOR = '0x1111111111111111111111111111111111111111';
const TASK_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SUBMISSION_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const TX_HASH = `0x${'c'.repeat(64)}` as const;

function association(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: '84532',
    coordinator: COORDINATOR,
    creator: CREATOR,
    taskId: '7',
    taskDigest: TASK_DIGEST,
    txHash: TX_HASH,
    authorityTime: {
      chainId: 84532,
      blockNumber: '100',
      blockHash: `0x${'d'.repeat(64)}`,
      timestamp: '2026-08-02T00:00:00.000Z',
      finalized: true,
    },
    postingTerms: {
      solutionMaxDeliveryRateWei: '1000',
      verdictMaxDeliveryRateWei: '500',
      responseTimeoutSeconds: '3600',
      allowSolverSelfEvaluation: false,
    },
    ...overrides,
  };
}

function decodeInput(overrides: {
  readonly association?: Record<string, unknown>;
  readonly locations?: readonly { readonly locator: string }[];
} = {}): NativeDiscoveryDecodeInput {
  return {
    source: { agent: 'did:key:zRequester', name: 'requester' },
    entry: {} as NativeDiscoveryDecodeInput['entry'],
    entryDigest: `sha256:${'e'.repeat(64)}`,
    announcement: {
      announcementId: 'announcement-1',
      action: 'available',
      record: { kind: 'https://spec.jinn.network/records/submission/v1', digest: SUBMISSION_DIGEST },
      facts: { [NATIVE_REQUESTER_ASSOCIATION_FACT]: overrides.association ?? association() },
      locations: overrides.locations ?? [{ locator: 'https://requester.example/records/submission' }],
    } as NativeDiscoveryDecodeInput['announcement'],
    signedHighWater: {
      sequence: '0000000000000001',
      entry: `sha256:${'e'.repeat(64)}`,
      issuedAt: '2026-08-02T01:00:00.000Z',
      refreshBy: '2026-08-03T01:00:00.000Z',
      signature: {} as NativeDiscoveryDecodeInput['signedHighWater']['signature'],
    },
  };
}

function ports(overrides: Partial<Parameters<typeof buildNativeRequesterAnnouncementDecode>[0]> = {}) {
  return {
    assertTrustFresh: vi.fn(async () => undefined),
    verifyAuthorityTime: vi.fn(async () => true),
    recordByLocation: vi.fn(async () => new Uint8Array([1, 2, 3])),
    canonicalTaskCreated: vi.fn(async (expected): Promise<CanonicalTaskCreated | null> => ({
      canonical: true,
      ...expected,
    })),
    ...overrides,
  };
}

describe('buildNativeRequesterAnnouncementDecode', () => {
  it('refuses before reading any announcement content when the trust catalog is stale', async () => {
    const recordByLocation = vi.fn(async () => new Uint8Array());
    const decode = buildNativeRequesterAnnouncementDecode(ports({
      assertTrustFresh: async () => { throw new Error('trust catalog is stale'); },
      recordByLocation,
    }));
    await expect(decode(decodeInput())).rejects.toThrow('trust catalog is stale');
    expect(recordByLocation).not.toHaveBeenCalled();
    // #2529: a decode failure normally degrades its source rather than killing the pass. This one
    // reports THIS operator's catalog, not the source's content, so it is marked to stay fatal.
    await expect(decode(decodeInput())).rejects.toBeInstanceOf(NativeDiscoveryLocalAuthorityError);
  });

  it('refuses an authority-time anchor that is not canonical and finalized', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports({
      verifyAuthorityTime: async () => false,
    }));
    await expect(decode(decodeInput())).rejects.toThrow(
      'native requester authority time is not canonical and finalized',
    );
  });

  it('refuses an announcement that advertises anything other than exactly one Submission location', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports());
    await expect(decode(decodeInput({ locations: [] }))).rejects.toThrow(
      'must advertise one Submission location',
    );
    await expect(decode(decodeInput({
      locations: [{ locator: 'https://a.example/x' }, { locator: 'https://b.example/x' }],
    }))).rejects.toThrow('must advertise one Submission location');
  });

  it('refuses posting terms that permit solver self-evaluation', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports());
    await expect(decode(decodeInput({
      association: association({
        postingTerms: {
          solutionMaxDeliveryRateWei: '1000',
          verdictMaxDeliveryRateWei: '500',
          responseTimeoutSeconds: '3600',
          allowSolverSelfEvaluation: true,
        },
      }),
    }))).rejects.toThrow('native requester permits solver self-evaluation');
  });

  it('refuses a TaskCreated the operator cannot re-derive as canonical and finalized', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports({
      canonicalTaskCreated: async () => null,
    }));
    await expect(decode(decodeInput())).rejects.toThrow(
      'native TaskCreated is not canonical and finalized',
    );
  });

  it('re-derives the canonical TaskCreated from the association the requester signed, not from the card', async () => {
    const canonicalTaskCreated = vi.fn(async (expected): Promise<CanonicalTaskCreated> => ({
      canonical: true,
      ...expected,
    }));
    const decode = buildNativeRequesterAnnouncementDecode(ports({ canonicalTaskCreated }));
    // The final `decodeNativeRequesterAnnouncement` call validates the full signed entry, which
    // this fixture deliberately does not synthesise (that shape is covered by
    // `native-discovery.test.ts` against real entries). What is asserted here is the lookup this
    // decode DERIVES and hands to the canonical reader -- the step that decides whether a card is
    // admitted at all.
    await expect(decode(decodeInput())).rejects.toThrow();
    expect(canonicalTaskCreated).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 84532,
      coordinator: COORDINATOR,
      creator: CREATOR,
      taskId: 7n,
      taskDigest: TASK_DIGEST,
      txHash: TX_HASH,
      maxClaims: 1,
      terms: {
        solutionMaxDeliveryRateWei: 1000n,
        verdictMaxDeliveryRateWei: 500n,
        responseTimeoutSeconds: 3600n,
        allowSolverSelfEvaluation: false,
      },
    }));
  });

  /**
   * The live round-5 gate blocker (#2529 F1). `native-requester/requester.ts` emits
   * `chainId: association.chainId`, typed `number` — so an operator's own DSSE-signed announcement
   * was rejected by its own boot path with `chainId is not a canonical unsigned integer`, and
   * because the fleet path REQUIRES its own requester source, every subsequent boot died on it.
   */
  it('decodes the JSON-number chainId the requester signs, on the exact producer shape', async () => {
    const canonicalTaskCreated = vi.fn(async (expected): Promise<CanonicalTaskCreated> => ({
      canonical: true,
      ...expected,
    }));
    const decode = buildNativeRequesterAnnouncementDecode(ports({ canonicalTaskCreated }));
    // As above, the terminal `decodeNativeRequesterAnnouncement` needs a full signed entry this
    // fixture does not synthesise; what is pinned is that the chainId read no longer throws and
    // that the canonical lookup is reached with the right value.
    const failure: unknown = await decode(decodeInput({ association: association({ chainId: 84532 }) }))
      .then(() => undefined, (cause: unknown) => cause);
    expect(String(failure)).not.toContain('chainId is not a canonical unsigned integer');
    expect(canonicalTaskCreated).toHaveBeenCalledWith(expect.objectContaining({ chainId: 84532 }));
  });

  it('still refuses a non-canonical chainId', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports());
    for (const bad of [84532.5, -1, '084532', true, null]) {
      await expect(decode(decodeInput({ association: association({ chainId: bad }) })))
        .rejects.toThrow('chainId is not a canonical unsigned integer');
    }
  });

  it('refuses non-canonical field spellings rather than coercing them', async () => {
    const decode = buildNativeRequesterAnnouncementDecode(ports());
    // A leading-zero taskId is a second spelling of one integer -- two identities for one task.
    await expect(decode(decodeInput({ association: association({ taskId: '007' }) })))
      .rejects.toThrow('taskId is not a canonical unsigned integer');
    await expect(decode(decodeInput({ association: association({ coordinator: '0x1234' }) })))
      .rejects.toThrow('coordinator is not an EVM address');
    await expect(decode(decodeInput({ association: association({ taskDigest: `sha256:${'A'.repeat(64)}` }) })))
      .rejects.toThrow('taskDigest is not a canonical sha256 digest');
  });
});
