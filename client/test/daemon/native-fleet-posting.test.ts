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
  postTask?: (target: { readonly postingKey: string }) => Promise<{ readonly taskId?: string }>;
  logger?: { warn(message: string): void };
}) {
  const balances = opts.balances ?? { [SAFE]: 10n, [AGENT]: 20n };
  return buildFleetPostingRuntime({
    config: { posting: opts.entries },
    safeAddress: SAFE,
    agentEoaAddress: AGENT,
    readBalanceWei: async (address) => balances[address] ?? 0n,
    resolveLaunchedTarget: opts.resolve ?? (() => ({ profileUri: 'p', live: true })),
    ...(opts.postTask === undefined ? {} : { postTask: opts.postTask as never }),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
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

  it('isolates a malformed launched record: one bad entry degrades to live=false, others survive', async () => {
    const warnings: string[] = [];
    const rt = runtime({
      entries: [entry({ workKind: 'good' }), entry({ workKind: 'bad' })],
      resolve: (e) => {
        if (e.workKind === 'bad') throw new Error('launched record is unreadable');
        return { profileUri: 'urn:m:good', live: true };
      },
      logger: { warn: (message) => warnings.push(message) },
    });
    // The whole tick does NOT throw even though one entry's resolve threw.
    const targets = await rt.ports.listTargets();
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.postingKey === 'good')).toMatchObject({ live: true, profileUri: 'urn:m:good' });
    const bad = targets.find((t) => t.postingKey === 'bad')!;
    expect(bad.live).toBe(false);
    // The degradation is visible, not silent.
    expect(warnings.some((w) => w.includes('bad') && w.includes('live=false'))).toBe(true);
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

describe('post — fail-closed when no requester write port is injected', () => {
  it('refuses with a typed broadcast RequesterError rather than fabricate a post', async () => {
    const rt = runtime({ entries: [entry()] });
    const target = (await rt.ports.listTargets())[0]!;
    await expect(rt.ports.post(target)).rejects.toSatisfy((err: unknown) =>
      isRequesterError(err) && err.category === 'broadcast' && err.code === 'posting-bridge-unwired',
    );
  });
});

describe('post — live via the injected requester write port (M5e)', () => {
  it('drives the injected postTask for the target and returns its task id', async () => {
    const seen: string[] = [];
    const rt = runtime({
      entries: [entry({ workKind: 'repo' })],
      postTask: async (target) => {
        seen.push(target.postingKey);
        return { taskId: '4242' };
      },
    });
    const target = (await rt.ports.listTargets())[0]!;
    expect(await rt.ports.post(target)).toEqual({ taskId: '4242' });
    expect(seen).toEqual(['repo']);
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
