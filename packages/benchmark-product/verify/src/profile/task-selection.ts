/**
 * Task-selection provenance, verified against the records that carry it (issue #2980).
 *
 * The declaration is a closed-vocabulary value sealed into the Run record's
 * `task-selection/v1` extension. Sealing makes it unforgeable after the lock; it does not make it
 * true. What remains for a cold verifier is the part sealing cannot settle: whether the *other*
 * sealed records are consistent with what the declaration asserts.
 *
 * Note what is deliberately NOT checked here. An earlier design compared the Benchmark's items
 * against the Matrix's task digests. That is unreachable by construction: `expectedCellSet` is the
 * full cartesian product `items x arms x replicates`, so the Matrix always covers every Benchmark
 * item exactly. In this record model the *selection is the Benchmark record itself*, so the facts
 * that can contradict a declared mode are the Benchmark's authorship and its reveal timing
 * relative to the Run's lock.
 */

import {
  readTaskSelectionMode,
  type BenchmarkRecord,
  type RunRecord,
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

function instant(value: string): number {
  return Date.parse(value);
}

/**
 * Whether the Benchmark's items were visible no later than the Run's lock.
 *
 * `immediate` is public from the moment the record exists. `scheduled` is public from `notBefore`,
 * and a schedule with no `notBefore` names no moment at all, so it cannot establish visibility
 * before the lock. `after-run` is withheld by definition.
 */
function publicByLock(benchmark: BenchmarkRecord, closeAt: string): boolean {
  const { policy, notBefore } = benchmark.reveal;
  if (policy === "immediate") return true;
  if (policy === "after-run") return false;
  return notBefore !== undefined && instant(notBefore) <= instant(closeAt);
}

/**
 * The declared mode, refusing rather than throwing raw on bytes the Run schema would not have
 * sealed. Exported so the reader's asset builder resolves the mode exactly once, through exactly
 * this refusal posture, instead of re-deriving it with its own error handling.
 */
export function declaredTaskSelectionMode(runRecord: RunRecord): ReturnType<typeof readTaskSelectionMode> {
  try {
    return readTaskSelectionMode(runRecord as unknown as Record<string, unknown>);
  } catch {
    refuse("record-integrity", PATH, "the Run's declared task selection is not one of the recorded selection modes");
  }
}

/**
 * Refuses a bundle whose sealed records contradict its declared task-selection mode.
 *
 * Two contradictions, both derivable from bundle bytes alone:
 *
 * 1. **The claimant authored the item bank.** The Benchmark record *is* the task selection, so a
 *    Run whose `owner` is the Benchmark's `author` was selected by the claimant, and neither of the
 *    two stronger modes can be true. An absent `author` cannot support them either: the records do
 *    not name anyone else who chose.
 * 2. **The reveal timing does not match the mode** — a "public" set still withheld at the lock, or
 *    a "post-lock draw" over items the claimant could already read before locking.
 *
 * `claimant-chosen` is unconstrained on purpose. It asserts nothing about anyone but the claimant,
 * so nothing can contradict it, and constraining it would only make the honest answer the
 * expensive one.
 */
export function assertTaskSelectionConsistency(input: TaskSelectionConsistencyInput): void {
  const { benchmarkRecord, runRecord } = input;
  const declared = declaredTaskSelectionMode(runRecord);
  if (declared === undefined || declared === "claimant-chosen") return;

  const author = benchmarkRecord.author;
  if (author === undefined) {
    refuse(
      "record-integrity",
      PATH,
      `task selection is declared ${declared} but the Benchmark record names no author, so the records`
        + " do not establish that anyone other than the claimant chose the tasks",
    );
  }
  if (author === runRecord.owner) {
    refuse(
      "record-integrity",
      PATH,
      `task selection is declared ${declared} but the claimant authored the Benchmark record, so the`
        + " claimant chose the tasks",
    );
  }

  const revealedByLock = publicByLock(benchmarkRecord, runRecord.closeAt);
  if (declared === "fixed-public-set" && !revealedByLock) {
    refuse(
      "record-integrity",
      PATH,
      "task selection is declared fixed-public-set but the Benchmark's reveal policy withholds its"
        + " items until after the run was locked",
    );
  }
  if (declared === "drawn-post-lock" && revealedByLock) {
    refuse(
      "record-integrity",
      PATH,
      "task selection is declared drawn-post-lock but the Benchmark's items were already revealed"
        + " when the run was locked, so nothing was drawn after the lock",
    );
  }
}
