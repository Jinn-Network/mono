import { describe, expect, it, vi } from 'vitest';
import { NativeConstructionScope } from '../../src/daemon/native-construction-scope.js';

describe('native construction ownership scope', () => {
  it('unwinds every partially acquired owner in reverse order', async () => {
    const order: string[] = [];
    const scope = new NativeConstructionScope();
    scope.defer(() => { order.push('store'); });
    scope.defer(async () => { order.push('evidence'); });
    await expect(scope.unwind(new Error('publisher failed'))).rejects.toThrow('publisher failed');
    expect(order).toEqual(['evidence', 'store']);
  });

  it('transfers successful ownership without running construction cleanup', async () => {
    const close = vi.fn();
    const scope = new NativeConstructionScope();
    scope.defer(close);
    scope.release();
    await expect(scope.unwind(new Error('unreachable'))).rejects.toThrow('unreachable');
    expect(close).not.toHaveBeenCalled();
  });
});
