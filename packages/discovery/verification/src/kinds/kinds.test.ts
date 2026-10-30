// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";

import { defaultRecordKinds } from "../index.js";
import { readRecord } from "../record-view.js";
import type { RecordView } from "../record-view.js";

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const descriptor = (fill: string) => ({ digest: { sha256: fill.repeat(64) } });

function citations(kind: string, view: RecordView) {
  return defaultRecordKinds[kind]!.references!(view).map(({ field, digest: cited, mayBeUnavailable }) =>
    [field, cited, mayBeUnavailable === true ? "may be unavailable" : "must be held"]);
}

function bare(document: unknown): RecordView {
  return readRecord(canonicalJsonBytes(document));
}

function statement(document: unknown): RecordView {
  return { ...bare(document), payloadType: "application/vnd.in-toto+json", signatures: [] };
}

/**
 * The fields here are those the spec's discovery facts profiles mark `referenceBearing`, under the
 * same names, plus the descriptors a claim's predicate carries that those cards leave out. What each
 * test pins as well is which targets a set has to hold.
 */
describe("what each kind cites", () => {
  test("Task (facts task/v2)", () => {
    expect(citations(RECORD_KINDS.task, bare({
      profile: descriptor("1"),
      evaluation: descriptor("2"),
      supersedes: descriptor("3"),
      inputs: [descriptor("4"), { uri: "https://example.test/no-digest" }],
      outputs: [{ schema: descriptor("5") }, { schema: { inline: true } }, {}],
    }))).toEqual([
      ["profileDigest", digest("1"), "must be held"],
      ["evaluationDigest", digest("2"), "must be held"],
      ["supersedesDigest", digest("3"), "must be held"],
      ["inputDigests", digest("4"), "may be unavailable"],
      ["outputSlotSchemaDigests", digest("5"), "may be unavailable"],
    ]);
  });

  test("Submission (facts submission/v1)", () => {
    expect(citations(RECORD_KINDS.submission, bare({ task: descriptor("1") }))).toEqual([
      ["taskDigest", digest("1"), "must be held"],
    ]);
  });

  test("Delivery (facts delivery/v2)", () => {
    expect(citations(RECORD_KINDS.delivery, bare({
      task: digest("1"),
      outputs: [descriptor("2")],
      evidenceRecords: [{ family: "result-evaluation", digest: digest("3") }],
      supersedes: digest("4"),
    }))).toEqual([
      ["taskDigest", digest("1"), "must be held"],
      ["resultDigests", digest("2"), "may be unavailable"],
      ["evidenceDigests", digest("3"), "must be held"],
      ["supersedesDigest", digest("4"), "must be held"],
    ]);
  });

  test("Result Evaluation (facts result-evaluation/v3, plus the predicate's descriptors)", () => {
    expect(citations(RECORD_KINDS.resultEvaluation, statement({
      subject: [descriptor("1"), descriptor("2")],
      predicate: {
        evaluationMethod: descriptor("3"),
        evaluationSpecification: descriptor("4"),
        evidence: [descriptor("5")],
        supersedes: [descriptor("6")],
        disputes: [descriptor("7")],
      },
    }))).toEqual([
      ["subject", digest("1"), "may be unavailable"],
      ["subject", digest("2"), "may be unavailable"],
      ["evaluationMethod", digest("3"), "may be unavailable"],
      ["evaluationSpecification", digest("4"), "may be unavailable"],
      ["evidence", digest("5"), "may be unavailable"],
      ["supersedesDigests", digest("6"), "must be held"],
      ["disputesDigests", digest("7"), "must be held"],
    ]);
  });

  test("Execution Verification (facts execution-verification/v2): what is verified must be held", () => {
    expect(citations(RECORD_KINDS.executionVerification, statement({
      subject: [descriptor("1")],
      predicate: { verificationMethod: descriptor("2"), verificationPolicy: descriptor("3"), evidence: [descriptor("4")], supersedes: [descriptor("5")] },
    }))).toEqual([
      ["subject", digest("1"), "must be held"],
      ["verificationMethod", digest("2"), "may be unavailable"],
      ["verificationPolicy", digest("3"), "may be unavailable"],
      ["evidence", digest("4"), "may be unavailable"],
      ["supersedesDigests", digest("5"), "must be held"],
    ]);
  });

  test("Execution Evidence (facts execution-evidence/v3): every content-bound entity, all of them withholdable", () => {
    expect(citations(RECORD_KINDS.executionEvidence, bare({
      "@graph": [{ "@id": "./" }, { "@id": "task.md", sha256: "1".repeat(64) }, { "@id": "trace.jsonl", sha256: "2".repeat(64) }],
    }))).toEqual([
      ["task.md", digest("1"), "may be unavailable"],
      ["trace.jsonl", digest("2"), "may be unavailable"],
    ]);
  });

  test("Key binding (facts key-binding/v2): ceremony evidence and anchors are artifacts", () => {
    expect(citations(RECORD_KINDS.keyBinding, bare({
      ceremony: { digest: digest("1") },
      anchors: [{ digest: digest("2") }],
      supersedes: digest("3"),
    }))).toEqual([
      ["ceremony.digest", digest("1"), "may be unavailable"],
      ["anchorDigests", digest("2"), "may be unavailable"],
      ["supersedes", digest("3"), "must be held"],
    ]);
  });

  test("Authorization (facts authorization/v2)", () => {
    expect(citations(RECORD_KINDS.authorization, statement({
      subject: [descriptor("1")],
      predicate: { proofs: [digest("2")], revocation: digest("3") },
    }))).toEqual([
      ["subjectDigests", digest("1"), "may be unavailable"],
      ["proofs", digest("2"), "must be held"],
      ["revocation", digest("3"), "must be held"],
    ]);
  });

  test("Trust policy (facts trust-policy/v1)", () => {
    expect(citations(RECORD_KINDS.trustPolicy, bare({ predecessor: digest("1") }))).toEqual([
      ["predecessor", digest("1"), "must be held"],
    ]);
  });

  test("Revocation", () => {
    expect(citations("https://spec.jinn.network/trust/revocation/v1", bare({ target: digest("1"), anchors: [{ digest: digest("2") }] }))).toEqual([
      ["target", digest("1"), "must be held"],
      ["anchorDigests", digest("2"), "may be unavailable"],
    ]);
  });

  test("Anchor evidence: an anchor is about a record, and that record must be held", () => {
    expect(citations("https://spec.jinn.network/records/anchor-evidence/v1", bare({ subject: descriptor("1") }))).toEqual([
      ["subject", digest("1"), "must be held"],
    ]);
  });

  test("Offer (facts offer/v1): an offer is for a record its reader may not hold", () => {
    expect(citations("https://spec.jinn.network/records/offer/v1", bare({ subject: digest("1"), supersedes: digest("2") }))).toEqual([
      ["subject", digest("1"), "may be unavailable"],
      ["supersedes", digest("2"), "must be held"],
    ]);
  });

  test("Evaluation spec (facts evaluation-spec/v2): components may be private, sub-specs must be held", () => {
    expect(citations(RECORD_KINDS.evaluationSpec, bare({
      grader: [descriptor("1"), descriptor("2")],
      familyBlock: {
        environmentRecord: descriptor("3"),
        successPredicates: [{ call: { abiRef: descriptor("4") } }, { groundTruth: { call: { abiRef: descriptor("5") } } }, {}],
        image: descriptor("6"),
        testMaterial: [descriptor("7")],
        parser: { digest: digest("8") },
        rubric: descriptor("9"),
        judgeOutputSchema: descriptor("a"),
        reviewForm: descriptor("b"),
        subSpecs: [{ spec: descriptor("c") }],
      },
    }))).toEqual([
      ["graderDigests", digest("1"), "may be unavailable"],
      ["graderDigests", digest("2"), "may be unavailable"],
      ["environmentRecordDigest", digest("3"), "may be unavailable"],
      ["abiRefDigests", digest("4"), "may be unavailable"],
      ["abiRefDigests", digest("5"), "may be unavailable"],
      ["imageDigest", digest("6"), "may be unavailable"],
      ["testMaterialDigests", digest("7"), "may be unavailable"],
      ["parserDigest", digest("8"), "may be unavailable"],
      ["rubricDigest", digest("9"), "may be unavailable"],
      ["judgeOutputSchemaDigest", digest("a"), "may be unavailable"],
      ["reviewFormDigest", digest("b"), "may be unavailable"],
      ["subSpecDigests", digest("c"), "must be held"],
    ]);
    expect(citations(RECORD_KINDS.evaluationSpec, bare({ grader: descriptor("1") }))).toEqual([
      ["graderDigests", digest("1"), "may be unavailable"],
    ]);
  });

  test("Profile document (facts profile-document/v2)", () => {
    expect(citations(RECORD_KINDS.profileDocument, bare({
      extends: { digest: digest("1") },
      outputConventions: { slots: [{ schema: descriptor("2") }] },
    }))).toEqual([
      ["extendsDigest", digest("1"), "must be held"],
      ["outputSlotSchemaDigests", digest("2"), "may be unavailable"],
    ]);
  });
});

