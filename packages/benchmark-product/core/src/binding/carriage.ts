/**
 * Workspace-side binding carriage (issue #2976): the one place that turns `RunState.binding` into
 * the verified `beacon-binding/1` projection a report face states.
 *
 * The same three rules `../anchor/carriage.ts` states, for the same reasons:
 *
 * - **Bytes come out of the sealed store, never out of RunState.** RunState names one record
 *   digest; `getSealedBytes` re-verifies it on read, so a binding edited in place surfaces as its
 *   own `record-integrity` refusal naming the store path before anything projects it.
 * - **The projection is the shared one.** `verifyRunBinding` lives in `@colophon-claims/check` and
 *   is the same function an external reader recomputes with. A second local implementation would
 *   turn "the verifier recomputes and fails on mismatch" into a comparison of two guesses.
 * - **The record must belong to THIS run, and that rule is also the shared one.**
 *   `verifyRunBinding` proves a record is internally consistent -- that its declared order derives
 *   from the `sealDigest` it itself carries, and that its beacon postdates the `sealedAt` it itself
 *   carries. It cannot know which run the record was written for, and `getSealedBytes` cannot
 *   either: a foreign record filed under its own true digest passes both. So the fields the
 *   postdating claim rests on are compared against this run's own sealed identity, exactly as
 *   `readRunAnchorCarriage` refuses an anchor whose subject is neither this bundle's Run nor its
 *   Matrix. Without it a run sealed after its results were known could point at an older run's
 *   honest binding and print "proven-offline" over a link nothing verified. Since issue #3370 a
 *   published bundle carries the record too, so a reader makes the same comparison -- and this
 *   module's own argument for sharing `verifyRunBinding` applies verbatim to the comparison itself:
 *   a second local implementation would turn "the verifier recomputes and fails on mismatch" into a
 *   comparison of two guesses. The rule is therefore `assertRunBindingLinkage` in
 *   `@colophon-claims/check`, and what this side still owns is only WHERE its four inputs are read:
 *   from the workspace's own `RunState` and sealed store rather than from a bundle's members.
 * - **A projection failure is a typed product refusal**, never a swallowed throw crossing a
 *   package boundary.
 */

import { RunBindingError, assertRunBindingLinkage, verifyRunBinding } from "@colophon-claims/check";
import type { VerifiedRunBinding } from "@colophon-claims/check";
import { parseRun, readBeaconSource } from "@jinn-network/benchmarking-records";
import { refuse } from "../errors.js";
import type { RunState } from "../run/state.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

/** The verified binding this run recorded, or `undefined` for a run that has never bound. */
export function readRunBindingCarriage(
  workspaceDir: string,
  runState: Pick<RunState, "binding" | "runSha256" | "lockedAt">,
): VerifiedRunBinding | undefined {
  const recorded = runState.binding;
  if (recorded === undefined) return undefined;
  if (runState.runSha256 === undefined || runState.lockedAt === undefined) {
    refuse(
      "conflict",
      "runs.binding",
      "this run carries a beacon binding but has no sealed Run identity to resolve its subject against",
    );
  }
  const path = `records/${recorded.recordSha256}.bin`;
  const binding = projectBindingBytes(getSealedBytes(workspaceDir, recorded.recordSha256), path);
  try {
    assertRunBindingLinkage({
      binding,
      runSha256: runState.runSha256,
      // `lockedAt` rather than the Run's own declared instant: workspace-side this IS the
      // authoritative seal time, it is always present for a locked run, and for a run whose Run
      // declares one the two are the same instant by construction -- `run lock` writes both from a
      // single clock reading. Passing it unconditionally also keeps the comparison running for every
      // run this side sees, including one sealed before the declaration existed.
      sealedAt: runState.lockedAt,
      declaredSource: readRunDeclaredBeaconSource(workspaceDir, runState.runSha256),
    });
  } catch (cause) {
    if (cause instanceof RunBindingError) {
      refuse("record-integrity", path, cause.message);
    }
    throw cause;
  }
  return binding;
}

/**
 * The beacon source this run's SEALED Run record declares (#3426), or `undefined` when it declares
 * none. Read from the sealed bytes on every call rather than mirrored into `RunState`: the seal is
 * what makes the declaration unforgeable after the lock, and a mutable copy beside it would be a
 * second answer free to disagree with the one every reader recomputes from.
 */
export function readRunDeclaredBeaconSource(workspaceDir: string, runSha256: string): string | undefined {
  const path = `records/${runSha256}.bin`;
  let run: Record<string, unknown>;
  try {
    run = parseRun(getSealedBytes(workspaceDir, runSha256)) as unknown as Record<string, unknown>;
  } catch (cause) {
    // A raw schema throw must not cross this package boundary, for the reason the module header
    // gives: it reaches an operator as an internal failure rather than as "this Run does not
    // conform". `getSealedBytes` has already re-verified the digest, so anything left is the
    // record's own shape.
    refuse("record-integrity", path, `sealed Run record does not conform: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return readBeaconSource(run);
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
