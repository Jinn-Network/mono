/**
 * Static mirror of the prediction.v1 SolverNet contract template +
 * generator defaults consumed by the Create wizard.
 *
 * Why a mirror? The SPA's tsconfig only includes
 * `client/src/dashboard/spa/src/**`, so the daemon-side `prediction-v1-auto.ts`
 * defaults and the SDK's `PREDICTION_V1_SOLVER_NET_CONTRACT` are not in scope
 * here. Day-1 the wizard supports a single template; rather than ship the SPA
 * with the full SDK type graph for a single template, we copy the minimal
 * shape needed to render Steps 2 + 3 and pin it with shape tests on the
 * SDK-side.
 *
 * Drift policy: this file mirrors the daemon-side authoritative values:
 *   - `PREDICTION_V1_SOLVER_NET_CONTRACT`         in `packages/sdk/src/contracts.ts`
 *   - `PredictionV1AutoConfig` `DEFAULTS` block   in `client/src/solver-types/prediction-v1-auto.ts`
 *
 * If those change, update this file. The daemon's launch endpoint validates
 * draft completeness against the canonical contract before launch, so a
 * mismatch surfaces as a 400 rather than a silent corruption.
 */

export interface CreateWizardTemplate {
  /** Stable contract identity, e.g. `'prediction'`. */
  id: string;
  /** Contract version, e.g. `'v1'`. */
  version: string;
  /** Human label, e.g. `'Prediction'`. */
  name: string;
  /** Descriptive blurb shown in Step 2's header. */
  description: string;
  schemas: {
    task: { name: string; description: string };
    solution: { name: string; description: string };
    verdict: { name: string; description: string };
  };
  evaluationFunction: {
    id: string;
    deterministic: boolean;
    inputs: readonly string[];
    output: string;
  };
  aggregationFunction: {
    id: string;
    deterministic: boolean;
    inputs: readonly string[];
    output: string;
    windowDays?: number;
  };
  claimPolicyDefaults: {
    mode: 'parallel' | 'serial';
    maxClaims: number;
    maxClaimsPerOperator: number;
    claimLeaseTtlSeconds: number;
  };
  credentialRequirements: {
    creator: ReadonlyArray<{ id: string; kind: string; required: boolean; description: string }>;
    solver: ReadonlyArray<{ id: string; kind: string; required: boolean; description: string }>;
    evaluator: ReadonlyArray<{ id: string; kind: string; required: boolean; description: string }>;
  };
  /** Default generator-config values pre-filled in Step 3. */
  generatorDefaults: {
    cadenceMs: number;
    submissionWindowMs: number;
    maxNewRoundsPerPoll: number;
    maxNewRoundsPerDay: number;
    maxOpenRounds: number;
    minTimeToResolutionHours: number;
    maxTimeToResolutionHours: number;
    minLiquidityUsd: string;
    minVolume24hUsd: string;
    maxYesSpread: string;
    maxOrderbookAgeSeconds: number;
  };
}

export const PREDICTION_V1_TEMPLATE: CreateWizardTemplate = {
  id: 'prediction',
  version: 'v1',
  name: 'Prediction',
  description:
    'Forecast resolved outcomes. Solvers submit a probability for a binary market; evaluators score against the on-chain resolution using Brier loss.',
  schemas: {
    task: {
      name: 'prediction.v1 Task',
      description:
        'A binary Polymarket market with resolution time, condition id, and orderbook snapshot.',
    },
    solution: {
      name: 'prediction.v1 Solution',
      description: 'A scalar probability in [0, 1] that the market resolves YES.',
    },
    verdict: {
      name: 'prediction.v1 Verdict',
      description: 'Brier-loss score derived from the solver probability and the resolved outcome.',
    },
  },
  evaluationFunction: {
    id: 'prediction.brier-loss.v1',
    deterministic: true,
    inputs: ['prediction.v1 Task', 'prediction.v1 Solution', 'Polymarket/UMA resolution'],
    output: 'prediction.v1 Verdict',
  },
  aggregationFunction: {
    id: 'prediction.trailing-mean-brier-spread.v1',
    deterministic: true,
    inputs: ['SCORED prediction.v1 Verdicts'],
    output: 'trailing mean brierSpread',
    windowDays: 84,
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 25,
    maxClaimsPerOperator: 1,
    claimLeaseTtlSeconds: 30 * 60,
  },
  credentialRequirements: {
    creator: [
      {
        id: 'polymarket.public.market-data.read',
        kind: 'public-api',
        required: true,
        description:
          'Read public Polymarket market metadata and orderbook snapshots for Task creation.',
      },
    ],
    solver: [],
    evaluator: [
      {
        id: 'polymarket.public.resolution.read',
        kind: 'public-api',
        required: true,
        description: 'Read public Polymarket/UMA final market state for resolution mapping.',
      },
    ],
  },
  generatorDefaults: {
    cadenceMs: 6 * 60 * 60 * 1000, // 6h
    submissionWindowMs: 6 * 60 * 60 * 1000, // 6h
    maxNewRoundsPerPoll: 25,
    maxNewRoundsPerDay: 100,
    maxOpenRounds: 250,
    minTimeToResolutionHours: 24,
    maxTimeToResolutionHours: 168,
    minLiquidityUsd: '10000',
    minVolume24hUsd: '2500',
    maxYesSpread: '0.10',
    maxOrderbookAgeSeconds: 60,
  },
};
