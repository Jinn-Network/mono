/**
 * Normalizes SkillsBench verifier output into Demo-1's outcome vocabulary.
 *
 * Every active task declares `verifier.type: test-script`, and the shipped contract is a pytest run
 * that writes `1` or `0` to `/logs/verifier/reward.txt` and a CTRF report to
 * `/logs/verifier/ctrf.json`. The primary outcome is a full pass — reward equal to the task's own
 * canonical full-success value — and the raw reward is retained as secondary evidence.
 *
 * No upstream verifier is modified to make this work. Where a task's semantics do not fit, the
 * outcome is `unscorable` with a reason rather than a coerced number.
 */
export const SKILLSBENCH_REWARD_CONTRACT = "skillsbench-reward-txt+ctrf@1" as const;

/** The reward a task must reach to count as a full pass unless it declares otherwise. */
export const SKILLSBENCH_DEFAULT_FULL_SUCCESS = 1 as const;

export type SkillsBenchOutcome = "full-pass" | "partial" | "fail" | "unscorable";

export interface SkillsBenchCtrfSummary {
  readonly tests: number;
  readonly passed: number;
  readonly failed: number;
}

export interface SkillsBenchRewardReading {
  readonly contract: typeof SKILLSBENCH_REWARD_CONTRACT;
  readonly outcome: SkillsBenchOutcome;
  readonly rawReward: number | null;
  readonly canonicalFullSuccess: number;
  readonly ctrf: SkillsBenchCtrfSummary | null;
  readonly detail: string;
}

function unscorable(detail: string, canonicalFullSuccess: number, ctrf: SkillsBenchCtrfSummary | null = null): SkillsBenchRewardReading {
  return { contract: SKILLSBENCH_REWARD_CONTRACT, outcome: "unscorable", rawReward: null, canonicalFullSuccess, ctrf, detail };
}

/** Parses the CTRF report's summary. Absent or malformed CTRF is not fatal — reward.txt is primary. */
export function parseSkillsBenchCtrf(text: string | null): SkillsBenchCtrfSummary | null {
  if (text === null || text.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const summary = (parsed as { results?: { summary?: Record<string, unknown> } })?.results?.summary;
  if (summary === undefined) return null;
  const number = (key: string): number | null => {
    const value = summary[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const tests = number("tests");
  const passed = number("passed");
  const failed = number("failed");
  if (tests === null || passed === null || failed === null) return null;
  return { tests, passed, failed };
}

export interface SkillsBenchRewardInput {
  /** Exact bytes of `/logs/verifier/reward.txt`, or null when the file is absent. */
  readonly rewardTxt: string | null;
  /** Exact bytes of `/logs/verifier/ctrf.json`, or null. */
  readonly ctrfJson?: string | null;
  /** The task's canonical full-success reward. Never assumed — read from the unit. */
  readonly canonicalFullSuccess?: number;
}

export function readSkillsBenchReward(input: SkillsBenchRewardInput): SkillsBenchRewardReading {
  const canonicalFullSuccess = input.canonicalFullSuccess ?? SKILLSBENCH_DEFAULT_FULL_SUCCESS;
  const ctrf = parseSkillsBenchCtrf(input.ctrfJson ?? null);

  if (!Number.isFinite(canonicalFullSuccess) || canonicalFullSuccess <= 0) {
    return unscorable(`canonical full-success value ${canonicalFullSuccess} is not a positive finite number`, canonicalFullSuccess, ctrf);
  }
  if (input.rewardTxt === null) {
    // A missing reward file is the verifier not having produced an outcome. That is not a fail —
    // treating it as one would silently convert infrastructure trouble into evidence.
    return unscorable("reward.txt is absent; the verifier produced no outcome", canonicalFullSuccess, ctrf);
  }
  const trimmed = input.rewardTxt.trim();
  if (trimmed.length === 0) return unscorable("reward.txt is empty", canonicalFullSuccess, ctrf);
  if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) {
    return unscorable(`reward.txt is not a decimal number: ${JSON.stringify(trimmed.slice(0, 40))}`, canonicalFullSuccess, ctrf);
  }
  const rawReward = Number(trimmed);
  if (!Number.isFinite(rawReward)) return unscorable("reward.txt is not finite", canonicalFullSuccess, ctrf);
  if (rawReward < 0 || rawReward > canonicalFullSuccess) {
    return unscorable(
      `reward ${rawReward} is outside [0, ${canonicalFullSuccess}]`,
      canonicalFullSuccess,
      ctrf,
    );
  }

  const outcome: SkillsBenchOutcome = rawReward === canonicalFullSuccess
    ? "full-pass"
    : rawReward === 0 ? "fail" : "partial";
  return {
    contract: SKILLSBENCH_REWARD_CONTRACT,
    outcome,
    rawReward,
    canonicalFullSuccess,
    ctrf,
    detail: `reward ${rawReward} of ${canonicalFullSuccess}`,
  };
}

/**
 * The two no-model controls, judged together.
 *
 * A unit is dynamically eligible only when the authenticated oracle reaches full success AND a
 * blank submission does not. Either half missing leaves the unit unverifiable — a no-op that fails
 * proves nothing on its own if the oracle never passed.
 */
export function judgeSkillsBenchControls(
  oracle: SkillsBenchRewardReading,
  noOp: SkillsBenchRewardReading,
): { readonly eligible: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];
  if (oracle.outcome !== "full-pass") reasons.push(`oracle-did-not-reach-full-success:${oracle.outcome}`);
  if (noOp.outcome === "full-pass") reasons.push("no-op-submission-reached-full-success");
  if (noOp.outcome === "unscorable") reasons.push("no-op-control-unscorable");
  if (oracle.canonicalFullSuccess !== noOp.canonicalFullSuccess) {
    reasons.push("controls-disagree-on-canonical-full-success");
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}
