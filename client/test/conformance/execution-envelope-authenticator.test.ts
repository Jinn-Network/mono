import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authenticateExecutionEnvelope } from '../../src/conformance/execution-envelope-authenticator.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';

const GOLDEN_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const GOLDEN_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function goldenEnvelope(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(
        '../architecture/client-golden-envelope/golden-envelope.v0.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('authenticateExecutionEnvelope', () => {
  it('accepts the real signed golden wire envelope', async () => {
    await expect(
      authenticateExecutionEnvelope(goldenEnvelope(), 'goldenEnvelope'),
    ).resolves.toMatchObject({
      schemaVersion: 'jinn.execution.v1',
      role: 'solution',
      participant: { agentEoa: GOLDEN_SIGNER },
    });
  });

  it('rejects a payload tamper against the signed wire hash', async () => {
    const envelope = goldenEnvelope();
    envelope['payload'] = { prediction: { probability: '0.9' } };

    await expect(
      authenticateExecutionEnvelope(envelope, 'tamperedEnvelope'),
    ).rejects.toThrow(/tamperedEnvelope.*signature\.hash/i);
  });

  it('rejects a valid signature whose signer is not participant.agentEoa', async () => {
    const envelope = goldenEnvelope();
    const { signature: _signature, ...unsigned } = envelope;
    unsigned['participant'] = {
      ...(unsigned['participant'] as Record<string, unknown>),
      agentEoa: '0x0000000000000000000000000000000000000001',
    };
    const signed = await signCanonical(
      unsigned,
      GOLDEN_PRIVATE_KEY,
      GOLDEN_SIGNER,
    );

    await expect(
      authenticateExecutionEnvelope(
        {
          ...unsigned,
          signature: {
            algo: 'secp256k1',
            signer: GOLDEN_SIGNER,
            hash: signed.hash,
            sig: signed.sig,
          },
        },
        'wrongParticipant',
      ),
    ).rejects.toThrow(/wrongParticipant.*participant\.agentEoa/i);
  });
});
