import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  EngagementLedger,
  reconcileEngagements,
  type EngagementRow,
} from '../../src/daemon/engagement-ledger.js';

const WIRING = {
  workKind: 'QmSolver',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process',
  legacyManifestDigest: 'QmSolver',
};

function ledger(): EngagementLedger {
  return new EngagementLedger(new Store(':memory:'));
}

const INTENT = {
  idempotencyKey: '84532:0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98:42',
  chainId: 84532,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 42n,
  workKind: 'QmSolver',
  wiring: WIRING,
};

describe('engagement ledger', () => {
  it('admits a claim intent and records the wiring entry that served it', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.outcome).toBe('intended');
    expect(JSON.parse(row.wiringJson)).toEqual(WIRING);
    expect(row.claimTxHash).toBeNull();
  });

  it('refuses a second intent for the same task — the caller must not broadcast twice', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    expect(led.admitClaimIntent(INTENT)).toBe(false);
  });

  it('records the claim receipt and terminal outcome', () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    led.recordOutcome(INTENT.idempotencyKey, 'settled');
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.attemptIndex).toBe(0);
    expect(row.outcome).toBe('settled');
    expect(led.listUnreconciled()).toEqual([]);
  });

  it('reconciles an intended row whose broadcast actually landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
    });
    expect(result.reconciled).toBe(1);
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('claimed');
    expect(result.stranded).toEqual([]);
  });

  it('abandons an intended row whose broadcast never landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    await reconcileEngagements({ ledger: led, readAttemptFacts: async () => ({ kind: 'no-claim' }) });
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('abandoned');
  });

  it('strands a claimed-but-unsettled row loudly instead of silently retrying', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    const warnings: string[] = [];
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(result.stranded.map((row: EngagementRow) => row.idempotencyKey)).toEqual([
      INTENT.idempotencyKey,
    ]);
    expect(warnings.join('\n')).toContain('unreleased attempt');
  });
});
