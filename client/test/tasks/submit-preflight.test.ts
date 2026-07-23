import { describe, expect, it, vi } from 'vitest';
import {
  MarketplaceTaskSubmitPreflightError,
  runMarketplaceTaskSubmitPreflight,
  type MarketplaceTaskSubmitPreflightCheck,
} from '../../src/tasks/submit-preflight.js';

const categories = [
  'creator',
  'funds',
  'contracts',
  'solverNet',
  'indexer',
  'gateway',
  'rpc',
] as const;

describe('runMarketplaceTaskSubmitPreflight', () => {
  it.each(categories)('fails closed when the %s dependency is unavailable', async (failed) => {
    const checks = Object.fromEntries(categories.map((category) => [
      category,
      vi.fn(async () => {
        if (category === failed) throw new Error(`${category} unavailable`);
      }),
    ])) as Record<typeof categories[number], MarketplaceTaskSubmitPreflightCheck>;

    await expect(runMarketplaceTaskSubmitPreflight(checks))
      .rejects.toEqual(expect.objectContaining({
        name: 'MarketplaceTaskSubmitPreflightError',
        category: failed,
      }));
  });

  it('runs every dependency check without mutation hooks', async () => {
    const checks = Object.fromEntries(categories.map((category) => [
      category,
      vi.fn(async () => undefined),
    ])) as Record<typeof categories[number], MarketplaceTaskSubmitPreflightCheck>;

    await runMarketplaceTaskSubmitPreflight(checks);

    for (const category of categories) expect(checks[category]).toHaveBeenCalledOnce();
    expect(MarketplaceTaskSubmitPreflightError).toBeTypeOf('function');
  });
});
