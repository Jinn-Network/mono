/**
 * Unit tests for the keyless, filesystem-neutral artifact retrieval primitive
 * (issue #4179).
 *
 * Both network legs are injected through the primitive's `deps` seam, so no
 * module is mocked here.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  fetchVerifiedArtifact,
  verifyArtifactDigest,
} from '../src/corpus-read/artifact-retrieval.js';
import type { AcquireResult } from '../src/corpus-read/fetch-artifact.js';
import {
  IpfsContentNotFoundError,
  IpfsFetchFailedError,
  IpfsResponseTooLargeError,
} from '../src/corpus-read/ipfs.js';
import type { ArtifactSource } from '../src/corpus-read/types.js';

const BYTES = Buffer.from('artifact-bytes', 'utf-8');
const SHA = createHash('sha256').update(BYTES).digest('hex');
const GATEWAY = 'https://gateway.example.com';
const ENDPOINT = 'https://op.example.com';
const OWNER = `0x${'a'.repeat(40)}`;

function ipfsSources(cid = 'bafy-donated', sha256 = SHA): ArtifactSource[] {
  return [{ kind: 'ipfs', cid, sha256, encoding: 'jinn.artifact.donation.v1' }];
}

function donation(bytes: Buffer, sha256 = SHA): Record<string, unknown> {
  return {
    schemaVersion: 'jinn.artifact.donation.v1',
    artifactType: 'design_document',
    sha256,
    encoding: 'jinn.artifact.donation.v1',
    data: bytes.toString('base64'),
  };
}

/** Recursively look for a Buffer anywhere on a value. */
function containsBuffer(value: unknown, seen = new Set<unknown>()): boolean {
  if (Buffer.isBuffer(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((v) => containsBuffer(v, seen));
}

describe('verifyArtifactDigest', () => {
  it('accepts bytes that hash to the expected address', () => {
    expect(verifyArtifactDigest(SHA, BYTES)).toEqual({ ok: true });
  });

  it('reports the actual digest on mismatch', () => {
    const wrong = Buffer.from('not what was promised');
    const result = verifyArtifactDigest(SHA, wrong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.actualSha256).toBe(createHash('sha256').update(wrong).digest('hex'));
    }
  });

  it('hashes an empty buffer rather than short-circuiting it', () => {
    const empty = Buffer.alloc(0);
    const emptySha = createHash('sha256').update(empty).digest('hex');
    expect(verifyArtifactDigest(emptySha, empty)).toEqual({ ok: true });
    const mismatch = verifyArtifactDigest(SHA, empty);
    expect(mismatch).toEqual({ ok: false, actualSha256: emptySha });
  });
});

describe('fetchVerifiedArtifact', () => {
  it('verifies and returns bytes from the origin leg with provenance', async () => {
    const fetchArtifact = vi.fn(
      async (): Promise<AcquireResult> => ({ ok: true, content: BYTES }),
    );
    const result = await fetchVerifiedArtifact(
      { sha256: SHA, artifactType: 'design_document' },
      { endpoint: ENDPOINT, ownerSafe: OWNER, envelopeCid: 'bafyEnv' },
      { deps: { fetchArtifact, now: () => '2026-09-09T00:00:00.000Z' } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.bytes.equals(BYTES)).toBe(true);
    expect(result.artifact.sha256).toBe(SHA);
    expect(result.artifact.artifactType).toBe('design_document');
    expect(result.artifact.provenance).toMatchObject({
      source: 'origin',
      sourceUri: `${ENDPOINT}/v1/artifacts/${SHA}/content`,
      digestAlgorithm: 'sha256',
      fetchedAt: '2026-09-09T00:00:00.000Z',
      sourceOperator: OWNER,
      envelopeCid: 'bafyEnv',
    });
    expect(result.artifact.provenance.attempts).toEqual([
      { leg: 'ipfs', sourceUri: '', outcome: 'skipped' },
      {
        leg: 'origin',
        sourceUri: `${ENDPOINT}/v1/artifacts/${SHA}/content`,
        outcome: 'verified',
      },
    ]);
    expect(fetchArtifact).toHaveBeenCalledOnce();
  });

  it('prefers the donated IPFS leg and never reaches origin', async () => {
    const fetchArtifact = vi.fn();
    const fetchFromIpfs = vi.fn(async () => donation(BYTES));
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
      { deps: { fetchArtifact, fetchFromIpfs } },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.provenance.source).toBe('ipfs');
    expect(result.artifact.provenance.sourceUri).toBe('ipfs://bafy-donated');
    expect(result.artifact.bytes.equals(BYTES)).toBe(true);
    // The seam takes exactly two arguments: existing fakes assert on the
    // recorded argument array, where a trailing `undefined` is a third entry.
    expect(fetchFromIpfs).toHaveBeenCalledWith(GATEWAY, 'bafy-donated');
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it('fails closed on a digest mismatch and returns no bytes at all', async () => {
    const wrong = Buffer.from('wrong bytes');
    const fetchArtifact = vi.fn(
      async (): Promise<AcquireResult> => ({ ok: true, content: wrong }),
    );
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { endpoint: ENDPOINT, ownerSafe: OWNER },
      { deps: { fetchArtifact } },
    );

    expect(result.ok).toBe(false);
    expect('artifact' in result).toBe(false);
    expect(containsBuffer(result)).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('digest_mismatch');
    expect(result.retryable).toBe(false);
    expect(result.mismatch).toEqual({
      expectedSha256: SHA,
      actualSha256: createHash('sha256').update(wrong).digest('hex'),
      sourceUri: `${ENDPOINT}/v1/artifacts/${SHA}/content`,
      sourceOperator: OWNER,
    });
  });

  it('does not fall through to origin after an IPFS digest mismatch', async () => {
    const fetchArtifact = vi.fn();
    const fetchFromIpfs = vi.fn(async () => donation(Buffer.from('poisoned mirror')));
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT, ownerSafe: OWNER },
      { deps: { fetchArtifact, fetchFromIpfs } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('digest_mismatch');
    expect(result.mismatch?.sourceUri).toBe('ipfs://bafy-donated');
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it('treats a malformed donation payload as a failed leg, not a mismatch', async () => {
    const fetchArtifact = vi.fn(
      async (): Promise<AcquireResult> => ({ ok: true, content: BYTES }),
    );
    const cases: unknown[] = [
      { ...donation(BYTES), encoding: 'something.else' },
      { ...donation(BYTES), sha256: 'f'.repeat(64) },
      { schemaVersion: 'jinn.artifact.donation.v1', encoding: 'jinn.artifact.donation.v1', sha256: SHA },
    ];

    for (const payload of cases) {
      fetchArtifact.mockClear();
      const result = await fetchVerifiedArtifact(
        { sha256: SHA },
        { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
        { deps: { fetchArtifact, fetchFromIpfs: async () => payload } },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.artifact.provenance.source).toBe('origin');
      expect(result.artifact.provenance.attempts[0]).toMatchObject({
        leg: 'ipfs',
        outcome: 'failed',
        reason: 'unavailable',
      });
      expect(fetchArtifact).toHaveBeenCalledOnce();
    }
  });

  it('records an IPFS size refusal as too_large and still falls through (#3441)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchArtifact = vi.fn(
      async (): Promise<AcquireResult> => ({ ok: true, content: BYTES }),
    );
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
      {
        deps: {
          fetchArtifact,
          fetchFromIpfs: async () => {
            throw new IpfsFetchFailedError('gateway refused', [
              new IpfsResponseTooLargeError(8 * 1024 * 1024),
            ]);
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.provenance.attempts[0]).toMatchObject({
      leg: 'ipfs',
      outcome: 'failed',
      reason: 'too_large',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/too-large/);
    warn.mockRestore();
  });

  it('does not warn when the IPFS gateway answered a plain absence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY },
      {
        deps: {
          fetchFromIpfs: async () => {
            throw new IpfsFetchFailedError('missing', [new IpfsContentNotFoundError('missing', 404)]);
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports not_found only when every attempted leg answered absent', async () => {
    const bothAbsent = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
      {
        deps: {
          fetchFromIpfs: async () => {
            throw new IpfsFetchFailedError('missing', [new IpfsContentNotFoundError('missing', 404)]);
          },
          fetchArtifact: async (): Promise<AcquireResult> => ({ ok: false, reason: 'not_found' }),
        },
      },
    );
    expect(bothAbsent.ok).toBe(false);
    if (bothAbsent.ok) return;
    expect(bothAbsent.reason).toBe('not_found');
    expect(bothAbsent.retryable).toBe(false);
  });

  it('never reports not_found when a leg failed inconclusively', async () => {
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
      {
        deps: {
          fetchFromIpfs: async () => {
            throw new IpfsFetchFailedError('missing', [new IpfsContentNotFoundError('missing', 404)]);
          },
          fetchArtifact: async (): Promise<AcquireResult> => ({ ok: false, reason: 'timeout' }),
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('reports the last inconclusive leg when more than one fails inconclusively', async () => {
    // Pins the tie-break rule: legs run cheapest-first, so the last one to
    // answer is the artifact's actual home and its reason is the actionable
    // one. Here IPFS refuses on size and the origin then times out — the
    // reported reason is the origin's, not the mirror's.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fetchVerifiedArtifact(
      { sha256: SHA },
      { sources: ipfsSources(), ipfsGatewayUrl: GATEWAY, endpoint: ENDPOINT },
      {
        deps: {
          fetchFromIpfs: async () => {
            throw new IpfsFetchFailedError('gateway refused', [
              new IpfsResponseTooLargeError(8 * 1024 * 1024),
            ]);
          },
          fetchArtifact: async (): Promise<AcquireResult> => ({ ok: false, reason: 'timeout' }),
        },
      },
    );
    warn.mockRestore();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts.map((attempt) => attempt.reason)).toEqual(['too_large', 'timeout']);
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('names the missing gateway when donated sources have nowhere to be read from', async () => {
    const result = await fetchVerifiedArtifact({ sha256: SHA }, { sources: ipfsSources() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_locator');
    // The old message claimed there was no donated source at all, which is
    // false here — there is one, with no gateway to read it through.
    expect(result.message).not.toContain('no donated IPFS source');
    expect(result.message).toContain('no gateway URL');
  });

  it('reports no_locator when nothing was supplied to try', async () => {
    const result = await fetchVerifiedArtifact({ sha256: SHA }, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_locator');
    expect(result.retryable).toBe(false);
    expect(result.attempts).toEqual([
      { leg: 'ipfs', sourceUri: '', outcome: 'skipped' },
      { leg: 'origin', sourceUri: '', outcome: 'skipped' },
    ]);
  });

  it('maps every origin failure reason to its retryable disposition', async () => {
    const table: Array<[AcquireResult & { ok: false }, string, boolean]> = [
      [{ ok: false, reason: 'not_found' }, 'not_found', false],
      [{ ok: false, reason: 'blocked' }, 'blocked', false],
      [{ ok: false, reason: 'too_large' }, 'too_large', false],
      [{ ok: false, reason: 'timeout' }, 'timeout', true],
      [{ ok: false, reason: 'network_error' }, 'unavailable', true],
    ];
    for (const [outcome, reason, retryable] of table) {
      const result = await fetchVerifiedArtifact(
        { sha256: SHA },
        { endpoint: ENDPOINT },
        { deps: { fetchArtifact: async () => outcome } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(reason);
      expect(result.retryable).toBe(retryable);
    }
  });

  it('never lets the declared artifactType influence admission', async () => {
    const fetchArtifact = async (): Promise<AcquireResult> => ({ ok: true, content: BYTES });
    const labeled = await fetchVerifiedArtifact(
      { sha256: SHA, artifactType: 'a-label-that-is-wrong' },
      { endpoint: ENDPOINT },
      { deps: { fetchArtifact } },
    );
    const unlabeled = await fetchVerifiedArtifact(
      { sha256: SHA },
      { endpoint: ENDPOINT },
      { deps: { fetchArtifact } },
    );
    expect(labeled.ok).toBe(true);
    expect(unlabeled.ok).toBe(true);
    if (!labeled.ok || !unlabeled.ok) return;
    expect(labeled.artifact.artifactType).toBe('a-label-that-is-wrong');
    expect(unlabeled.artifact.artifactType).toBe('unknown');
    expect(labeled.artifact.bytes.equals(unlabeled.artifact.bytes)).toBe(true);
  });
});

describe('fetchVerifiedArtifact production default transport', () => {
  it('binds the destination-guarded origin fetch when no deps are supplied', async () => {
    // Every other test here replaces the origin leg through `deps`, so nothing
    // exercised the default binding: swapping it for a bare `fetch` would leave
    // the suite green and ship a live SSRF. This call passes no `deps` at all.
    //
    // Hermetic by construction rather than by hope: 169.254.169.254 is an IPv4
    // literal, so `resolvePublicHttpDestination` classifies it as link-local
    // from parsing alone and throws before any DNS lookup or socket. Host
    // resolver behavior cannot change the outcome. The private-origin hatch is
    // stubbed off so an operator env cannot open the guard under test.
    vi.stubEnv('JINN_CORPUS_ALLOW_PRIVATE_ORIGINS', '');
    try {
      const result = await fetchVerifiedArtifact(
        { sha256: SHA },
        { endpoint: 'http://169.254.169.254' },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('blocked');
      expect(result.retryable).toBe(false);
      expect(result.attempts).toEqual([
        { leg: 'ipfs', sourceUri: '', outcome: 'skipped' },
        {
          leg: 'origin',
          sourceUri: `http://169.254.169.254/v1/artifacts/${SHA}/content`,
          outcome: 'failed',
          reason: 'blocked',
          message: expect.stringContaining('link-local'),
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
