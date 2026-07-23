export const MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES = [
  'creator',
  'funds',
  'rpc',
  'contracts',
  'indexer',
  'gateway',
  'solverNet',
] as const;

export type MarketplaceTaskSubmitPreflightCategory =
  typeof MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES[number];

export type MarketplaceTaskSubmitPreflightCheck = () => Promise<void>;

export class MarketplaceTaskSubmitPreflightError extends Error {
  readonly name = 'MarketplaceTaskSubmitPreflightError';

  constructor(
    readonly category: MarketplaceTaskSubmitPreflightCategory,
    cause: unknown,
  ) {
    super(
      `Marketplace Task submission preflight failed (${category}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
}

export async function runMarketplaceTaskSubmitPreflight(
  checks: Record<
    MarketplaceTaskSubmitPreflightCategory,
    MarketplaceTaskSubmitPreflightCheck
  >,
): Promise<void> {
  for (const category of MARKETPLACE_TASK_SUBMIT_PREFLIGHT_CATEGORIES) {
    try {
      await checks[category]();
    } catch (err) {
      throw new MarketplaceTaskSubmitPreflightError(category, err);
    }
  }
}
