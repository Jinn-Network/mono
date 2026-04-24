import { describe, it, expect, vi } from 'vitest';
import { ValidationRegistry8004 } from '../../src/validation/registry.js';

describe('ValidationRegistry8004.submitValidationRequest', () => {
  it('encodes entityUri + requestUri into the contract call', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({
      blockNumber: 500n,
      logs: [
        {
          topics: [
            // event signature hash (ValidationRequestCreated)
            '0x' + 'aa'.repeat(32),
            // indexed requestId
            '0x' + '11'.repeat(32),
          ],
        },
      ],
    });
    const registry = new ValidationRegistry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    const result = await registry.submitValidationRequest({
      envelopeCid: 'bafy-env',
      requestType: 'attestation-verify',
      requestUri: 'ipfs://bafy-request',
    });

    expect(result.txHash).toBe('0xtx');
    expect(writeMock).toHaveBeenCalledTimes(1);
    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('createValidationRequest');
    expect(args.args[0]).toBe('envelope:bafy-env');
    expect(args.args[1]).toBe('ipfs://bafy-request');
  });
});

describe('ValidationRegistry8004.submitValidationResponse', () => {
  it('calls createValidationResponse with requestId + responseUri', async () => {
    const writeMock = vi.fn().mockResolvedValue('0xtx');
    const waitMock = vi.fn().mockResolvedValue({ blockNumber: 501n });
    const registry = new ValidationRegistry8004({
      chainId: 'eip155:84532',
      contractAddress: '0x' + '00'.repeat(20),
      privateKey: '0x' + '11'.repeat(32),
    });
    (registry as any).walletClient = { writeContract: writeMock };
    (registry as any).publicClient = { waitForTransactionReceipt: waitMock };

    await registry.submitValidationResponse({
      requestId: 123n,
      responseUri: 'ipfs://bafy-response',
    });

    const args = writeMock.mock.calls[0]![0];
    expect(args.functionName).toBe('createValidationResponse');
    expect(args.args[0]).toBe(123n);
    expect(args.args[1]).toBe('ipfs://bafy-response');
  });
});
