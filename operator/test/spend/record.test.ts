import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';
import { recordTaskCost } from '../../src/spend/record.js';

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'spend-rec-')), 'jinn.db'));
}

describe('recordTaskCost', () => {
  let store: Store;
  afterEach(() => store?.close());

  it('records observed claude-code cost against the resolved credential', () => {
    store = freshStore();
    const dir = mkdtempSync(join(tmpdir(), 'spend-rec-wd-'));
    mkdirSync(join(dir, '.claude-code'));
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), '{"type":"result","total_cost_usd":0.5}');
    recordTaskCost(store, {
      requestId: 'req-1', harness: 'claude-code',
      model: 'claude-opus-4-7', workingDir: dir, solverType: 'prediction.v0',
    }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(store.spentTodayMicros('anthropic:api-key')).toBe(500_000);
  });

  it('marks the block estimated for a delivered telemetry-less harness (Hermes, AC4)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    // A claimed row must pre-exist for finalizeClaimDelivered to act on.
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'req-hermes',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 1_000_000,
    });
    // hermes-agent has no usage file → harvestHarnessUsage returns a heuristic
    // (estimated:true). The delivered row gets a NON-null actual cost, but the
    // accumulator must still report estimated:true rather than metered.
    recordTaskCost(store, {
      requestId: 'req-hermes', harness: 'hermes-agent',
      model: 'claude-opus-4-7', workingDir: '/nonexistent', solverType: 'prediction.v0',
    }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBeGreaterThan(0);
    expect(r.estimated).toBe(true);
  });

  it('keeps the block metered for a delivered observed-telemetry harness (claude-code)', () => {
    store = freshStore();
    const now = new Date('2026-05-28T13:00:00.000Z');
    const dir = mkdtempSync(join(tmpdir(), 'spend-rec-wd-'));
    mkdirSync(join(dir, '.claude-code'));
    writeFileSync(join(dir, '.claude-code', 'stdout.jsonl'), '{"type":"result","total_cost_usd":0.48}');
    store.recordActivityEvent({
      ts: now.toISOString(),
      kind: 'claimed',
      requestId: 'req-cc',
      credentialId: 'anthropic:api-key',
      claimStatus: 'claimed',
      estimatedCostUsdMicros: 150_000,
    });
    recordTaskCost(store, {
      requestId: 'req-cc', harness: 'claude-code',
      model: 'claude-opus-4-7', workingDir: dir, solverType: 'prediction.v0',
    }, { ANTHROPIC_API_KEY: 'sk-ant-test' });
    const r = store.usdMicrosThisBlock('anthropic:api-key', now);
    expect(r.usdMicros).toBe(480_000);
    expect(r.estimated).toBe(false);
  });

  it('records nothing when no credential resolves', () => {
    store = freshStore();
    recordTaskCost(store, {
      requestId: 'req-2', harness: 'prediction-v1-baseline',
      model: undefined, workingDir: '/nonexistent', solverType: null,
    }, {});
    expect(store.getRecentActivityEvents(10).filter(r => r.kind === 'task_cost')).toHaveLength(0);
  });
});