describe("the kinds inside the Task Execution family", () => {
  const protocol = "https://spec.jinn.network/profiles/task-execution/v1";
  const claimedBy = (document: unknown) => Object.entries(defaultRecordKinds)
    .filter(([, kind]) => kind.identify(bare(document)))
    .map(([id]) => id);

  test("each is told by the field only it requires, and anything else is a Task to be refused", () => {
    expect(claimedBy({ protocol })).toEqual([RECORD_KINDS.task]);
    expect(claimedBy({ protocol, submission: "urn:uuid:x" })).toEqual([RECORD_KINDS.submission]);
    expect(claimedBy({ protocol, attempt: "urn:uuid:x" })).toEqual([RECORD_KINDS.delivery]);
    expect(claimedBy({ protocol, submission: "urn:uuid:x", attempt: "urn:uuid:x" })).toEqual([RECORD_KINDS.submission]);
  });

  test("no default kind claims what another does", () => {
    const records: readonly unknown[] = [
      { protocol },
      { kind: "https://spec.jinn.network/records/offer/v1" },
      { predicateType: "https://spec.jinn.network/trust/authorization/v1" },
      { protocol: "https://spec.jinn.network/profiles/evaluation-spec/v1" },
      { protocol: "https://spec.jinn.network/profiles/task-profile/v1" },
      { kind: "https://spec.jinn.network/records/anchor-evidence/v1" },
      { specversion: "1.0", type: "network.jinn.task-execution.progress.v1" },
    ];
    for (const record of records) expect(claimedBy(record)).toHaveLength(1);
  });

  test("a record type outside the family is not one of its kinds", () => {
    expect(claimedBy({ protocol: "https://spec.jinn.network/binary-judgment/judge-observation/v1" })).toEqual([]);
    expect(claimedBy({ type: "network.jinn.task-execution.progress.v1" })).toEqual([]);
    expect(claimedBy({ specversion: "1.0", type: "com.example.other.v1" })).toEqual([]);
  });
});
