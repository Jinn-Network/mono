/**
 * A skipped source-bundle or task check must say why (#3758).
 *
 * Steps 3 and 6 swallowed every read failure with a bare `catch {}`, so the
 * report showed the same skipped checks whether the content is genuinely not
 * on IPFS or the byte cap refused it, the redirect guard blocked it, or the
 * transport failed. Step 4 already classified before warning; these two now do
 * the same. Only a gateway that answered 404/410 is silent; anything else,
 * including the 400 a real gateway gives a malformed stub CID, is one warning
 * line naming its classification.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IpfsContentNotFoundError,
  IpfsFetchFailedError,
  IpfsResponseTooLargeError,
} from '@jinn-network/core/corpus-read';

const BUNDLE_CID = 'bafy-test-source-bundle-001';
const fetchFromIpfs = vi.fn();
const fetchSourceBundleFromIpfs = vi.fn();

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  normalizeIpfsRegistryAddUrl: vi.fn((url: string) => url),
  cidToDigestHex: vi.fn().mockReturnValue('0x' + 'de'.repeat(32)),
  digestHexToGatewayUrl: vi.fn((hex: string) => `https://gateway.autonolas.tech/ipfs/${hex}`),
  fetchFromIpfs,
  fetchTrajectoryFromIpfs: vi.fn(),
  fetchSignedEnvelopeBytesRaw: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn(),
  fetchSourceBundleFromIpfs,
}));

const { runConformance } = await import('../../src/conformance/harness.js');
const { buildGoodRestorationFixture } = await import('./fixtures/good-envelope.js');

function failure(cause: unknown): IpfsFetchFailedError {
  return new IpfsFetchFailedError('IPFS fetch failed after all candidates', [cause]);
}

/**
 * Reach step 6's IPFS read.
 *
 * `SignedEnvelopeSchema` refines attested envelopes on BOTH `executor.source`
 * and a non-null `attestation`, and the fixture supplies neither — so a strict
 * parse fails and the harness keeps the raw object on `ctx.envelope`, which is
 * where step 6 reads `evidenceTier` and `executor.source.bundleCid` from. That
 * is the same raw-envelope fallback `harness.test.ts` already relies on to
 * activate Layer 2, not a test-only path, and it saves fabricating an
 * attestation that has no bearing on what this pins.
 */
async function envelopeBytesWithBundleCid(): Promise<{
  envelopeCid: string;
  envelopeBytes: Uint8Array;
  task: unknown;
}> {
  const fx = await buildGoodRestorationFixture();
  const envelope = JSON.parse(new TextDecoder().decode(fx.envelopeBytes)) as Record<
    string,
    unknown
  >;
  envelope['evidenceTier'] = 'attested';
  (envelope['executor'] as Record<string, unknown>)['source'] = { bundleCid: BUNDLE_CID };
  return {
    envelopeCid: fx.envelopeCid,
    envelopeBytes: new TextEncoder().encode(JSON.stringify(envelope)),
    task: fx.task,
  };
}

async function runWithSourceBundleFailure(cause: unknown): Promise<string[]> {
  const fx = await envelopeBytesWithBundleCid();
  fetchSourceBundleFromIpfs.mockRejectedValueOnce(failure(cause));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: { envelopeBytes: fx.envelopeBytes, task: fx.task as never },
    });
    // Control flow is unchanged: the read stays opportunistic, `ctx.sourceBundle`
    // stays undefined, and the run still produces a report.
    expect(report).toBeDefined();
    expect(fetchSourceBundleFromIpfs).toHaveBeenCalledTimes(1);
    return warn.mock.calls.map((call) => String(call[0]));
  } finally {
    warn.mockRestore();
  }
}

/** Step 3 reads `envelope.task.cid`, which survives strict parse, when `options.task` is omitted. */
async function runWithTaskFailure(cause: unknown): Promise<string[]> {
  const fx = await buildGoodRestorationFixture();
  fetchFromIpfs.mockRejectedValueOnce(failure(cause));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: { envelopeBytes: fx.envelopeBytes },
    });
    expect(report).toBeDefined();
    expect(fetchFromIpfs).toHaveBeenCalledTimes(1);
    return warn.mock.calls.map((call) => String(call[0]));
  } finally {
    warn.mockRestore();
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('conformance source bundle read visibility (#3758)', () => {
  it('names a byte-cap refusal instead of skipping silently', async () => {
    const warnings = await runWithSourceBundleFailure(
      new IpfsResponseTooLargeError(8 * 1024 * 1024),
    );
    expect(warnings.some((line) => line.includes('too-large'))).toBe(true);
  });

  it('names a blocked redirect or transport failure as unavailable', async () => {
    const warnings = await runWithSourceBundleFailure(new Error('socket hang up'));
    expect(warnings.some((line) => line.includes('unavailable'))).toBe(true);
  });

  it('stays silent when the gateway answered that it is not there', async () => {
    const warnings = await runWithSourceBundleFailure(
      new IpfsContentNotFoundError('missing', 404),
    );
    expect(warnings.filter((line) => line.startsWith('[conformance] source bundle'))).toEqual([]);
  });
});

describe('conformance task read visibility (#3758)', () => {
  it('names a byte-cap refusal instead of skipping silently', async () => {
    const warnings = await runWithTaskFailure(new IpfsResponseTooLargeError(8 * 1024 * 1024));
    expect(warnings.some((line) => line.includes('too-large'))).toBe(true);
  });

  it('stays silent when the gateway answered that it is not there', async () => {
    const warnings = await runWithTaskFailure(new IpfsContentNotFoundError('missing', 404));
    expect(warnings.filter((line) => line.startsWith('[conformance] task'))).toEqual([]);
  });
});
