import { describe, expect, it } from 'vitest';
import { formatRpcError } from '../src/rpc-error-context.js';

describe('formatRpcError', () => {
  it('adds operation, rpc host, chain, contract, block range, and cause', () => {
    const error = new Error('Version: viem@2.48.4 | RPC Request failed.');
    const formatted = formatRpcError(error, {
      operation: 'getLogs',
      chain: 'base-sepolia',
      rpcUrl: 'https://user:secret@sepolia.base.org/path',
      contract: '0xabc',
      fromBlock: 10n,
      toBlock: 20n,
    });

    expect(formatted).toContain('operation=getLogs');
    expect(formatted).toContain('chain=base-sepolia');
    expect(formatted).toContain('rpc=sepolia.base.org');
    expect(formatted).toContain('contract=0xabc');
    expect(formatted).toContain('blocks=10..20');
    expect(formatted).toContain('RPC Request failed');
    expect(formatted).not.toContain('secret');
  });
});
