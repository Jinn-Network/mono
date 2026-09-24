import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSupplyCommand } from '@/cli/commands/supply.js';
import { DiscoveryUnavailableError } from '@/discovery-client/types.js';
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

  it('warns that the class list is short when the indexer excluded manifest rows', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'available', chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW,
      incompleteManifestRows: 2,
      classes: [{
        workClass: 'prediction.v1', contractId: 'prediction', contractVersion: 'v1',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    });
    const { raw } = await runCommand(deps.command, { argv: ['--human'] });
    // Without this the reader takes the list as exhaustive and reads a missing
    // class as absent supply — the exact misreading the marker exists to stop.
    expect(raw.join('')).toContain('2 launched SolverNet(s) had incomplete indexer evidence');
    expect(raw.join('')).toContain('unproven, not absent');
  });

  it('says nothing about excluded rows when the indexer excluded none', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'available', chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW,
      classes: [{
        workClass: 'prediction.v1', contractId: 'prediction', contractVersion: 'v1',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    });
    const { raw } = await runCommand(deps.command, { argv: ['--human'] });
    expect(raw.join('')).not.toContain('incomplete indexer evidence');
  });

  it('warns that the class list is short when the indexer skipped activity rows', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'available', chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW,
      incompleteActivityRows: 3,
      classes: [{
        workClass: 'prediction.v1', contractId: 'prediction', contractVersion: 'v1',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    });
    const { raw } = await runCommand(deps.command, { argv: ['--human'] });
    expect(raw.join('')).toContain('3 activity row(s) had no matching task');
    expect(raw.join('')).toContain('unproven, not absent');
  });

  it('says nothing about skipped activity when the indexer skipped none', async () => {
    const deps = commandWith({
      schemaVersion: 1, status: 'available', chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW,
      classes: [{
        workClass: 'prediction.v1', contractId: 'prediction', contractVersion: 'v1',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    });
    const { raw } = await runCommand(deps.command, { argv: ['--human'] });
    expect(raw.join('')).not.toContain('no matching task');
  });

  it('strips C0, DEL, C1, CR, and an ESC-prefixed CSI sequence from human class lines, leaving JSON untouched', async () => {
    // #4236 requires a bare carriage return and an ESC-prefixed escape
    // sequence alongside BEL/DEL/C1 — a CSI "erase line" is the kind of
    // sequence a hostile contractId could use to rewrite the operator's
    // terminal line. \u001B is itself in the stripped C0 range, so once it is
    // removed the trailing "[2K" is inert printable text, not a live escape.
    const workClass = 'pred\u0007iction\u007F\r.\u009Bv1\u001b[2K';
    const response = {
      schemaVersion: 1, status: 'available', chainId: 84532,
      generatedAt: '2026-09-06T13:47:00.000Z', window: WINDOW,
      classes: [{
        workClass, contractId: 'pred\u0007iction\r', contractVersion: '\u009Bv1\u001b[2K',
        acceptingSolverNets: 1, claimingOperators: 2, verdictDeliveries: 3,
        latestAttemptAt: '2026-09-06T10:00:00.000Z',
        latestVerdictAt: '2026-09-06T11:00:00.000Z',
      }],
    };
    const human = commandWith(response);
    const { raw } = await runCommand(human.command, { argv: ['--human'] });
    const text = raw.join('');
    // Stripping removes the control BYTES, not a whole escape sequence: ESC
    // is a C0 byte and is removed, but the "[2K" it introduced is ordinary
    // printable text that survives — inert (no live escape reaches the
    // terminal) rather than invisible.
    const sanitizedWorkClass = 'prediction.v1[2K';
    expect(text).toContain(`${sanitizedWorkClass}:`);
    const classLine = text.split('\n').find((line) => line.includes(`${sanitizedWorkClass}:`));
    expect(classLine).toBeDefined();
    expect(classLine).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/u);

    const json = commandWith(response);
    const { envelopes } = await runCommand(json.command);
    expect(envelopes[0]).toMatchObject({ classes: [{ workClass }] });
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

  it('maps invalid_request to invalid_invocation (exit 11)', async () => {
    const loadConfig = vi.fn(() => ({
      network: 'testnet',
      discovery: { mode: 'http', url: 'https://indexer.example' },
    }));
    const command = createSupplyCommand({
      loadConfig: loadConfig as never,
      getConfigPathFromArgs: () => undefined,
      createDiscoveryClient: () => ({
        getCurrentSupply: async () => {
          throw new DiscoveryUnavailableError('bad chain', undefined, 'invalid_request');
        },
      }),
    });
    const { envelopes, exits } = await runCommand(command);
    expect(exits).toEqual([11]);
    expect(envelopes[0]).toMatchObject({ code: 'invalid_invocation', exitCode: 11 });
  });

  it('maps untagged discovery failures to transient_error (exit 40)', async () => {
    const command = createSupplyCommand({
      loadConfig: (() => ({
        network: 'testnet',
        discovery: { mode: 'http', url: 'https://indexer.example' },
      })) as never,
      getConfigPathFromArgs: () => undefined,
      createDiscoveryClient: () => ({
        getCurrentSupply: async () => {
          throw new DiscoveryUnavailableError('indexer down');
        },
      }),
    });
    const { envelopes, exits } = await runCommand(command);
    expect(exits).toEqual([40]);
    expect(envelopes[0]).toMatchObject({ code: 'transient_error', exitCode: 40 });
  });
});
