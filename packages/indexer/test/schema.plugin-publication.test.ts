import { describe, it, expect } from 'vitest';
import { pluginPublication } from '../ponder.schema.js';

describe('pluginPublication entity (attd)', () => {
  it('is exported from ponder.schema.ts', () => {
    expect(pluginPublication).toBeDefined();
  });

  it('exposes the columns the handler writes to', () => {
    // Drizzle's onchainTable surface is non-trivial; assert column names via
    // the symbol table the table object exposes. The shape mirrors the §5.6
    // schema in the spec.
    const cols = Object.keys(pluginPublication as unknown as Record<string, unknown>);
    for (const name of [
      'id',
      'builderAgentId',
      'pluginCid',
      'pluginName',
      'pluginVersion',
      'pluginSha256',
      'supports',
      'publishedAt',
      'revoked',
      'revokedReason',
      'txHash',
      'blockNumber',
      'logIndex',
      'chainId',
    ]) {
      expect(cols).toContain(name);
    }
  });
});
