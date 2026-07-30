// SPDX-License-Identifier: MIT

/**
 * The two-generation seam (design §5.4; frozen §11.1/§11.6; plan Global Constraints). Every
 * binding leg is written for BOTH generations behind this single config value: `"today"`
 * targets the DEPLOYED TaskCoordinator/JinnRouterV3/Mech Marketplace contracts unchanged;
 * `"revised"` targets the specified contract revision (built later, Milestone M7). Flipping is
 * configuration, not rewrite -- this literal union is the entire seam.
 */
export type ContractGeneration = "today" | "revised";

/** The subset of a chain config every generation-aware leg reads to select its branch. */
export interface GenerationSelectable {
  readonly generation: ContractGeneration;
}

/**
 * A total function reading the single config field that decides which generation's behavior
 * applies (§5.4: "the seam is a single config read, not a branch scattered through the code").
 */
export function selectGeneration(config: GenerationSelectable): ContractGeneration {
  return config.generation;
}
