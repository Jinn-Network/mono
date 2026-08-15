// SPDX-License-Identifier: MIT

/**
 * Test-only fixture builders. Excluded from `tsconfig.build.json`, so a production import of this
 * module is a build failure rather than a shipped test helper.
 */

import {
  EXECUTION_TUPLE_FORMAT_TOKEN,
  tupleDigest,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { CAMPAIGN_FORMAT_TOKEN } from "../tokens.js";
import type { CampaignDocument } from "../types.js";

export function digestOf(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

export function tupleWith(overrides: Partial<Record<string, unknown>> = {}): ExecutionPolicyTuple {
  return {
    formatToken: EXECUTION_TUPLE_FORMAT_TOKEN,
    harness: { id: "claude-code", version: "2.1.34" },
    model: { id: "anthropic/claude-haiku-4-5" },
    loadout: { kind: "jinn.harness-state.v1", name: "seed", digest: digestOf("1") },
    isolationPolicy: "unrestricted",
    ...overrides,
  } as ExecutionPolicyTuple;
}

export const SEED_TUPLE = tupleWith();
export const SEED_TUPLE_DIGEST = tupleDigest(SEED_TUPLE);

export function campaignWith(overrides: Partial<CampaignDocument> = {}): CampaignDocument {
  return {
    formatToken: CAMPAIGN_FORMAT_TOKEN,
    target: {
      taskProfile: "https://profiles.jinn.network/repository-work/1.0",
      developmentBenchmark: digestOf("d"),
      promotionBenchmark: digestOf("e"),
    },
    seeds: [{ kind: "tuple", digest: SEED_TUPLE_DIGEST }],
    mutationSurface: ["loadout"],
    frozenAxes: {
      harness: { id: "claude-code", version: "2.1.34" },
      model: { id: "anthropic/claude-haiku-4-5" },
      isolationPolicy: "unrestricted",
    },
    objective: {
      methods: [{ id: "urn:jinn:benchmarking:method:pass-rate", version: "1.0.0", parameters: {} }],
      constraints: [],
    },
    budgets: {
      proposal: { maxProposals: 8 },
      evaluation: { maxCells: 200 },
      hardCap: { maxCells: 260 },
    },
    allocation: { policyRef: "even-split/1.0", parameters: {} },
    stoppingRule: { ruleRef: "max-waves/1.0", parameters: { maxWaves: 4 } },
    ...overrides,
  } as CampaignDocument;
}
