import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildFleetPostingRuntime,
  POSTING_UNWIRED_LIVE_WINDOW_MS,
  type ResolvedPostingTarget,
} from '@/daemon/native-fleet-posting.js';
import { isRequesterError } from '@/native-requester/work-client/index.js';
import type { PostingConfigEntry } from '@/config/shape-v2.js';

const SAFE = '0x00112233445566778899aabbccddeeff00112233' as const;
const AGENT = '0x1111111111111111111111111111111111111111' as const;

function entry(overrides: Partial<PostingConfigEntry> = {}): PostingConfigEntry {
  return {
    workKind: 'bafyManifestRepo',
    launchedRecordPath: '/tmp/does-not-matter.json',
    generatorEnabled: true,
    ...overrides,
  };
}

function runtime(opts: {
  entries?: PostingConfigEntry[];
  resolve?: (e: PostingConfigEntry) => ResolvedPostingTarget;
  balances?: Record<string, bigint>;
  now?: number;
}) {
  const balances = opts.balances ?? { [SAFE]: 10n, [AGENT]: 20n };
  return buildFleetPostingRuntime({
    config: { posting: opts.entries },
    safeAddress: SAFE,
    agentEoaAddress: AGENT,
    readBalanceWei: async (address) => balances[address] ?? 0n,
    resolveLaunchedTarget: opts.resolve ?? (() => ({ profileUri: 'p', live: true })),
    ...(opts.now === undefined ? {} : { now: () => opts.now! }),
  });
}

describe('buildFleetPostingRuntime — postingEntryCount (the boot-inertness gate input)', () => {
  it('is 0 for an absent posting config', () => {
    expect(runtime({}).postingEntryCount).toBe(0);
  });
  it('counts the configured posting entries', () => {
    expect(runtime({ entries: [entry(), entry({ workKind: 'b' })] }).postingEntryCount).toBe(2);
  });
});

describe('listTargets — real config + launched-record resolution', () => {
  it('maps each posting entry to a live-annotated target', async () => {
    const rt = runtime({
      entries: [entry({ workKind: 'repo', legacyManifestDigest: 'sha256:abc' })],
      resolve: () => ({ profileUri: 'urn:m:repo', live: true }),
    });
    expect(await rt.ports.listTargets()).toEqual([
      {
        postingKey: 'repo',
        workKind: 'repo',
        profileUri: 'urn:m:repo',
        live: true,
        generatorEnabled: true,
        legacyManifestDigest: 'sha256:abc',
      },
    ]);
  });

  it('reports live=false when the launched record is not in the launched status', async () => {
    const rt = runtime({
      entries: [entry()],
      resolve: () => ({ profileUri: 'p', live: false }),
    });
    expect((await rt.ports.listTargets())[0]!.live).toBe(false);
  });

  it('carries generatorEnabled straight from the entry', async () => {
    const rt = runtime({ entries: [entry({ generatorEnabled: false })] });
    expect((await rt.ports.listTargets())[0]!.generatorEnabled).toBe(false);
  });
});

describe('probeFunds — real live balances, no fabricated rate barrier', () => {
  it('reads the Safe and agent balances through the injected read', async () => {
    const rt = runtime({ entries: [entry()], balances: { [SAFE]: 555n, [AGENT]: 777n } });
    const funds = await rt.ports.probeFunds((await rt.ports.listTargets())[0]!);
    expect(funds.safeBalanceWei).toBe(555n);
    expect(funds.agentBalanceWei).toBe(777n);
    // Rates/reserve are unwired venue terms -> budget 0 -> no rate barrier asserted.
    expect(funds.solutionMaxDeliveryRateWei).toBe(0n);
    expect(funds.verdictMaxDeliveryRateWei).toBe(0n);
    expect(funds.agentGasReserveWei).toBe(0n);
    expect(funds.maxClaims).toBe(1);
  });
});

describe('probeFreshness — every deadline live until venue terms are wired', () => {
  it('reports deadlines at now + the wide unwired window', async () => {
    const rt = runtime({ entries: [entry()], now: 1_000_000 });
    const fresh = await rt.ports.probeFreshness((await rt.ports.listTargets())[0]!);
    const expected = 1_000_000 + POSTING_UNWIRED_LIVE_WINDOW_MS;
    expect(fresh).toEqual({
      claimWindowEndMs: expected,
      submissionDeadlineMs: expected,
      sessionDeadlineMs: expected,
    });
  });
});

describe('reconcile — no-op until post is live', () => {
  it('resolves without touching anything', async () => {
    const rt = runtime({ entries: [entry()] });
    await expect(rt.ports.reconcile()).resolves.toBeUndefined();
  });
});

describe('post — the fail-closed seam', () => {
  it('refuses with a typed broadcast RequesterError rather than fabricate a post', async () => {
    const rt = runtime({ entries: [entry()] });
    const target = (await rt.ports.listTargets())[0]!;
    await expect(rt.ports.post(target)).rejects.toSatisfy((err: unknown) =>
      isRequesterError(err) && err.category === 'broadcast' && err.code === 'posting-bridge-unwired',
    );
  });
});

describe('provenance ledger (M5d, 3rd shared-discovery consumer)', () => {
  it('the module opens no native_discovery_* consumer and names no discovery surface', () => {
    // The requester posting path is not a native_discovery_* consumer (solver=shared queue,
    // evaluator=distinct discovery.sqlite). Pin it structurally: the module never references the
    // shared discovery tables, so there is no cross-feed to separate.
    const source = readFileSync(
      fileURLToPath(new URL('../../src/daemon/native-fleet-posting.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('native_discovery');
    expect(code).not.toContain('NativeDiscoveryConsumer');
    expect(code).not.toContain('buildFleetNativeDiscovery');
  });
});
