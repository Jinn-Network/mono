/**
 * `disclosure declare` and `disclosure show` (disclosure-specification-record design §10.3, issue
 * #2839): the operation that seals this run's six-variable declaration, and the read-back.
 *
 * Five disciplines, each one the reason this is an operation rather than a config field:
 *
 * - **The subject is the Matrix, so the window OPENS at collect.** The record names the sealed
 *   Matrix digest (design §7 step 3), which does not exist before `run.collect`. Declaring earlier
 *   would have nothing to name.
 * - **The window CLOSES at report, exactly as anchoring's does.** The claim package's `disclosure`
 *   section is a report-time projection, and `report` runs once. A declaration made afterwards could
 *   never enter any claim, and because publication byte-compares the sealed claim against the record
 *   the bundle carries, storing one would silently brick `publish` for a run that has done nothing
 *   wrong. Refusing at declaration puts that in front of the operator while they can still act.
 * - **`author` comes from the workspace, never from the declarer.** It is `runState.owner`, which is
 *   the same value `report` passes as the Report's `author`, so the verifier's §7 step 4 author
 *   binding holds by construction rather than by anyone typing the right IRI.
 * - **Idempotent before report, and re-declarable.** Unlike an anchor — which is third-party evidence
 *   and therefore write-once — a declaration is the venue's own statement about its own experiment,
 *   and a venue that notices its own statement is wrong before reporting should fix it. Re-declaring
 *   replaces the recorded digest; the superseded record's bytes stay in the content-addressed store,
 *   because nothing there is ever deleted.
 * - **Nothing derivable is stored.** RunState records the record's digest and nothing else. Every
 *   fact about the declaration — the six statuses included — is read back from the sealed bytes.
 */

import {
  DISCLOSURE_VARIABLE_KEYS,
  parseDisclosureSpecification,
  type DisclosureVariableEntry,
  type DisclosureVariableKey,
} from "@jinn-network/benchmarking-records";
import { refuse } from "../errors.js";
import { sealDisclosureDeclaration } from "../disclosure/state.js";
import { requireRunState, writeRunState } from "../run/state.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface DisclosureDeclareInput {
  readonly draftId: string;
  /** The six variable entries, in the shape `DisclosureDeclarationSchema` accepts. */
  readonly declaration: unknown;
}

export interface DisclosureDeclareResult {
  readonly recordSha256: string;
  readonly subjectSha256: string;
  readonly author: string;
  /** Derived from the sealed record on the way out, never stored. */
  readonly statuses: Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry["status"]>>;
  /** True when this call replaced an earlier declaration on the same run. */
  readonly replaced: boolean;
}

/** Seals this run's disclosure-specification record and records its digest. Gated like every other
 * operation; see `../authority/policy.ts`. */
export function disclosureDeclare(
  context: OperationContext,
  input: DisclosureDeclareInput,
): OperationResult<DisclosureDeclareResult> {
  return operate({
    context,
    action: "disclosure.declare",
    subject: input.draftId,
    inputs: { draftId: input.draftId },
    run: () => {
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.matrixSha256 === undefined) {
        refuse(
          "illegal-transition",
          `runs.${input.draftId}.matrixSha256`,
          "the disclosure record names this run's sealed Matrix; close and collect the run before declaring",
        );
      }
      if (state.reportedAt !== undefined) {
        refuse(
          "illegal-transition",
          `runs.${input.draftId}.reportedAt`,
          "this run is already reported and its sealed claim states the disclosure it had then; a"
          + " declaration made now could never enter that claim — declare before reporting",
        );
      }
      const sealed = sealDisclosureDeclaration({
        declaration: input.declaration,
        author: state.owner,
        matrixSha256: state.matrixSha256,
      });
      putSealedBytes(context.workspaceDir, sealed.bytes);
      const replaced = state.disclosureSha256 !== undefined && state.disclosureSha256 !== sealed.sha256;
      writeRunState(context.workspaceDir, input.draftId, {
        ...state,
        disclosureSha256: sealed.sha256,
      });
      return {
        recordSha256: sealed.sha256,
        subjectSha256: state.matrixSha256,
        author: state.owner,
        statuses: sealed.statuses,
        replaced,
      };
    },
  });
}

export interface DisclosureShowResult {
  readonly recordSha256: string;
  readonly specification: string;
  readonly subjectSha256: string;
  readonly author: string;
  readonly variables: Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry>>;
}

/**
 * Reads the sealed record back. Every field returned is parsed out of the stored bytes — this is a
 * view of the record, not of any product state that might have drifted from it.
 */
export function disclosureShow(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<DisclosureShowResult> {
  return operate({
    context,
    action: "disclosure.show",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const state = requireRunState(context.workspaceDir, input.draftId);
      if (state.disclosureSha256 === undefined) {
        refuse("not-found", `runs.${input.draftId}.disclosureSha256`, "this run has no disclosure declaration");
      }
      const record = parseDisclosureSpecification(getSealedBytes(context.workspaceDir, state.disclosureSha256));
      return {
        recordSha256: state.disclosureSha256,
        specification: record.specification,
        subjectSha256: record.subject.digest.sha256,
        author: record.author,
        variables: Object.fromEntries(
          DISCLOSURE_VARIABLE_KEYS.map((key) => [key, record.variables[key]]),
        ) as Readonly<Record<DisclosureVariableKey, DisclosureVariableEntry>>,
      };
    },
  });
}
