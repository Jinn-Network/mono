/**
 * A skipped trajectory check must say why (#3441).
 *
 * The harness swallows every trajectory read failure and leaves
 * `ctx.trajectory` undefined, so the report shows the same skipped checks
 * whether the trajectory is genuinely not on IPFS or the byte cap refused it.
 * Only genuine absence is silent now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IpfsContentNotFoundError,
  IpfsFetchFailedError,
  IpfsResponseTooLargeError,
} from '@jinn-network/core/corpus-read';

const fetchTrajectoryFromIpfs = vi.fn();

vi.mock('../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  normalizeIpfsRegistryAddUrl: vi.fn((url: string) => url),
  cidToDigestHex: vi.fn().mockReturnValue('0x' + 'de'.repeat(32)),
  digestHexToGatewayUrl: vi.fn((hex: string) => `https://gateway.autonolas.tech/ipfs/${hex}`),
  fetchFromIpfs: vi.fn(),
  fetchTrajectoryFromIpfs,
  fetchSignedEnvelopeBytesRaw: vi.fn(),
  fetchSignedEnvelopeFromIpfs: vi.fn(),
  fetchSourceBundleFromIpfs: vi.fn(),
}));

const { runConformance } = await import('../../src/conformance/harness.js');
const { buildGoodRestorationFixture } = await import('./fixtures/good-envelope.js');

async function runWithTrajectoryFailure(cause: unknown): Promise<string[]> {
  const fx = await buildGoodRestorationFixture();
  fetchTrajectoryFromIpfs.mockRejectedValueOnce(
    new IpfsFetchFailedError('IPFS JSON fetch failed after all candidates', [cause]),
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const report = await runConformance({
      envelopeCid: fx.envelopeCid,
      options: { envelopeBytes: fx.envelopeBytes, task: fx.task },
    });
    // Control flow is unchanged: the read stays opportunistic and the run
    // still produces a report.
    expect(report).toBeDefined();
    return warn.mock.calls.map((call) => String(call[0]));
  } finally {
    warn.mockRestore();
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('conformance trajectory read visibility (#3441)', () => {
  it('names a byte-cap refusal instead of skipping silently', async () => {
    const warnings = await runWithTrajectoryFailure(
      new IpfsResponseTooLargeError(8 * 1024 * 1024),
    );
    expect(warnings.some((line) => line.includes('too-large'))).toBe(true);
  });

  it('names a transport failure as unavailable', async () => {
    const warnings = await runWithTrajectoryFailure(new Error('socket hang up'));
    expect(warnings.some((line) => line.includes('unavailable'))).toBe(true);
  });

  it('stays silent when the gateway answered that it is not there', async () => {
    const warnings = await runWithTrajectoryFailure(
      new IpfsContentNotFoundError('missing', 404),
    );
    expect(warnings.filter((line) => line.startsWith('[conformance] trajectory'))).toEqual([]);
  });
});
