import type { MatrixCell, RunRecord } from "@jinn-network/benchmarking-records";
import { venueIsolationPostureForPolicy } from "./isolation.js";

export const LOCAL_VENUE_LIMITS: readonly string[] = [
  "This is a local, self-run venue: the same operator controls task dispatch, execution, and evaluation.",
  "Pre-registration here is a discipline enforced by this tool, not a proof against the run's own owner — nothing prevents the owner from having altered the record before publishing it.",
  "Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is vacuous: this venue's launchers admit only one isolation policy, so matching it proves nothing about containment strength.",
  "Cost figures, where present, are self-reported by this venue and were never independently settled.",
  "Distinct solver and evaluator identities prove agent-distinctness only — each evaluator identity is backed by its own workspace-minted signing key, whose verdict signature this product verifies — not that they are independent real-world parties.",
];
const MULTI = "Run pinning on the harness, model, and loadout axes is enforced by an admission gate at dispatch time. The isolation axis is unverifiable: this configured venue admits both unrestricted and OCI-container execution, so its multi-policy inventory cannot establish containment from admission alone.";
export function localVenueLimitsForRun(run: Pick<RunRecord, "policy">): readonly string[] {
  return venueIsolationPostureForPolicy(run.policy.submissionBaseline?.isolationPolicy).inventory.length === 1 ? LOCAL_VENUE_LIMITS : [LOCAL_VENUE_LIMITS[0]!, LOCAL_VENUE_LIMITS[1]!, MULTI, ...LOCAL_VENUE_LIMITS.slice(3)];
}
export function buildLocalVenueHonesty(cells: readonly MatrixCell[], run: Pick<RunRecord, "policy">) {
  const counts = { harness: 0, model: 0, loadout: 0, isolation: 0 };
  for (const cell of cells) for (const axis of Object.keys(counts) as Array<keyof typeof counts>) if (cell.verification[axis] === "unverifiable") counts[axis] += 1;
  return { venue: "self-run" as const, preRegistration: "structural-and-append-order-only" as const, limits: localVenueLimitsForRun(run), unverifiableAxisCounts: counts };
}
