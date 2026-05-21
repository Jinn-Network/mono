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
    const prev = process.env['ANTHROPIC_API_KEY'];
    const prevTok = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    try {
      recordTaskCost(store, {
        requestId: 'req-1', harness: 'claude-code',
        model: 'claude-opus-4-7', workingDir: dir, solverType: 'prediction.v0',
      });
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prev;
      if (prevTok !== undefined) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = prevTok;
    }
    expect(store.spentTodayMicros('anthropic:api-key')).toBe(500_000);
  });

  it('records nothing when no credential resolves', () => {
    store = freshStore();
    recordTaskCost(store, {
      requestId: 'req-2', harness: 'prediction-v1-baseline',
      model: undefined, workingDir: '/nonexistent', solverType: null,
    });
    expect(store.getRecentActivityEvents(10).filter(r => r.kind === 'task_cost')).toHaveLength(0);
  });
});
