import {
  BENCHMARKING_PROTOCOL,
  parseRun,
  sealRun,
  type RunArm,
  type RunRecord,
} from "@jinn-network/benchmarking-records";

/**
 * Declarative plan input for §10.1 op 2. Execution venue is a dispatch choice later —
 * `planRun` only seals the Run record.
 */
export interface BenchmarkPlanInput {
  benchmarkDigest: string;
  owner: string;
  arms: RunArm[];
  replicates: number;
  policy: RunRecord["policy"];
  analysisPlan?: RunRecord["analysisPlan"];
  budget?: RunRecord["budget"];
  venue?: RunRecord["venue"];
  closeAt: string;
}

export interface PlannedRun {
  record: RunRecord;
  bytes: Uint8Array;
  digest: `sha256:${string}`;
}

/** Side-effect-free: validate + seal a Run from a declarative plan (§10.1 op 2). */
export function planRun(input: BenchmarkPlanInput): PlannedRun {
  if (typeof input.closeAt !== "string" || input.closeAt.length === 0) {
    throw new Error("closeAt is required on every Run (§7.1)");
  }
  const digestHex = input.benchmarkDigest.startsWith("sha256:")
    ? input.benchmarkDigest.slice("sha256:".length)
    : input.benchmarkDigest;
  const document: Record<string, unknown> = {
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: digestHex } },
    owner: input.owner,
    arms: input.arms,
    replicates: input.replicates,
    policy: input.policy,
    closeAt: input.closeAt,
  };
  if (input.analysisPlan !== undefined) document.analysisPlan = input.analysisPlan;
  if (input.budget !== undefined) document.budget = input.budget;
  if (input.venue !== undefined) document.venue = input.venue;
  const sealed = sealRun(document);
  return {
    record: parseRun(sealed.bytes),
    bytes: sealed.bytes,
    digest: sealed.digest,
  };
}
