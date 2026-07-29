import type { LaunchPlan } from "./contract.js";

export interface ResultEnvelope {
  readonly subtype?: string;
  readonly status?: string;
  readonly code?: string;
  readonly structuredOutput?: unknown;
  readonly sessionId?: string;
  readonly harnessVersion?: string;
  readonly capabilities?: readonly string[];
}
export interface InterpretedResult {
  readonly state: "failed" | "delivered";
  readonly outcome?: "fulfilled" | "partial";
  readonly blame?: "task" | "infrastructure";
  readonly reasonCode?: string;
  readonly recoveryAdvice?: "resume-with-session";
  readonly structuredOutput?: unknown;
  readonly correlation?: {
    readonly harnessVersion?: string;
    readonly capabilities?: readonly string[];
    readonly sessionId?: string;
  };
}
export function interpretResult(plan: LaunchPlan, exit: { exitCode?: number; signal?: string }, envelope?: ResultEnvelope): InterpretedResult {
  const valid = exit.signal === undefined && exit.exitCode !== undefined && plan.validExitCodes.includes(exit.exitCode);
  if (!valid) {
    const match = plan.blameExitCodes?.find((rule) => rule.match.exitCode === exit.exitCode || rule.match.signal === exit.signal);
    return { state: "failed", blame: match?.blame ?? "task", reasonCode: match?.reasonCode ?? (exit.signal ? "death-by-signal" : "invalid-exit") };
  }
  const correlation = envelope && (envelope.sessionId || envelope.harnessVersion || envelope.capabilities)
    ? { sessionId: envelope.sessionId, harnessVersion: envelope.harnessVersion, capabilities: envelope.capabilities }
    : undefined;
  const refinement = {
    ...(envelope?.structuredOutput === undefined ? {} : { structuredOutput: envelope.structuredOutput }),
    ...(correlation === undefined ? {} : { correlation }),
  };
  const marker = envelope?.subtype ?? envelope?.status ?? envelope?.code;
  if (["error_max_turns", "error_max_budget_usd", "limit_exhausted", "budget_exhausted"].includes(marker ?? "")) {
    return { state: "delivered", outcome: "partial", reasonCode: "limit-exhausted", recoveryAdvice: "resume-with-session", ...refinement };
  }
  if (["is_error", "error_during_execution", "failed", "error"].includes(marker ?? "")) {
    return { state: "failed", blame: "task", reasonCode: marker, ...refinement };
  }
  return { state: "delivered", outcome: "fulfilled", ...refinement };
}
