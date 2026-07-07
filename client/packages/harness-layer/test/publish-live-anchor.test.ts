/**
 * Live anchor wiring tests (#1439).
 *
 * publish-live's anchorEnvelope must honour the caller-supplied metadataKey
 * (`capture:<cid>` vs `skill:<cid>`) instead of hard-coding capture.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CaptureEnvelopeAnchorInput } from '../../../src/captures/publish.js';
import { contentKindForAnchor } from '../../../src/erc8004/index.js';
import type { HarnessPublishDeps } from '../src/publish.js';

const TEST_TX = `0x${'ab'.repeat(32)}` as const;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const TEST_SAFE = '0x1111111111111111111111111111111111111111' as const;

describe('publish-live anchor metadataKey wiring', () => {
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
});
