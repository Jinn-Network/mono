/**
 * Trajectory reads get their own byte bound (#3441).
 *
 * #3410 capped every `fetchFromIpfs` response at 8 MiB. Trajectory span
 * attributes are truncated at 8000 characters each, but the span count is
 * unbounded, so a long run's trajectory can legitimately exceed that — and the
 * conformance call site swallows the failure, so the symptom is a silently
 * skipped trajectory check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_IPFS_RESPONSE_BYTES } from '@jinn-network/core/corpus-read';
import {
  MAX_TRAJECTORY_IPFS_RESPONSE_BYTES,
  fetchSignedEnvelopeFromIpfs,
  fetchTrajectoryFromIpfs,
} from '../../../src/adapters/mech/ipfs.js';

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

/** A JSON document whose serialized form is comfortably past the 8 MiB default. */
function oversizedJsonResponse(): Response {
  const body = JSON.stringify({ spans: 'x'.repeat(DEFAULT_MAX_IPFS_RESPONSE_BYTES + 1024) });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchTrajectoryFromIpfs byte bound (#3441)', () => {
  it('is sized above the envelope default', () => {
    expect(MAX_TRAJECTORY_IPFS_RESPONSE_BYTES).toBeGreaterThan(DEFAULT_MAX_IPFS_RESPONSE_BYTES);
  });

  it('reads a trajectory larger than the 8 MiB envelope default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => oversizedJsonResponse()));

    const trajectory = await fetchTrajectoryFromIpfs('https://gw.example', CID, {
      fallbackGatewayBase: false,
    });
    expect((trajectory as { spans: string }).spans.length).toBe(
      DEFAULT_MAX_IPFS_RESPONSE_BYTES + 1024,
    );
  });

  it('leaves the envelope reader on the 8 MiB default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => oversizedJsonResponse()));

    await expect(
      fetchSignedEnvelopeFromIpfs('https://gw.example', CID, { fallbackGatewayBase: false }),
    ).rejects.toThrow(/exceeds the 8388608-byte cap/);
  });

  it('still lets an explicit caller bound win', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => oversizedJsonResponse()));

    await expect(
      fetchTrajectoryFromIpfs('https://gw.example', CID, {
        fallbackGatewayBase: false,
        maxResponseBytes: 1024,
      }),
    ).rejects.toThrow(/exceeds the 1024-byte cap/);
  });
});
