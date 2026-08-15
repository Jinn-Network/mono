import { describe, expect, it, vi } from 'vitest';
import { bootstrapRetryIntent } from '../../src/intents/bootstrap-retry.js';

describe('bootstrapRetryIntent', () => {
  it('returns ok:true when retryBootstrap resolves', async () => {
    const retryBootstrap = vi.fn().mockResolvedValue(undefined);
    const result = await bootstrapRetryIntent({ retryBootstrap });
    expect(result.ok).toBe(true);
    expect(result.verb).toBe('bootstrap-retry');
    expect(retryBootstrap).toHaveBeenCalledOnce();
  });

  it('returns ok:false with the serialized error when retryBootstrap rejects', async () => {
    const retryBootstrap = vi.fn().mockRejectedValue(new Error('daemon_not_halted'));
    const result = await bootstrapRetryIntent({ retryBootstrap });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daemon_not_halted');
  });

  it('serializes a non-Error rejection', async () => {
    const retryBootstrap = vi.fn().mockRejectedValue('plain string failure');
    const result = await bootstrapRetryIntent({ retryBootstrap });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('plain string failure');
  });
});
