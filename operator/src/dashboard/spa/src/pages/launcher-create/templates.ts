/**
 * Static mirror of SolverNet contract templates + generator defaults
 * consumed by the Create wizard.
 *
 * Why a mirror? The SPA's tsconfig only includes
 * `operator/src/dashboard/spa/src/**`, so the daemon-side `*-auto.ts`
 * defaults and the SDK's `*_SOLVER_NET_CONTRACT` are not in scope here.
 * Rather than ship the SPA with the full SDK type graph, we copy the
 * minimal shape needed to render Steps 2 + 3 and rely on the daemon's
 * launch endpoint to validate draft completeness against the canonical
 * contract before launch (mismatches surface as a 400, not silent
 * corruption).
 *
 * Drift policy: this file mirrors the daemon-side authoritative values:
 *   - `PREDICTION_V1_SOLVER_NET_CONTRACT`         in `packages/sdk/src/contracts.ts`
 *   - `PredictionV1AutoConfig` `DEFAULTS` block   in `operator/src/solver-types/prediction-v1-auto.ts`
 *   - `SWE_REBENCH_V2_V1_SOLVER_NET_CONTRACT`     in `packages/sdk/src/contracts.ts`
 *   - `DEFAULT_GENERATOR_CONFIG`                  in `operator/src/solver-types/swe-rebench-v2-auto.ts`
 *
 * Adding a new template:
 *   1. Add a matching entry to the `CreateWizardTemplate` discriminated
 *      union below (each variant binds `id` + `version` + a shape for
 *      `generatorDefaults`).
 *   2. Export the template constant.
 *   3. Add it to `TEMPLATES_BY_KEY` keyed by `${id}.${version}`.
 *   4. Teach Step 3 to render its generator-config form.
 */

interface CreateWizardTemplateBase {
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
}

export interface PredictionV1GeneratorDefaults {
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
}

export interface SweRebenchV2V1GeneratorDefaults {
  /** How many score=1 Verdicts must accumulate before a Task saturates. */
  N_target_successes: number;
  /** On-chain claim-window deadline for each posting (ms). The repost trigger
   *  is claim-budget exhaustion observed via the indexer, not this window (#802). */
  posting_window_ms: number;
  /** Maximum number of instances to post in one creator tick. */
  post_batch_size: number;
  /** Optional per-operator cap; omitted means equal to remaining target successes. */
  maxClaimsPerOperator?: number;
  /** Claim lease for each Task claim. */
  claimLeaseTtlSeconds: number;
}

/**
 * Discriminated union over `${id}.${version}`. Step 3 narrows on `id`
 * to render the correct generator-config form.
 */
export type CreateWizardTemplate =
  | PredictionV1Template
  | SweRebenchV2V1Template;

/** Narrow variant for `prediction.v1`. Used as the type of `PREDICTION_V1_TEMPLATE`. */
export type PredictionV1Template = CreateWizardTemplateBase & {
  id: 'prediction';
  version: 'v1';
  generatorDefaults: PredictionV1GeneratorDefaults;
};

/** Narrow variant for `swe-rebench-v2.v1`. Used as the type of `SWE_REBENCH_V2_V1_TEMPLATE`. */
export type SweRebenchV2V1Template = CreateWizardTemplateBase & {
  id: 'swe-rebench-v2';
  version: 'v1';
  generatorDefaults: SweRebenchV2V1GeneratorDefaults;
};

export const PREDICTION_V1_TEMPLATE: PredictionV1Template = {
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

export const SWE_REBENCH_V2_V1_TEMPLATE: SweRebenchV2V1Template = {
  id: 'swe-rebench-v2',
  version: 'v1',
  name: 'SWE-rebench v2',
  description:
    'Code-issue benchmark sourced from the nebius/SWE-rebench-leaderboard HuggingFace dataset. Solvers submit a patch; evaluators run the upstream eval.py harness inside the per-instance Docker image and emit a 0/1 Verdict against the FAIL_TO_PASS / PASS_TO_PASS tests.',
  schemas: {
    task: {
      name: 'swe-rebench-v2.v1 Task',
      description:
        'A reference to a HuggingFace dataset row by (hf_dataset, hf_split, instance_id), plus repo + base_commit + language + problem statement.',
    },
    solution: {
      name: 'swe-rebench-v2.v1 Solution',
      description:
        'A unified diff patch (git-format), with optional self-reported cost. The trajectory blob is pinned daemon-side and referenced via the envelope, not the payload.',
    },
    verdict: {
      name: 'swe-rebench-v2.v1 Verdict',
      description:
        'Score 0 or 1 based on whether the patch passes the per-instance Docker test suite, plus passed_match flag and evaluator cost. The test log is pinned daemon-side and surfaced via the verdict-artifact metadata.',
    },
  },
  evaluationFunction: {
    id: 'swe-rebench-v2.docker-test-suite.v1',
    deterministic: true,
    inputs: ['swe-rebench-v2.v1 Task', 'swe-rebench-v2.v1 Solution', 'per-instance Docker image'],
    output: 'swe-rebench-v2.v1 Verdict',
  },
  aggregationFunction: {
    id: 'swe-rebench-v2.multi-winrate.v1',
    deterministic: true,
    inputs: ['SCORED swe-rebench-v2.v1 Verdicts'],
    output: 'mean / complexityWeighted / byLanguage / frontierResolved / parityTripRate',
    windowDays: 30,
  },
  claimPolicyDefaults: {
    mode: 'parallel',
    maxClaims: 5,
    maxClaimsPerOperator: 5,
    claimLeaseTtlSeconds: 60 * 60,
  },
  credentialRequirements: {
    creator: [
      {
        id: 'huggingface.public.datasets-server.read',
        kind: 'public-api',
        required: true,
        description:
          'Read public HuggingFace dataset rows from the nebius/SWE-rebench-leaderboard splits.',
      },
    ],
    solver: [],
    evaluator: [
      {
        id: 'docker.local.run',
        kind: 'local-runtime',
        required: true,
        description:
          'Run per-instance Docker images that ship with the upstream eval.py harness.',
      },
      {
        id: 'huggingface.public.datasets-server.read',
        kind: 'public-api',
        required: true,
        description:
          'Read the HF dataset row referenced by the Task to recover test_patch + FAIL_TO_PASS / PASS_TO_PASS.',
      },
    ],
  },
  generatorDefaults: {
    N_target_successes: 5,
    posting_window_ms: 24 * 60 * 60 * 1000, // 1d
    post_batch_size: 25,
    claimLeaseTtlSeconds: 60 * 60,
  },
};

/**
 * Lookup table keyed by `${id}.${version}`. The wizard reads
 * `?template=<key>` from the URL and looks the active template up here.
 * If the key is not present the wizard renders an inline error rather
 * than falling back silently.
 */
export const TEMPLATES_BY_KEY: Readonly<Record<string, CreateWizardTemplate>> = {
  'prediction.v1': PREDICTION_V1_TEMPLATE,
  'swe-rebench-v2.v1': SWE_REBENCH_V2_V1_TEMPLATE,
};

/** Default template when no `?template=` URL parameter is supplied. */
export const DEFAULT_TEMPLATE_KEY = 'prediction.v1';
