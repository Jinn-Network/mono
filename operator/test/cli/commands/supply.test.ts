import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSupplyCommand } from '@/cli/commands/supply.js';
import { runCommand } from '@test/cli.js';

const WINDOW = {
  start: '2026-09-04T12:00:00.000Z',
  end: '2026-09-06T12:00:00.000Z',
  bucketHours: 6,
  buckets: Array.from({ length: 8 }, (_, index) => ({
    start: new Date(Date.parse('2026-09-04T12:00:00.000Z') + index * 6 * 3_600_000).toISOString(),
    end: new Date(Date.parse('2026-09-04T18:00:00.000Z') + index * 6 * 3_600_000).toISOString(),
  })),
};

function commandWith(response: Record<string, unknown>, network: 'testnet' | 'mainnet' = 'testnet') {
  const loadConfig = vi.fn(() => ({
    network,
    discovery: { mode: 'http', url: 'https://indexer.example' },
  }));
  const getCurrentSupply = vi.fn(async () => response as never);
  return {
    loadConfig,
    getCurrentSupply,
    command: createSupplyCommand({
      loadConfig: loadConfig as never,
      getConfigPathFromArgs: () => undefined,
      createDiscoveryClient: () => ({ getCurrentSupply }) as never,
    }),
  };
}

describe('jinn supply', () => {
  it('defaults to JSON and runs before wallet or MCP setup from default config', async () => {
    const response = {
      schemaVersion: 1,
      status: 'available',
      chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z',
      window: WINDOW,
      classes: [{
        workClass: 'prediction.v1', contractId: 'prediction', contractVersion: 'v1',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    };
    const deps = commandWith(response);
    const { envelopes, exits } = await runCommand(deps.command);
    expect(exits).toEqual([]);
    expect(envelopes).toEqual([response]);
    expect(deps.loadConfig).toHaveBeenCalledWith(undefined);
    expect(deps.getCurrentSupply).toHaveBeenCalledWith({ chainId: 84532 });
  });

  it('renders proven zero explicitly and advises against posting', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'zero_supply', reason: 'no_recent_completed_loops',
      chainId: 84532, generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW, classes: [],
    });
    const { raw, exits } = await runCommand(deps.command, { argv: ['--human'] });
    expect(exits).toEqual([]);
    expect(raw.join('')).toContain('No proven live supply');
    expect(raw.join('')).toContain('Do not post work in this class yet.');
  });

  it('renders unknown without calling it zero', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'unknown', reason: 'incomplete_indexer_evidence',
      chainId: 84532, generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW, classes: [],
    });
    const { raw } = await runCommand(deps.command, { argv: ['--human'] });
    expect(raw.join('')).toContain('Supply could not be determined');
    expect(raw.join('')).not.toContain('No proven live supply');
  });

  it('passes --config without loading wallet or daemon state', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'zero_supply', reason: 'no_requestable_solver_nets',
      chainId: 84532, generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW, classes: [],
    });
    await runCommand(deps.command, { argv: ['--config', '/tmp/jinn.json'] });
    expect(deps.loadConfig).toHaveBeenCalledWith('/tmp/jinn.json');
  });

  it('derives the chain ID from the lightweight network config', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'zero_supply', reason: 'no_requestable_solver_nets',
      chainId: 8453, generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW, classes: [],
    }, 'mainnet');
    await runCommand(deps.command);
    expect(deps.getCurrentSupply).toHaveBeenCalledWith({ chainId: 8453 });
  });

  it('keeps the command dependency boundary config-and-HTTP only', () => {
    const source = readFileSync(new URL('../../../src/cli/commands/supply.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:wallet|daemon|mcp|store|chain-client|viem)/iu);
  });
});
