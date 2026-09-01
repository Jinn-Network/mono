/**
 * `bind` (issue #2976): binds a sealed, not-yet-launched run to public randomness that postdates
 * its seal.
 *
 * Sealing shows the design existed by a given time. It does not show the run followed it: a party
 * could run privately, write a method describing what already happened, seal it, and re-run. This
 * operation closes that by deriving a run property — here, execution order — from a beacon value
 * that did not exist when the seal was taken. Predicting it is the only way to have selected around
 * it, which is why the binding is evidence rather than discipline.
 *
 * Five disciplines are the point of this module:
 *
 * - **A separate operation, like `anchor`.** `runLock` stays synchronous and irreversible; binding
 *   is a thing that happens after it or does not. `bind` is audited like every operation but is not
 *   approval-gated, for the reason `anchor` is not: it moves no funds and changes no lifecycle
 *   state. It is write-once and so irreversible, but the worst a binding can do is add a true
 *   statement about randomness this run could not have predicted — it cannot weaken a claim, alter
 *   a result, or make a run publishable that was not.
 * - **After lock, before launch.** A beacon that predates the seal binds nothing, and a beacon
 *   chosen after execution began binds nothing either — the operator would already know the run.
 *   Only `locked` is admitted, and `launchedAt` refuses independently of the draft state.
 * - **Verify before storing.** The record runs through `verifyRunBinding`, the same function an
 *   external reader recomputes with, before any bytes are written. A stored binding is never one
 *   nobody checked, and the recomputation — never the operator's declared order — is what is
 *   sealed.
 * - **Bind once.** Re-binding is re-drawing, which is precisely the post-hoc selection this
 *   procedure exists to make impossible. The operation refuses a second bind and `writeRunState`
 *   refuses it again for any writer, whatever the interleaving of two concurrent calls.
 * - **Bind to the round the seal names, not to a preferred one** (issue #3322). Binding once is not
 *   enough on its own: admitting any round later than the seal leaves the operator watching the
 *   rounds published between lock and launch, deriving what each would produce, and binding the one
 *   they like. So for a source whose rounds follow a published schedule this operation refuses every
 *   round but `requiredBeaconRound` -- the first the source publishes strictly after the seal, which
 *   `(source, sealedAt)` already determines, so no separate commitment record is needed. A
 *   height-indexed source has no such round, and that residue is still reported rather than refused:
 *   even with the source sealed, the report face says the height was the operator's choice.
 * - **Bind to the source the seal names** (issue #3426). The round rule above is only as strong as
 *   the source it applies to, and one admitted source is indexed by block height, where no round
 *   follows from a seal at all and the postdating check is never reached. Left open, the source
 *   selection undoes the round rule outright. So a run whose sealed record declares a beacon binds
 *   to that beacon and this operation refuses any other; a run that declared none keeps the choice,
 *   and the report face keeps saying so.
 * - **The beacon reference is operator-supplied, and that is sound.** This operation does no
 *   network I/O: a public beacon's `(round, value)` pair is published, so a reader checks the pair
 *   against the beacon itself and recomputes the derivation from it. Fetching the value here would
 *   move no trust — the operator would still be the one reporting it — while adding an endpoint to
 *   the pre-launch path. What a reader must not have to trust is the DERIVATION, and that is
 *   recomputed rather than reported.
 *
 * The binding this operation writes is always `census` mode: every task in the sealed Benchmark
 * runs, so there is no slate to draw and the beacon binds execution ORDER only — the weaker of the
 * two bindings, and the report face says so. `beacon-binding/1` carries the `sampled` mode for a
 * slate drawn from a larger pool; no run shape in this product samples one today.
 */

import { itemTaskDigest, parseBenchmark } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/task-execution-profiles";
import {
  BEACON_BINDING_PROCEDURE,
  BEACON_SOURCES,
  BeaconReferenceSchema,
  RunBindingError,
  computeBeaconOrder,
  requiredBeaconRound,
  runBindingSentence,
  verifyRunBinding,
} from "@colophon-claims/verify";
import type { BeaconReference, VerifiedRunBinding } from "@colophon-claims/verify";
import { readRunDeclaredBeaconSource } from "../binding/carriage.js";
import { refuse } from "../errors.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface RunBindInput {
  readonly draftId: string;
  /** The public beacon reference: which beacon, which round or height, and the value it published. */
  readonly beacon: BeaconReference;
}

export interface RunBindResult {
  /** sha256 hex of the sealed binding record's exact bytes. */
  readonly recordSha256: string;
  readonly boundAt: string;
  /** The recomputed binding — never the declared one. */
  readonly binding: VerifiedRunBinding;
  /** The report face's one sentence: which binding applied, and what it does not establish. */
  readonly statement: string;
}

