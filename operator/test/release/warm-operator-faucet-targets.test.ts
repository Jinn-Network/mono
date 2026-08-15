import { describe, it, expect } from 'vitest';
import { resolveFaucetTargets } from '../../scripts/release/warm-operator-preflight.js';

describe('resolveFaucetTargets — #1018 fleet faucet self-heal', () => {
  it('fleet shape: resolves agent from services[0] + Safe from fleet_safe_address (no top-level fields)', () => {
    // The exact shape that broke before: a fleet op has master_address +
    // fleet_safe_address + services[0].agent_address, but NO top-level
    // agent_address / safe_address — so the old reader skipped agent + USDC.
    expect(
      resolveFaucetTargets({
        master_address: '0xMASTER',
        fleet_safe_address: '0xFLEETSAFE',
        services: [{ agent_address: '0xAGENT', safe_address: '0xFLEETSAFE' }],
      }),
    ).toEqual({ master: '0xMASTER', agent: '0xAGENT', safe: '0xFLEETSAFE' });
  });

  it('legacy shape: uses top-level agent_address + safe_address', () => {
    expect(
      resolveFaucetTargets({ master_address: '0xM', agent_address: '0xA', safe_address: '0xS' }),
    ).toEqual({ master: '0xM', agent: '0xA', safe: '0xS' });
  });

  it('prefers fleet_safe_address over a service safe and a stale top-level safe', () => {
    expect(
      resolveFaucetTargets({
        master_address: '0xM',
        safe_address: '0xSTALE',
        fleet_safe_address: '0xFLEET',
        services: [{ safe_address: '0xSVC' }],
      }).safe,
    ).toBe('0xFLEET');
  });

  it('returns undefined targets when nothing resolves (no wrong-address drip)', () => {
    expect(resolveFaucetTargets({})).toEqual({ master: undefined, agent: undefined, safe: undefined });
  });
});
