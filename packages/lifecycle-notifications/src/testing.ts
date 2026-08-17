import type { DerivedNotice, NotificationsBuildInput } from "./derive.js";

/**
 * In-tree fake proving the derivation kit passable: one kind (`funding_empty`)
 * from empty fund chains. A kit failure against this fake is the contract's
 * fault, never the production deriver's.
 */
export function createFundingEmptyDeriver() {
  return (input: NotificationsBuildInput): DerivedNotice[] =>
    input.funds.chains
      .filter((chain) => chain.empty)
      .map((chain) => ({
        kind: "funding_empty",
        severity: "blocking" as const,
        title: "Gas exhausted",
        message: `Gas exhausted — ${chain.wallet ?? "wallet"} on ${chain.chain} can't cover the next transaction.`,
        jumpTo: "/overview",
      }));
}
