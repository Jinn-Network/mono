import { describe, it, expect } from 'vitest';
import {
  toLedgerRow,
  LedgerRowSchema,
  LedgerEntrySchema,
  type LedgerEntry,
} from '../src/ledger.js';

const publishedEntry: LedgerEntry = LedgerEntrySchema.parse({
  ts: '2026-07-11T08:00:00.000Z',
  taskSummary: 'fix duplicate rows after a join in the report query',
  envelopeRef: 'bafyEnvelopePublished',
  anchorTx: '0xabc123',
  verifiabilityTier: 'tests-passed',
  status: 'published',
});

const vetoedEntry: LedgerEntry = LedgerEntrySchema.parse({
  ts: '2026-07-11T09:00:00.000Z',
  taskSummary: 'rename a private helper',
  envelopeRef: null,
  anchorTx: null,
  verifiabilityTier: 'user-accepted',
  status: 'vetoed (local only)',
});

describe('toLedgerRow', () => {
  it('projects a published entry to a fork row with no state key', () => {
    const row = toLedgerRow(publishedEntry);
    expect(row).toEqual({
      time: publishedEntry.ts,
      task: publishedEntry.taskSummary,
      env: publishedEntry.envelopeRef,
      anchor: publishedEntry.anchorTx,
      tier: 'tests-passed',
    });
    // The key is ABSENT — not `state: null`.
    expect('state' in row).toBe(false);
  });

  it('maps fields onto the canonical fork keys', () => {
    const row = toLedgerRow(publishedEntry);
    expect(row.time).toBe(publishedEntry.ts);
    expect(row.task).toBe(publishedEntry.taskSummary);
    // Canonical key is `env`, sourced from envelopeRef.
    expect(row.env).toBe(publishedEntry.envelopeRef);
    expect(row.anchor).toBe(publishedEntry.anchorTx);
  });

  it('projects a vetoed entry with null refs and state:vetoed', () => {
    const row = toLedgerRow(vetoedEntry);
    expect(row).toEqual({
      time: vetoedEntry.ts,
      task: vetoedEntry.taskSummary,
      env: null,
      anchor: null,
      tier: 'user-accepted',
      state: 'vetoed',
    });
  });
});

describe('LedgerRowSchema', () => {
  it('round-trips a published row with no state key', () => {
    const row = toLedgerRow(publishedEntry);
    const parsed = LedgerRowSchema.parse(row);
    expect('state' in parsed).toBe(false);
  });

  it('round-trips a vetoed row with state:vetoed', () => {
    const parsed = LedgerRowSchema.parse(toLedgerRow(vetoedEntry));
    expect(parsed.state).toBe('vetoed');
  });

  it('supports a forward-compat failed state the projector never emits', () => {
    const parsed = LedgerRowSchema.parse({
      time: '2026-07-11T10:00:00.000Z',
      task: 'a retained-local retry that failed to publish',
      env: 'bafyEnvelopeFailed',
      anchor: null,
      tier: 'user-accepted',
      state: 'failed',
    });
    expect(parsed.state).toBe('failed');
  });

  it('rejects an off-enum tier (tier stays the verifiability enum)', () => {
    expect(() =>
      LedgerRowSchema.parse({
        time: '2026-07-11T10:00:00.000Z',
        task: 'x',
        env: null,
        anchor: null,
        tier: 'vetoed',
      }),
    ).toThrow();
  });

  it('rejects an off-enum state', () => {
    expect(() =>
      LedgerRowSchema.parse({
        time: '2026-07-11T10:00:00.000Z',
        task: 'x',
        env: null,
        anchor: null,
        tier: 'user-accepted',
        state: 'published',
      }),
    ).toThrow();
  });
});
