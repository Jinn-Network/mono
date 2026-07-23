import type { JinnConfig } from '../config.js';
import { createHttpDiscoveryAPI } from '../discovery/http.js';

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

export interface MarketplaceSolverNetSummary {
  manifestCid: string;
  name?: string;
  status: 'launched' | 'paused' | 'retired';
  contractId: string;
  contractVersion: string;
}

export function selectMarketplaceTaskSolverNet(args: {
  summaries: MarketplaceSolverNetSummary[];
  explicitManifestCid?: string;
  requestedName?: string;
}): string {
  const compatible = args.summaries.filter((summary) =>
    summary.status === 'launched'
    && summary.contractId === 'jinn-repo'
    && summary.contractVersion === 'v1'
  );
  if (args.explicitManifestCid) {
    const exact = compatible.find(
      (summary) => summary.manifestCid === args.explicitManifestCid,
    );
    if (!exact) {
      throw new Error(
        `Explicit SolverNet ${args.explicitManifestCid} is not a live jinn-repo.v1 SolverNet`,
      );
    }
    return exact.manifestCid;
  }
  const selected = args.requestedName
    ? compatible.filter((summary) =>
      summary.name === args.requestedName || summary.manifestCid === args.requestedName
    )
    : compatible;
  if (selected.length !== 1) {
    throw new Error(
      `Expected exactly one live jinn-repo.v1 SolverNet but found ${selected.length}; ` +
      'provide an explicit solverNetManifestCid',
    );
  }
  return selected[0]!.manifestCid;
}

export async function resolveMarketplaceTaskSolverNet(args: {
  config: JinnConfig;
  explicitManifestCid?: string;
  requestedName?: string;
}): Promise<string> {
  const discovery = args.config.discovery;
  if (discovery?.mode !== 'http' || !discovery.url) {
    throw new Error(
      'HTTP discovery indexer must be configured to resolve a marketplace SolverNet',
    );
  }
  const summaries = await createHttpDiscoveryAPI({
    url: discovery.url,
  }).listLaunchedSolverNets({ status: ['launched'] });
  return selectMarketplaceTaskSolverNet({
    summaries,
    explicitManifestCid: args.explicitManifestCid,
    requestedName: args.requestedName,
  });
}

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
