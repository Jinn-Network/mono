/**
 * Task-selection provenance, verified against the records that carry it (issue #2980).
 *
 * The declaration is a closed-vocabulary value sealed into the Run record's
 * `task-selection/v1` extension. Sealing makes it unforgeable after the lock; it does not make it
 * true. What remains for a cold verifier is the part sealing cannot settle: whether the *other*
 * sealed records are consistent with what the declaration asserts.
 *
 * In this record model the *selection is the Benchmark record itself*: the Run seals a Benchmark
 * digest, and `expectedCellSet` is the full cartesian product `items x arms x replicates`, so the
 * Matrix always covers every Benchmark item exactly. Comparing the Matrix's task digests against
 * the Benchmark's items — the first thing this module tried — is therefore dead code. What is left
 * is the Benchmark's own reveal policy and whether anyone declared the set at all.
 *
 * These checks are refusals, not endorsements, and the asymmetry is the point: each one names a
 * declaration the records positively contradict. None of them can establish that a declaration is
 * TRUE, because the bundle carries no independent witness of an upstream set. `assertTaskSelection-
 * Consistency` below says exactly where that boundary falls and why the tempting rule on the other
 * side of it is unsound.
 */

import {
  compareCalendarStrictRfc3339Instants,
  readTaskSelectionMode,
  type BenchmarkRecord,
  type RunRecord,
  type TaskSelectionMode,
} from "@jinn-network/benchmarking-records";
import { refuse } from "./errors.js";

/** The verification path every refusal here is reported under. Adding a new named check would be a
 * bundle-format bump — the claim pins the check list byte-for-byte — so these refusals join the
 * existing `claim-consistency` check, which is exactly the question they answer. */
const PATH = "claim-consistency";

export interface TaskSelectionConsistencyInput {
  readonly benchmarkRecord: BenchmarkRecord;
  readonly runRecord: RunRecord;
}

/**
 * Whether the Benchmark's items were PROVABLY still withheld when the Run sealed against them.
 *
 * Deliberately one-directional, and the reason is a real trap. The only instant a cold verifier
 * can read out of a sealed Run is `closeAt`, which is the run's CLOSE, not its lock —
 * `closeAt = lockedAt + policy.closeAfterMs` with a strictly positive interval (24h by default),
 * and `lockedAt` lives only in product-local state that no bundle carries. So `notBefore <= closeAt`
 * establishes nothing about the lock: a schedule opening twelve hours into a twenty-four-hour run
 * satisfies it while the items were plainly withheld at the lock. Only the far side is safe —
 * `notBefore >= closeAt > lockedAt` proves withholding — so that is the only comparison made.
 *
 * The comparator is the records package's own, not `Date.parse`, and that is a correctness
 * requirement rather than a preference. These fields are validated by `isCalendarStrictRfc3339`,
 * which accepts leap seconds; V8's `Date.parse` returns `NaN` for exactly those spellings, and
 * `NaN >= x` is `false`. Left on `Date.parse`, a claimant could seal
 * `notBefore: "2026-12-31T23:59:60Z"` — items withheld past the run's end — declare
 * `fixed-public-set`, and have both this check and the producer's pre-lock gate wave it through.
 * An uncomparable pair fails CLOSED for the same reason: it cannot arise from schema-valid records,
 * so treating it as proof of withholding costs nothing and removes the fail-open shape entirely.
 *
 * A `scheduled` reveal with no `notBefore` fails closed on the same principle. The Benchmark schema
 * leaves `notBefore` optional under every policy, so `{ "policy": "scheduled" }` seals cleanly while
 * announcing no instant at which the items become readable — strictly more withheld than
 * `after-run`, which at least names the run's end. Reading it as open would hand a claimant a
 * one-key evasion of the only reveal-policy teeth `fixed-public-set` has: delete the field, and a
 * privately assembled set passes the check that `after-run` fails.
 */
function withheldAtLock(benchmark: BenchmarkRecord, closeAt: string): boolean {
  const { policy, notBefore } = benchmark.reveal;
  if (policy === "after-run") return true;
  if (policy !== "scheduled") return false;
  if (notBefore === undefined) return true;
  const order = compareCalendarStrictRfc3339Instants(notBefore, closeAt);
  return order === undefined || order >= 0;
}

