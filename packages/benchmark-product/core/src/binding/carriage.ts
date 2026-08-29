/**
 * Workspace-side binding carriage (issue #2976): the one place that turns `RunState.binding` into
 * the verified `beacon-binding/1` projection a report face states.
 *
 * The same three rules `../anchor/carriage.ts` states, for the same reasons:
 *
 * - **Bytes come out of the sealed store, never out of RunState.** RunState names one record
 *   digest; `getSealedBytes` re-verifies it on read, so a binding edited in place surfaces as its
 *   own `record-integrity` refusal naming the store path before anything projects it.
 * - **The projection is the shared one.** `verifyRunBinding` lives in `@colophon-claims/verify` and
 *   is the same function an external reader recomputes with. A second local implementation would
 *   turn "the verifier recomputes and fails on mismatch" into a comparison of two guesses.
 * - **A projection failure is a typed product refusal**, never a swallowed throw crossing a
 *   package boundary.
 */

import { RunBindingError, verifyRunBinding } from "@colophon-claims/verify";
import type { VerifiedRunBinding } from "@colophon-claims/verify";
import { refuse } from "../errors.js";
import type { RunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

/** The verified binding this run recorded, or `undefined` for a run that has never bound. */
export function readRunBindingCarriage(
  workspaceDir: string,
  runState: Pick<RunState, "binding">,
): VerifiedRunBinding | undefined {
  const recorded = runState.binding;
  if (recorded === undefined) return undefined;
  const bytes = getSealedBytes(workspaceDir, recorded.recordSha256);
  return projectBindingBytes(bytes, `records/${recorded.recordSha256}.bin`);
}

/**
 * Parses and verifies one binding record's exact bytes. Shared with the `bind` operation so the
 * record is verified by the same function before it is stored and on every read afterwards — a
 * stored binding is never one nobody checked.
 */
export function projectBindingBytes(bytes: Uint8Array, path: string): VerifiedRunBinding {
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch (cause) {
    refuse("record-integrity", path, `binding record is not valid UTF-8 JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    return verifyRunBinding(candidate);
  } catch (cause) {
    if (cause instanceof RunBindingError) {
      refuse("record-integrity", path, cause.message);
    }
    throw cause;
  }
}
