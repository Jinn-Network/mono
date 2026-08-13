import type { JinnConfig } from '../config.js';
import { createHttpDiscoveryAPI } from '../discovery/http.js';

export const MARKETPLACE_TASK_FRESHNESS_RESERVE_MS = 60_000;

export function marketplaceTaskBudgetWei(args: {
  solutionMaxDeliveryRateWei: bigint;
  verdictMaxDeliveryRateWei: bigint;
  maxClaims: number;
}): bigint {
  return (
    args.solutionMaxDeliveryRateWei + args.verdictMaxDeliveryRateWei
  ) * BigInt(args.maxClaims);
}

export class MarketplaceTaskRequestExpiredError extends Error {
  readonly name = 'MarketplaceTaskRequestExpiredError';
}

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

export function assertMarketplaceTaskRequestFreshness(
  request: {
    claimPolicy: {
      claimWindowEndTs: number;
      submissionDeadlineTs: number;
    };
    spec: {
      session: {
        deadline: string;
      };
    };
  },
  options: {
    nowMs?: number;
    reserveMs?: number;
  } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  const reserveMs = options.reserveMs ?? MARKETPLACE_TASK_FRESHNESS_RESERVE_MS;
  const minimumLiveDeadline = nowMs + reserveMs;
  const deadlines = [
    ['claim window end', request.claimPolicy.claimWindowEndTs],
    ['submission deadline', request.claimPolicy.submissionDeadlineTs],
    ['session/adoption deadline', Date.parse(request.spec.session.deadline)],
  ] as const;
  const expired = deadlines.filter(
    ([, deadline]) => !Number.isFinite(deadline) || deadline <= minimumLiveDeadline,
  );
  if (expired.length > 0) {
    throw new MarketplaceTaskRequestExpiredError(
      `Marketplace Task request freshness check failed: ${
        expired.map(([label]) => label).join(', ')
      } must remain live beyond ${new Date(minimumLiveDeadline).toISOString()} ` +
      `(${reserveMs} ms execution reserve)`,
    );
  }
}

export function assertMarketplaceTaskFunding(args: {
  safeBalanceWei: bigint;
  agentBalanceWei: bigint;
  solutionMaxDeliveryRateWei: bigint;
  verdictMaxDeliveryRateWei: bigint;
  maxClaims: number;
  agentGasReserveWei: bigint;
}): void {
  const taskBudgetWei = marketplaceTaskBudgetWei(args);
  if (args.safeBalanceWei < taskBudgetWei) {
    throw new Error(
      `creator Safe requires ${taskBudgetWei} wei task budget but has ${args.safeBalanceWei} wei`,
    );
  }
  const requiredAgentWei = taskBudgetWei + args.agentGasReserveWei;
  if (args.agentBalanceWei < requiredAgentWei) {
    throw new Error(
      `creator agent EOA requires ${requiredAgentWei} wei: ${taskBudgetWei} wei outer Safe exec value ` +
      `plus ${args.agentGasReserveWei} wei gas reserve, but has ${args.agentBalanceWei} wei`,
    );
  }
}

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
