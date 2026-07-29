import type { LaunchPlan } from "./contract.js";

export interface InterpretedResult { readonly state: "failed" | "delivered"; readonly outcome?: "fulfilled" | "partial"; readonly blame?: "task" | "infrastructure"; readonly recoveryAdvice?: "resume-with-session"; }
export function interpretResult(plan: LaunchPlan, exit: { exitCode?: number; signal?: string }, envelope?: { subtype?: string }): InterpretedResult {
  const valid = exit.signal === undefined && exit.exitCode !== undefined && plan.validExitCodes.includes(exit.exitCode);
  if (!valid) {
    const match = plan.blameExitCodes?.find((rule) => rule.match.exitCode === exit.exitCode || rule.match.signal === exit.signal);
    return { state: "failed", blame: match?.blame ?? "task" };
  }
  if (envelope?.subtype === "error_max_turns" || envelope?.subtype === "error_max_budget_usd") return { state: "delivered", outcome: "partial", recoveryAdvice: "resume-with-session" };
  if (envelope?.subtype === "is_error" || envelope?.subtype === "error_during_execution") return { state: "failed", blame: "task" };
  return { state: "delivered", outcome: "fulfilled" };
}
