import type { VerdictOutcome, VerdictRuleName } from "./method.js";

export type VerdictReduction = { value: "pass" | "fail" } | { conflicted: true };

const CONFLICTED: VerdictReduction = { conflicted: true };

/**
 * The contract-wide `verdictRule` reduction (design §9.2): how a cell's valid-verdict outcomes
 * reduce to one value. `sole` (exactly one, else conflicted), `unanimous` (all agree, else
 * conflicted — the default), `any-pass`, `majority` (strict majority; an exact tie is
 * conflicted). Conflicted cells are dropped-with-report, never silently resolved (§9.2: their
 * counts + cellKeys always appear in `results`).
 *
 * An `inconclusive`-valued outcome is never silently coerced to pass or fail under any rule —
 * its presence makes the cell conflicted outright. (A verdict the assembly procedure already
 * excluded from `validVerdicts[]` for being inconclusive never reaches this function at all;
 * this is the fail-closed behavior for the residual case where one still does.)
 */
export function reduceValidVerdicts(
  validVerdictOutcomes: readonly VerdictOutcome[],
  rule: VerdictRuleName,
): VerdictReduction {
  if (validVerdictOutcomes.some((outcome) => outcome.verdict === "inconclusive")) return CONFLICTED;
  const decisive = validVerdictOutcomes as readonly { verdict: "pass" | "fail" }[];

  switch (rule) {
    case "sole": {
      if (decisive.length !== 1) return CONFLICTED;
      return { value: decisive[0]!.verdict };
    }
    case "unanimous": {
      if (decisive.length === 0) return CONFLICTED;
      const first = decisive[0]!.verdict;
      return decisive.every((outcome) => outcome.verdict === first) ? { value: first } : CONFLICTED;
    }
    case "any-pass": {
      if (decisive.length === 0) return CONFLICTED;
      return { value: decisive.some((outcome) => outcome.verdict === "pass") ? "pass" : "fail" };
    }
    case "majority": {
      if (decisive.length === 0) return CONFLICTED;
      const passCount = decisive.filter((outcome) => outcome.verdict === "pass").length;
      const failCount = decisive.length - passCount;
      if (passCount === failCount) return CONFLICTED;
      return { value: passCount > failCount ? "pass" : "fail" };
    }
  }
}
