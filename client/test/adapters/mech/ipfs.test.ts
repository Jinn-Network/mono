import { describe, it, expect } from 'vitest';
import { buildDesiredStatePayload, parseDesiredStateFromPayload, cidToDigestHex, digestHexToGatewayUrl } from '../../../src/adapters/mech/ipfs.js';

describe('IPFS utilities', () => {
  it('serializes a desired state to IPFS payload', () => {
    const payload = buildDesiredStatePayload({
      id: 'ds-1',
      description: 'Test state',
      context: { key: 'value' },
    });
    expect(payload.description).toBe('Test state');
    expect(payload.desiredStateId).toBe('ds-1');
    expect(payload.context).toEqual({ key: 'value' });
  });

  it('deserializes an IPFS payload back to a desired state', () => {
    const payload = { desiredStateId: 'ds-1', description: 'Test', context: { key: 'value' } };
    const state = parseDesiredStateFromPayload(payload);
    expect(state.id).toBe('ds-1');
    expect(state.description).toBe('Test');
  });

  it('round-trips a portfolio.v0 intent through JSON with spec/window/eligibility intact', () => {
    const intent = {
      id: 'portfolio-v0-roundtrip',
      description: 'Grow HL testnet portfolio 5% in 24h with 10% max drawdown.',
      window: { startTs: 1_776_495_469_000, endTs: 1_776_581_869_000 },
      spec: {
        kind: 'portfolio.v0',
        account: {
          venue: 'hyperliquid-testnet',
          masterAddress: '0xc7B5aB63dfd2B1d8b7CD1761465aFB316aFA03dF',
        },
        target: { metric: 'equity_return_pct', minReturnPct: 5.0 },
        constraint: { maxDrawdownPct: 10.0 },
      },
      eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
    };

    const payload = buildDesiredStatePayload(intent);
    expect(payload.spec).toEqual(intent.spec);
    expect(payload.window).toEqual(intent.window);
    expect(payload.eligibility).toEqual(intent.eligibility);

    // Full JSON round-trip — what actually happens on the IPFS wire.
    const roundTripped = parseDesiredStateFromPayload(
      JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    );

    expect(roundTripped.id).toBe(intent.id);
    expect(roundTripped.description).toBe(intent.description);
    expect(roundTripped.spec).toEqual(intent.spec);
    expect(roundTripped.window).toEqual(intent.window);
    expect(roundTripped.eligibility).toEqual(intent.eligibility);
    expect((roundTripped.spec as { kind: string }).kind).toBe('portfolio.v0');
    expect(roundTripped.window?.endTs! - roundTripped.window?.startTs!).toBe(86_400_000);
  });

  it('parses a legacy payload (no spec/window/eligibility) with those fields undefined', () => {
    const legacyPayload = {
      desiredStateId: 'legacy-health-check',
      description: 'The service is running.',
      type: 'restoration' as const,
      attemptId: 'legacy-health-check/1',
      attemptNumber: 1,
    };

    const state = parseDesiredStateFromPayload(legacyPayload);
    expect(state.id).toBe('legacy-health-check');
    expect(state.attemptNumber).toBe(1);
    expect(state.spec).toBeUndefined();
    expect(state.window).toBeUndefined();
    expect(state.eligibility).toBeUndefined();
  });

  it('extracts a 32-byte SHA256 digest from a CIDv0', () => {
    // CIDv0: QmYwAPJzv5CZsnN625s3Xf2nemtYgPpHdWEz79ojWnPbdG
    // This is a well-known IPFS CID (empty directory)
    const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
    const digest = cidToDigestHex(cid);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest.length).toBe(66); // 0x + 64 hex chars = 32 bytes
  });

  it('constructs a gateway URL from a digest hex', () => {
    const digest = '0x' + 'ab'.repeat(32);
    const url = digestHexToGatewayUrl(digest);
    expect(url).toBe('https://gateway.autonolas.tech/ipfs/f01551220' + 'ab'.repeat(32));
  });

  it('constructs a gateway URL without 0x prefix', () => {
    const digest = 'cd'.repeat(32);
    const url = digestHexToGatewayUrl(digest);
    expect(url).toBe('https://gateway.autonolas.tech/ipfs/f01551220' + 'cd'.repeat(32));
  });
});
