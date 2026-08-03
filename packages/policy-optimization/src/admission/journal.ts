// SPDX-License-Identifier: MIT

/**
 * Admission's journal payloads (product design §5.2, §7.3).
 *
 * C7a left `payload` unschematized — "per-event payload schemas belong to the sub-unit that emits
 * them". These are admission's two, built by functions rather than at call sites so a
 * `candidate-admitted` entry has one shape.
 *
 * The same rule the wave engine's payloads follow applies: **references, never content.** A payload
 * names digests, the arm, the checks, and the decision; the manifest and the bundle it addresses
 * hold the facts.
 *
 * §7.3's second consequence is what makes `candidate-admitted` carry `joinedExisting` and
 * `attribution`: "later manifests are journaled against the same arm (load-bearing for any future
 * paid-proposal economics)". Without both members a reader could not tell which of two manifests on
 * one arm the execution credit belongs to — which is precisely the fact a payment would key on.
 */

import type { CampaignJournalEntryInput } from "../journal-entry.js";
import { appendCampaignEvent, type CampaignHandle } from "../journal-store.js";
import type { JsonValue } from "../types.js";
import type { AdmissionAccepted, AdmissionCheck, AdmissionRejected } from "./types.js";

type Payload = Readonly<Record<string, JsonValue>>;

function checkEntries(checks: readonly AdmissionCheck[]): JsonValue {
  return checks.map((check) => ({ name: check.name, status: check.status, detail: check.detail }));
}

/** §5.2 `candidate-admitted`. */
export function candidateAdmittedPayload(
  result: AdmissionAccepted,
  proposerId: string,
): Payload {
  return {
    manifest: result.manifestDigest,
    proposer: proposerId,
    tupleDigest: result.candidate.tupleDigest,
    armId: result.candidate.armId,
    joinedExisting: result.joinedExisting,
    /** The first-admitted manifest — the arm's execution attribution (§7.3). */
    attribution: result.entry.attribution.digest,
    manifestsOnArm: [...result.entry.manifests],
    payloadClasses: [...result.payload.classes],
    highestPayloadClass: result.payload.highest,
    checks: checkEntries(result.checks),
  };
}

/**
 * §5.2 `candidate-rejected`.
 *
 * Carries every check, not only the failing one. A rejection read six weeks later has to answer
 * "what did pass", because that is what distinguishes a candidate that was nearly admissible from
 * one that was never close — and a journal that recorded only the failure makes the two identical.
 */
export function candidateRejectedPayload(
  result: AdmissionRejected,
  proposerId: string,
  manifestDigest: string,
): Payload {
  return {
    manifest: manifestDigest,
    proposer: proposerId,
    reason: result.reason,
    failedCheck: result.checks.find((check) => check.status === "fail")?.name ?? "manifest",
    errors: result.errors.map((error) => ({ path: error.path, code: error.code, message: error.message })),
    checks: checkEntries(result.checks),
  };
}

/**
 * Appends one admission event, filling in the sequence from the handle.
 *
 * The same helper shape `appendWaveEvent` uses, and for the same reason: a stale handle refuses
 * rather than overwriting.
 */
export function appendAdmissionEvent(
  handle: CampaignHandle,
  input: {
    readonly type: "candidate-admitted" | "candidate-rejected";
    readonly recordedAt: string;
    readonly payload: Payload;
  },
): CampaignHandle {
  const entry: CampaignJournalEntryInput = {
    seq: handle.state.nextSeq,
    type: input.type,
    recordedAt: input.recordedAt,
    payload: input.payload,
  };
  return appendCampaignEvent(handle, entry);
}
