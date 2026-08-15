/**
 * Seed a scorable SWE-rebench v2 admission record for the T2.4 known instance.
 *
 * The real SweRebenchV2EvaluatorHarness.recheckSubstrate() (harness.ts:467)
 * hard-requires `ValidatedPoolStore.getEntry(instance_id, EVAL_SEMANTICS_VERSION)`
 * to return a scorable entry before it will grade a patch. On a fresh Anvil-fork
 * daemon-harness world there is no `~/.jinn-client` substrate, so this seeds the
 * minimal scorable entry into the evaluator daemon's state dir.
 *
 * `rowHash` and `imageDigest` are intentionally omitted so the seeded record
 * passes the drift checks (recheckSubstrate only recomputes drift `if
 * (admission.rowHash)` / `if (admission.imageDigest)`, harness.ts:502/:544)
 * while the live HF row fetch (`fetchTaskRow`, harness.ts:485) stays a genuine
 * precondition — see the #898 plan OPEN DECISION (b).
 */
import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
} from '../../../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { KNOWN_INSTANCE_ID } from './known-instance.js';

export async function seedKnownInstanceAdmission(stateDir: string): Promise<void> {
  const store = new ValidatedPoolStore({ stateDir });
  await store.record(
    KNOWN_INSTANCE_ID,
    {
      scorable: true,
      reason: 'gold-patch-resolves',
      checkedAt: new Date().toISOString(),
    },
    EVAL_SEMANTICS_VERSION,
  );
}