export function runBind(context: OperationContext, input: RunBindInput): OperationResult<RunBindResult> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "bind",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const beacon = BeaconReferenceSchema.safeParse(input.beacon);
      if (!beacon.success) {
        const issue = beacon.error.issues[0]!;
        refuse("validation", `beacon.${issue.path.join(".")}`, issue.message);
      }

      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (document.state !== "locked") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — a run binds after it is locked and before it is launched`,
        );
      }

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      if (runState.runSha256 === undefined || runState.lockedAt === undefined) {
        refuse("conflict", `runs.${input.draftId}`, `draft ${input.draftId} has no sealed Run record yet — lock it first`);
      }
      if (runState.launchedAt !== undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}.launchedAt`,
          "this run has already launched — a beacon chosen after execution began binds nothing",
        );
      }
      if (runState.binding !== undefined) {
        refuse(
          "conflict",
          `runs.${input.draftId}.binding`,
          "this run is already bound — a run binds once, because re-binding is re-drawing",
        );
      }
      if (document.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, `draft ${input.draftId} has no attached benchmark`);
      }

      // The source the SEAL named (#3426), read out of the sealed Run bytes rather than out of the
      // draft: the draft is immutable after lock, but the seal is the thing a reader recomputes
      // from, so it is the only answer that cannot disagree with theirs. Refusing here is what
      // makes the #3322 round rule effective at all: without it an operator who disliked the round
      // the seal named could select the height-indexed source instead, where no round follows from
      // a seal and the postdating check is never reached, and bind any height the chain carries.
      const declaredSource = readRunDeclaredBeaconSource(clockedContext.workspaceDir, runState.runSha256);
      if (declaredSource !== undefined && declaredSource !== beacon.data.source) {
        refuse(
          "validation",
          `runs.${input.draftId}.binding.beacon.source`,
          `this run's sealed record names ${declaredSource} as the beacon it binds to, and this binding names `
          + `${beacon.data.source}. The source is fixed at the seal for the same reason the round is: leaving it `
          + "open would let an operator who disliked the round the seal named bind a different beacon instead",
        );
      }

      // Only a LATER round is refused here. An earlier one does not postdate the seal at all, and
      // `verifyRunBinding` below refuses it in those terms -- the more informative refusal for that
      // input, and the one an external reader recomputing the record would reach too.
      const required = requiredBeaconRound(beacon.data.source, runState.lockedAt);
      if (required !== undefined && beacon.data.round > required.round) {
        refuse(
          "validation",
          `runs.${input.draftId}.binding.beacon.round`,
          `this run may bind only to ${BEACON_SOURCES[beacon.data.source].displayName} round ${required.round}, `
          + `published at ${required.publishedAt} — the first round this source publishes after the seal at `
          + `${runState.lockedAt} — and this binding names round ${beacon.data.round}. Admitting any later round `
          + "would leave the operator free to watch the rounds published since the seal and bind the one whose "
          + "derivation they preferred, so the value would be unpredictable but the choice among realized values "
          + "would not be",
        );
      }

      const benchmark = parseBenchmark(
        getSealedBytes(clockedContext.workspaceDir, document.spec.taskSet.benchmarkSha256),
      );
      const itemSha256s = [...new Set(benchmark.items.map((item) => `sha256:${itemTaskDigest(item)}`))];
      const sealDigest = `sha256:${runState.runSha256}`;

      let order: readonly string[];
      try {
        order = computeBeaconOrder({ sealDigest, beaconValue: beacon.data.value, itemSha256s }).order;
      } catch (cause) {
        if (cause instanceof RunBindingError) refuse("validation", cause.path, cause.message);
        throw cause;
      }

      const bytes = canonicalJsonBytes({
        procedure: BEACON_BINDING_PROCEDURE,
        mode: "census",
        sealDigest,
        sealedAt: runState.lockedAt,
        // Restated from the seal, the way `sealedAt` is, so the binding record is checkable on its
        // own; omitted entirely when the run declared nothing, so a run that predates this
        // declaration seals byte-identical binding bytes.
        ...(declaredSource === undefined ? {} : { declaredSource }),
        beacon: beacon.data,
        itemSha256s,
        order,
      });
      // Verified from the exact bytes that are about to be stored, through the same function every
      // later read and every external reader uses -- including the post-seal check, which is what
      // refuses a beacon round that predates the seal. A failure here is the operator's input, so
      // it is `validation`; the identical check on a later READ is `record-integrity`, because by
      // then the same bytes have already passed it once (`../binding/carriage.ts`).
      let binding: VerifiedRunBinding;
      try {
        binding = verifyRunBinding(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
      } catch (cause) {
        if (cause instanceof RunBindingError) refuse("validation", `runs.${input.draftId}.binding.${cause.path}`, cause.message);
        throw cause;
      }
      const recordSha256 = putSealedBytes(clockedContext.workspaceDir, bytes);

      writeRunState(clockedContext.workspaceDir, input.draftId, {
        ...runState,
        binding: { recordSha256, boundAt: at },
      });

      return { recordSha256, boundAt: at, binding, statement: runBindingSentence(binding) };
    },
  });
}
