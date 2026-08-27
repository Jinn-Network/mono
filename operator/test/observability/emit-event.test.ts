import { describe, expect, it } from 'vitest';
import { emitEvent } from '../../src/observability/emit-event.js';
import { Store } from '../../src/store/store.js';

const SECRET = 'SECRETKEY123';

describe('emitEvent persistence boundary (#642)', () => {
  it('sanitizes tick_error detail before writing activity_events', () => {
    const store = new Store(':memory:');
    emitEvent(store, {
      kind: 'tick_error',
      outcome: 'failed',
      requestId: '0xabc',
      detail: `RPC failed https://base-mainnet.g.alchemy.com/v2/${SECRET}?token=${SECRET}#frag=${SECRET}`,
    }, 'work');

    const row = store.getRecentActivityEvents(1)[0];
    expect(row?.kind).toBe('tick_error');
    expect(row?.detail).toContain('base-mainnet.g.alchemy.com');
    expect(row?.detail).not.toContain(SECRET);
    expect(row?.detail).not.toContain('/v2/');
  });
});
