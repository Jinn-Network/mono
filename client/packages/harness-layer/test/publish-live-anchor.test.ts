/**
 * Live anchor wiring tests (#1439).
 *
 * publish-live's anchorEnvelope must honour the caller-supplied metadataKey
 * (`capture:<cid>` vs `skill:<cid>`) instead of hard-coding capture.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { CaptureEnvelopeAnchorInput } from '../../../src/captures/publish.js';
import { contentKindForAnchor } from '../../../src/erc8004/index.js';
import type { HarnessPublishDeps } from '../src/publish.js';
import {
  createLivePublishDeps,
  DEFAULT_TESTNET_IDENTITY_REGISTRY,
} from '../src/publish-live.js';
import { rawSha256Cid } from '../src/ipfs-cid.js';

const TEST_TX = `0x${'ab'.repeat(32)}` as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

describe('publish-live anchor metadataKey wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('contentKindForAnchor maps skill metadata keys to skill', () => {
    const cid = 'bafyskill-envelope';
    expect(contentKindForAnchor(`skill:${cid}`, cid)).toBe('skill');
    expect(contentKindForAnchor(`capture:${cid}`, cid)).toBe('capture');
  });

  it('anchorEnvelope forwards skill metadataKey to publishContentV2 kind', async () => {
    const publishContentV2 = vi.fn().mockResolvedValue({ txHash: TEST_TX, blockNumber: 42 });
    const envelopeCid = 'bafyskill-envelope';
    const metadataKey = `skill:${envelopeCid}`;

    const deps: HarnessPublishDeps = {
      participant: { safeAddress: TEST_SAFE, agentEoa: TEST_ADDRESS },
      signer: { address: TEST_ADDRESS },
      clientGitSha: 'test-sha',
      defaultArtifactEndpoint: 'http://127.0.0.1:7331',
      ledger: { append: vi.fn(), list: () => [] },
      publishArtifact: vi.fn(),
      publishEnvelope: vi.fn(),
      anchorEnvelope: async (input) => {
        const kind = contentKindForAnchor(input.metadataKey, input.envelopeCid);
        await publishContentV2({ kind, cid: input.envelopeCid, payload: {} });
        return { txHash: TEST_TX, blockNumber: 42 };
      },
    };

    await deps.anchorEnvelope({
      metadataKey,
      envelopeCid,
      envelopeHash: `0x${'f'.repeat(64)}`,
      envelope: {} as CaptureEnvelopeAnchorInput['envelope'],
    });

    expect(publishContentV2).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'skill', cid: envelopeCid }),
    );
  });

  it('binds durable manifest recovery to the live chain, registry, and agent', () => {
    const deps = createLivePublishDeps({
      privateKey:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      safeAddress: TEST_SAFE,
      agentId: 42n,
    });

    expect(deps.manifestPublicationScope).toEqual({
      chainId: 84532,
      identityRegistryAddress: DEFAULT_TESTNET_IDENTITY_REGISTRY,
      agentId: '42',
    });
  });

  it('reconciles a manifest upload intent only when exact raw bytes are present', async () => {
    const bodyBytes = new TextEncoder().encode('{"manifest":"exact"}');
    const expectedCid = rawSha256Cid(bodyBytes);
    const fetchMock = vi.fn(async () =>
      new Response(bodyBytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const deps = createLivePublishDeps({
      privateKey:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      safeAddress: TEST_SAFE,
      agentId: 42n,
      ipfsGatewayUrl: 'https://gateway.test',
    });

    await expect(
      deps.reconcileManifestBody?.(expectedCid, bodyBytes),
    ).resolves.toEqual({ status: 'present' });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://gateway.test/ipfs/${expectedCid}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('treats gateway absence and read failures as unknown, never authoritative absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not found', { status: 404 })),
    );
    const deps = createLivePublishDeps({
      privateKey:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      safeAddress: TEST_SAFE,
      agentId: 42n,
    });
    const bodyBytes = new TextEncoder().encode('{"manifest":"missing"}');

    await expect(
      deps.reconcileManifestBody?.(rawSha256Cid(bodyBytes), bodyBytes),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/gateway|fetch|404/i),
    });
  });

  it('treats a gateway byte mismatch as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('different bytes', { status: 200 })),
    );
    const deps = createLivePublishDeps({
      privateKey:
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      safeAddress: TEST_SAFE,
      agentId: 42n,
    });
    const bodyBytes = new TextEncoder().encode('{"manifest":"expected"}');

    await expect(
      deps.reconcileManifestBody?.(rawSha256Cid(bodyBytes), bodyBytes),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: expect.stringMatching(/exact|mismatch/i),
    });
  });
});