/**
 * The declared mode, refusing rather than throwing raw on bytes the Run schema would not have
 * sealed. Exported so the reader's asset builder resolves the mode exactly once, through exactly
 * this refusal posture, instead of re-deriving it with its own error handling.
 */
export function declaredTaskSelectionMode(runRecord: RunRecord): TaskSelectionMode | undefined {
  try {
    return readTaskSelectionMode(runRecord as unknown as Record<string, unknown>);
  } catch (cause) {
    refuse(
      "record-integrity",
      PATH,
      `the Run's declared task selection is not one of the recorded selection modes: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * The way the sealed records contradict a declared task-selection mode, or `undefined` when they
 * do not. Pure, and shared deliberately: the producer calls it BEFORE the lock so a contradiction
 * is a draft-validation refusal the claimant can still act on, and the cold verifier calls it after
 * the fact through {@link assertTaskSelectionConsistency}. One rule, two postures — a second copy
 * would be free to drift into refusing at publish what it accepted at lock, which is the worst
 * possible place to disagree.
 *
 * Two contradictions, both provable from bundle bytes:
 *
 * 1. **`fixed-public-set` over an undeclared set.** A set nobody declared is not a publicly
 *    declared set, so the Benchmark record must at least name an `author`.
 * 2. **Reveal policy that cannot coexist with the mode.** `fixed-public-set` is refused when the
 *    items were provably withheld at the lock; `drawn-post-lock` is refused when they were
 *    `immediate` — open the moment the record existed, so the Run sealed against a set the
 *    claimant could already read, and nothing was drawn afterwards.
 *
 * What this deliberately does NOT do is decide the stronger modes from `benchmark.author` versus
 * `run.owner`. That rule looks decisive and is not: `author` is a self-declaration the design spec
 * marks non-authoritative, and every task-set intake in this product re-authors the Benchmark under
 * the workspace's own key (`intake/workspace-authored.ts`), which is also the Run's owner. Enforcing
 * on it would refuse every bundle this product can produce, making two of the three vocabulary
 * values dead letters.
 *
 * So the honest boundary: these checks catch declarations the records positively contradict, but
 * none can prove a `fixed-public-set` claim TRUE — the bundle carries no independent witness of the
 * upstream set. `PUBLIC-BUNDLE.md` says so in the same words, because a gap a reader can see is
 * worth more than one a rule pretends to close.
 *
 * `claimant-chosen` is unconstrained on purpose. It asserts nothing about anyone but the claimant,
 * so nothing can contradict it, and constraining it would only make the honest answer the
 * expensive one.
 */
export function taskSelectionContradiction(input: TaskSelectionConsistencyInput): string | undefined {
  const { benchmarkRecord, runRecord } = input;
  const declared = declaredTaskSelectionMode(runRecord);
  if (declared === undefined || declared === "claimant-chosen") return undefined;

  if (declared === "fixed-public-set") {
    if (benchmarkRecord.author === undefined) {
      return "task selection is declared fixed-public-set but the Benchmark record names no author,"
        + " so the set it describes was never publicly declared by anyone";
    }
    if (withheldAtLock(benchmarkRecord, runRecord.closeAt)) {
      return "task selection is declared fixed-public-set but the Benchmark's reveal policy withholds"
        + " its items past the end of the run, so they were not public when the run was locked";
    }
    return undefined;
  }

  if (benchmarkRecord.reveal.policy === "immediate") {
    return "task selection is declared drawn-post-lock but the Benchmark reveals its items"
      + " immediately, so the run was locked against a set the claimant could already read";
  }
  return undefined;
}

/** The cold verifier's posture over {@link taskSelectionContradiction}: a typed record refusal. */
export function assertTaskSelectionConsistency(input: TaskSelectionConsistencyInput): void {
  const contradiction = taskSelectionContradiction(input);
  if (contradiction !== undefined) refuse("record-integrity", PATH, contradiction);
}
