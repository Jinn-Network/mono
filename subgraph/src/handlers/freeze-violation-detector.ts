/**
 * freeze-violation-detector.ts
 *
 * Cross-envelope consistency detector for frozen-mode violations.
 *
 * WHAT IT DETECTS:
 * An operator operating in "frozen" mode asserts that its implementation
 * state (implStateDir) is immutable across Tasks within that window — i.e.
 * codeDigest MUST be identical on every consecutive frozen-mode envelope
 * published by the same signing key. If two consecutive frozen-mode envelopes
 * from the same signing key carry different codeDigest values, the second is
 * flagged as a FreezeViolation.
 *
 * Mode boundaries reset the consistency requirement: if an operator switches
 * frozen → train → frozen, the second frozen window starts fresh and no
 * violation is raised for the first envelope of the new window.
 *
 * HOW IT WORKS:
 * 1. `detectFreezeViolation(exec, timestamp)` is called after every ENVELOPE
 *    Execution is saved (see identity.ts).
 * 2. It reads the `SigningKeyFrozenState` for the operator — one mutable row
 *    per signing key tracking the last-seen frozen codeDigest.
 * 3. If the current envelope is frozen and a prior frozen state exists:
 *    - Same codeDigest → update lastFrozenAt timestamp (no violation).
 *    - Different codeDigest → write a FreezeViolation row.
 * 4. If the current envelope is NOT frozen (mode == "train"), clear the
 *    SigningKeyFrozenState so the next frozen window starts fresh.
 *
 * STUB STATUS (2026-05-07):
 * The `codeDigest` field on Execution is null for all v1 payloads. Payload v2
 * will carry codeDigest in the on-chain encoding. Until then, the handler
 * returns early at the stub guard and no SigningKeyFrozenState or
 * FreezeViolation rows are written. The function IS wired into the execution
 * path so it activates automatically when payload v2 populates these fields —
 * no further integration work is required.
 *
 * ACTIVATION REQUIREMENTS:
 * 1. Payload v2 encoding ships and `Execution.codeDigest` is populated.
 * 2. The early-return stub guard (codeDigest == null) in this file is removed.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.2
 * DR:   log/decisions/2026-05-06-trust-stack-composition.md (layer 2)
 */

import { BigInt, log } from "@graphprotocol/graph-ts";

import {
  Execution,
  FreezeViolation,
  SigningKeyFrozenState,
} from "../../generated/schema";

/**
 * detectFreezeViolation — called from the ENVELOPE Execution save path.
 *
 * @param exec       The ENVELOPE Execution that was just indexed.
 * @param timestamp  Block timestamp of the triggering event.
 *
 * STUB: Returns immediately when exec.codeDigest is null, which is always
 * true for v1 payloads. Remove this guard once payload v2 carries codeDigest.
 */
export function detectFreezeViolation(exec: Execution, timestamp: BigInt): void {
  // ── STUB GUARD ────────────────────────────────────────────────────────────
  // codeDigest is populated by payload v2, which has not shipped. All v1
  // ENVELOPE Executions will hit this guard and return early. The handler
  // is intentionally wired here so it activates automatically when payload v2
  // populates this field. See module-level comment.
  let codeDigest = exec.codeDigest;
  if (codeDigest == null) {
    log.debug(
      "detectFreezeViolation: skipping execution {} — codeDigest not yet populated (awaiting payload v2)",
      [exec.id],
    );
    return;
  }
  // ── END STUB GUARD ────────────────────────────────────────────────────────

  // signingKey is the Operator.id (agentId as decimal string).
  let signingKey = exec.operator;
  let mode = exec.mode; // "train" | "frozen"

  if (mode != "frozen") {
    // Operator is in train mode. Clear any prior frozen state so the next
    // frozen window starts fresh — no violation for the first envelope of a
    // new frozen window.
    let state = SigningKeyFrozenState.load(signingKey);
    if (state != null) {
      // Deleting mutable entities is not supported in AssemblyScript mappings;
      // instead, we clear the codeDigest to a sentinel value so the detector
      // treats the next frozen envelope as the start of a new window.
      // The empty-string sentinel is safe because a valid codeDigest is always
      // a non-empty hash string; no valid envelope has codeDigest == "".
      state.lastFrozenCodeDigest = "";
      state.lastFrozenAt = timestamp;
      state.lastFrozenExecutionId = exec.id;
      state.save();
      log.debug(
        "detectFreezeViolation: operator {} switched to train mode — frozen state reset",
        [signingKey],
      );
    }
    return;
  }

  // Current envelope is frozen. Compare against prior frozen state.
  let state = SigningKeyFrozenState.load(signingKey);

  if (state == null) {
    // First frozen-mode envelope for this signing key. Record the baseline.
    state = new SigningKeyFrozenState(signingKey);
    state.lastFrozenCodeDigest = codeDigest as string;
    state.lastFrozenAt = timestamp;
    state.lastFrozenExecutionId = exec.id;
    state.save();
    log.debug(
      "detectFreezeViolation: operator {} entered frozen mode with codeDigest {}",
      [signingKey, codeDigest as string],
    );
    return;
  }

  let priorDigest = state.lastFrozenCodeDigest;

  if (priorDigest == "" || priorDigest == (codeDigest as string)) {
    // Either the frozen state was cleared (train-mode boundary) or the
    // codeDigest is unchanged — no violation. Update the timestamp.
    state.lastFrozenCodeDigest = codeDigest as string;
    state.lastFrozenAt = timestamp;
    state.lastFrozenExecutionId = exec.id;
    state.save();
    return;
  }

  // codeDigest changed within the same frozen window — violation detected.
  let violationId = signingKey + "|" + exec.id;
  let violation = new FreezeViolation(violationId);
  violation.signingKey = signingKey;
  violation.envelopeId = exec.id;
  violation.detectedAt = timestamp;
  violation.reason = "codeDigest changed within frozen window";
  violation.priorCodeDigest = priorDigest;
  violation.envelopeCodeDigest = codeDigest as string;
  violation.save();

  log.warning(
    "detectFreezeViolation: VIOLATION for operator {} — codeDigest changed from {} to {} within frozen window (execution {})",
    [signingKey, priorDigest, codeDigest as string, exec.id],
  );

  // Update the state to the new (violating) codeDigest so subsequent envelopes
  // are checked against the latest value. This means each mutation in a frozen
  // window produces exactly one FreezeViolation (the transition), not a
  // violation on every subsequent envelope.
  state.lastFrozenCodeDigest = codeDigest as string;
  state.lastFrozenAt = timestamp;
  state.lastFrozenExecutionId = exec.id;
  state.save();
}
