// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentLabelResolution,
  canonicalJsonBytes,
  recordDigest,
} from "@jinn-network/task-execution-profiles";
import { parseExactDsseEnvelope } from "@jinn-network/trust-core";
import {
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
  HumanReviewOperatorAssertionSchema,
  HumanReviewRevealReceiptSchema,
  HumanReviewRosterSchema,
  HumanReviewPacketSchema,
  HumanReviewVisibilityReceiptSchema,
  HUMAN_REVIEW_PACKET_PROTOCOL,
  HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL,
  HUMAN_REVIEW_OMITTED_FIELDS,
  sealHumanReviewDocument,
} from "../human-review/contracts.js";
import { readDraftDocument } from "./drafts.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
  sealVerdictStatement,
} from "../venue/signing.js";
import { loadOrCreateReportSigningKey, verifyReportEnvelopeSignatures } from "../report/signing.js";
import { createDraft } from "./drafts.js";
import { initWorkspace } from "./init.js";
import {
  admitHumanTruth,
  createHumanReviewPackets,
  signHumanReviewResponse,
  type CreateHumanReviewPacketsResult,
  type SignHumanReviewResponseResult,
} from "./human-review.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-human-review-"));
  roots.push(workspaceDir);
  let now = "2026-08-15T09:00:00.000Z";
  const context = {
    workspaceDir,
    principal: "operator",
    clock: () => now,
    setClock: (next: string) => { now = next; },
  };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId: "review-run", name: "Review run" }).ok).toBe(true);
  return context;
}

function item(index: number) {
  return {
    itemId: `urn:uuid:123e4567-e89b-12d3-a456-42661417400${index}`,
    question: `Question ${index}?`,
    referenceAnswer: `Reference ${index}`,
    candidateAnswer: `Candidate ${index}`,
    provenance: [{ digest: { sha256: String(index + 1).repeat(64) } }],
  };
}

async function reviewedItem(
  context: ReturnType<typeof setup>,
  index: number,
  labels: readonly ["CORRECT" | "WRONG" | "indeterminate", "CORRECT" | "WRONG" | "indeterminate"],
  completes: readonly [boolean, boolean] = [true, true],
): Promise<{ packets: CreateHumanReviewPacketsResult; verdicts: [SignHumanReviewResponseResult, SignHumanReviewResponseResult] }> {
  context.setClock("2026-08-15T09:00:00.000Z");
  const packetResult = createHumanReviewPackets(context, {
    draftId: "review-run",
    item: item(index),
    evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
  });
  if (!packetResult.ok) throw new Error(packetResult.error.detail);
  const signed = await Promise.all(packetResult.result.packets.map((packet, reviewerIndex) =>
    signHumanReviewResponse(context, {
      draftId: "review-run",
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: packet.reviewerId,
      packetSha256: packet.packetSha256,
      visibilityReceiptSha256: packet.visibilityReceiptSha256,
      label: labels[reviewerIndex]!,
      complete: completes[reviewerIndex]!,
      completedAt: `2026-08-15T09:0${reviewerIndex + 1}:00.000Z`,
    })));
  if (!signed[0]!.ok || !signed[1]!.ok) {
    throw new Error(`review signing failed: ${JSON.stringify(signed)}`);
  }
  context.setClock("2026-08-15T09:10:00.000Z");
  return {
    packets: packetResult.result,
    verdicts: [signed[0].result, signed[1].result],
  };
}

function publicationCandidate(
  reviewed: Awaited<ReturnType<typeof reviewedItem>>,
  index: number,
  poolPosition: number,
  extras: Record<string, unknown> = {},
) {
  return {
    itemSha256: reviewed.packets.itemSha256,
    itemId: item(index).itemId,
    humanReviewEvaluationSpecSha256: reviewed.packets.humanReviewEvaluationSpecSha256,
    candidateClass: "factual",
    stratum: "core" as const,
    poolPosition,
    reviewVerdictSha256s: [reviewed.verdicts[0].verdictSha256, reviewed.verdicts[1].verdictSha256] as [string, string],
    reviewers: [
      { evaluatorId: "urn:jinn:reviewer:a", personId: "person-a", role: "domain-reviewer", conflicts: [] },
      { evaluatorId: "urn:jinn:reviewer:b", personId: "person-b", role: "domain-reviewer", conflicts: [] },
    ] as [
      { evaluatorId: string; personId: string; role: string; conflicts: string[] },
      { evaluatorId: string; personId: string; role: string; conflicts: string[] },
    ],
    ...extras,
  };
}

async function mutateAndResignVerdict(
  context: ReturnType<typeof setup>,
  reviewed: Awaited<ReturnType<typeof reviewedItem>>,
  verdictIndex: 0 | 1,
  mutate: (statement: Record<string, unknown>) => void,
) {
  const original = parseExactDsseEnvelope(Buffer.from(reviewed.verdicts[verdictIndex].envelopeBase64, "base64"));
  const statement = JSON.parse(new TextDecoder().decode(original.payloadBytes)) as Record<string, unknown>;
  mutate(statement);
  const evaluatorId = `urn:jinn:reviewer:${verdictIndex === 0 ? "a" : "b"}`;
  const keys = loadOrCreateEvaluatorSigningKeys(context.workspaceDir, [
    { id: "urn:jinn:reviewer:a" },
    { id: "urn:jinn:reviewer:b" },
  ]);
  const key = keys.find((entry) => entry.id === evaluatorId)!.key;
  const bytes = await sealVerdictStatement({
    statementBytes: new TextEncoder().encode(JSON.stringify(statement)),
    evaluatorId,
    expectedEvaluationSpecificationSha256: reviewed.packets.humanReviewEvaluationSpecSha256.slice("sha256:".length),
    signer: createVerdictDsseSigner(key),
  });
  return { bytes, digest: recordDigest(bytes) };
}

function tamperExactEnvelopeSignature(bytes: Uint8Array): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
    payload: string;
    payloadType: string;
    signatures: [{ keyid: string; sig: string }];
  };
  envelope.signatures[0].sig = `${envelope.signatures[0].sig[0] === "A" ? "B" : "A"}${envelope.signatures[0].sig.slice(1)}`;
  return new TextEncoder().encode(
    `{"payload":${JSON.stringify(envelope.payload)},"payloadType":${JSON.stringify(envelope.payloadType)},"signatures":[{"keyid":${JSON.stringify(envelope.signatures[0].keyid)},"sig":${JSON.stringify(envelope.signatures[0].sig)}}]}`,
  );
}

function tamperExactEnvelopePayload(
  bytes: Uint8Array,
  mutate: (payload: Record<string, unknown>) => void,
): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
    payload: string;
    payloadType: string;
    signatures: [{ keyid: string; sig: string }];
  };
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<string, unknown>;
  mutate(payload);
  envelope.payload = Buffer.from(canonicalJsonBytes(payload)).toString("base64");
  return new TextEncoder().encode(
    `{"payload":${JSON.stringify(envelope.payload)},"payloadType":${JSON.stringify(envelope.payloadType)},"signatures":[{"keyid":${JSON.stringify(envelope.signatures[0].keyid)},"sig":${JSON.stringify(envelope.signatures[0].sig)}}]}`,
  );
}

describe("binary human truth admission", () => {
  it("derives publication-grade resolution and the exact F0 analysis-context join", async () => {
    const context = setup();
    const reviewed = await reviewedItem(context, 0, ["WRONG", "WRONG"]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [publicationCandidate(reviewed, 0, 1)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.publicationGrade).toBe(true);
    expect(result.result.exclusions).toEqual([]);
    const summary = result.result.resolutions[0]!;
    const resolution = parseBinaryJudgmentLabelResolution(
      getSealedBytes(context.workspaceDir, summary.labelResolutionSha256.slice("sha256:".length)),
    );
    const analysis = parseBinaryJudgmentAnalysisContext(
      getSealedBytes(context.workspaceDir, summary.analysisContextSha256.slice("sha256:".length)),
    );
    expect(resolution).toMatchObject({
      truthAdmission: "two-human-unanimous",
      truthLabel: "WRONG",
      itemSha256: reviewed.packets.itemSha256,
    });
    if (resolution.truthAdmission !== "two-human-unanimous") throw new Error("wrong admission kind");
    const rosterEnvelope = parseExactDsseEnvelope(getSealedBytes(
      context.workspaceDir,
      resolution.reviewerRosterSha256.slice("sha256:".length),
    ));
    expect(rosterEnvelope.payloadType).toBe(HUMAN_REVIEW_ROSTER_MEDIA_TYPE);
    expect(rosterEnvelope.signatures).toHaveLength(1);
    const roster = HumanReviewRosterSchema.parse(JSON.parse(new TextDecoder().decode(rosterEnvelope.payloadBytes)));
    expect(roster.itemSha256).toBe(reviewed.packets.itemSha256);
    expect(roster.reviewers.map((reviewer) => reviewer.evaluatorId)).toEqual([
      "urn:jinn:reviewer:a",
      "urn:jinn:reviewer:b",
    ]);
    expect(roster.attestorRole).toBe("roster-attestor");
    expect(roster.attestorKeyId).toBe(rosterEnvelope.signatures[0]!.keyid);
    const reportKey = loadOrCreateReportSigningKey(context.workspaceDir);
    expect(verifyReportEnvelopeSignatures(
      getSealedBytes(context.workspaceDir, resolution.reviewerRosterSha256.slice("sha256:".length)),
      reportKey,
    ).validSignerKeyids).toEqual([reportKey.keyId]);
    expect(verifyReportEnvelopeSignatures(
      tamperExactEnvelopeSignature(getSealedBytes(
        context.workspaceDir,
        resolution.reviewerRosterSha256.slice("sha256:".length),
      )),
      reportKey,
    ).validSignerKeyids).toEqual([]);
    expect(verifyReportEnvelopeSignatures(
      tamperExactEnvelopePayload(
        getSealedBytes(context.workspaceDir, resolution.reviewerRosterSha256.slice("sha256:".length)),
        (payload) => { payload.itemSha256 = `sha256:${"f".repeat(64)}`; },
      ),
      reportKey,
    ).validSignerKeyids).toEqual([]);
    expect(recordDigest(rosterEnvelope.payloadBytes)).not.toBe(resolution.reviewerRosterSha256);
    const revealEnvelope = parseExactDsseEnvelope(getSealedBytes(
      context.workspaceDir,
      resolution.revealReceiptSha256.slice("sha256:".length),
    ));
    expect(revealEnvelope.payloadType).toBe(HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE);
    expect(HumanReviewRevealReceiptSchema.parse(JSON.parse(new TextDecoder().decode(revealEnvelope.payloadBytes)))).toEqual({
      protocol: "https://spec.jinn.network/binary-judgment/reveal-receipt/v1",
      draftId: "review-run",
      itemSha256: reviewed.packets.itemSha256,
      truthFrozenAt: "2026-08-15T09:10:00.000Z",
      judgeExecutionState: "not-started",
    });
    expect(verifyReportEnvelopeSignatures(
      getSealedBytes(context.workspaceDir, resolution.revealReceiptSha256.slice("sha256:".length)),
      reportKey,
    ).validSignerKeyids).toEqual([reportKey.keyId]);
    expect(verifyReportEnvelopeSignatures(
      tamperExactEnvelopeSignature(getSealedBytes(
        context.workspaceDir,
        resolution.revealReceiptSha256.slice("sha256:".length),
      )),
      reportKey,
    ).validSignerKeyids).toEqual([]);
    expect(verifyReportEnvelopeSignatures(
      tamperExactEnvelopePayload(
        getSealedBytes(context.workspaceDir, resolution.revealReceiptSha256.slice("sha256:".length)),
        (payload) => { payload.judgeExecutionState = "started"; },
      ),
      reportKey,
    ).validSignerKeyids).toEqual([]);
    const manifest = BinaryJudgmentAdmissionManifestSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, result.result.admissionManifestSha256.slice("sha256:".length)),
    )));
    for (const values of [manifest.labelResolutionSha256s, manifest.analysisContextSha256s, manifest.excludedItemSha256s]) {
      expect(values).toEqual([...values].sort());
      expect(new Set(values).size).toBe(values.length);
    }
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse({
      ...manifest,
      labelResolutionSha256s: [manifest.labelResolutionSha256s[0], manifest.labelResolutionSha256s[0]],
    }).success).toBe(false);
    expect(BinaryJudgmentAdmissionManifestSchema.safeParse({
      ...manifest,
      analysisContextSha256s: [`sha256:${"f".repeat(64)}`, `sha256:${"a".repeat(64)}`],
    }).success).toBe(false);
    expect(analysis).toEqual({
      protocol: "https://spec.jinn.network/binary-judgment/analysis-context/v1",
      itemSha256: reviewed.packets.itemSha256,
      itemId: item(0).itemId,
      labelResolutionSha256: summary.labelResolutionSha256,
      truthLabel: "WRONG",
      candidateClass: "factual",
      stratum: "core",
    });
  });

  it("refuses swapped or missing evidence and freezes no truth after run lock", async () => {
    const context = setup();
    const packets = createHumanReviewPackets(context, {
      draftId: "review-run",
      item: item(0),
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    });
    if (!packets.ok) throw new Error(packets.error.detail);
    const badPacket = sealHumanReviewDocument(HumanReviewPacketSchema, {
      protocol: HUMAN_REVIEW_PACKET_PROTOCOL,
      itemSha256: packets.result.itemSha256,
      item: { ...item(0), candidateAnswer: "digest-mismatched answer" },
      evaluationSpecSha256: packets.result.humanReviewEvaluationSpecSha256,
      reviewerId: "urn:jinn:reviewer:a",
      form: {
        question: "Is the candidate answer correct relative to the question and reference answer?",
        labels: ["CORRECT", "WRONG", "indeterminate"],
        completeReviewRequired: true,
      },
    }, "bad packet");
    putSealedBytes(context.workspaceDir, badPacket.bytes);
    const badVisibility = sealHumanReviewDocument(HumanReviewVisibilityReceiptSchema, {
      protocol: HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL,
      packetSha256: badPacket.digest,
      itemSha256: packets.result.itemSha256,
      reviewerId: "urn:jinn:reviewer:a",
      omittedFields: HUMAN_REVIEW_OMITTED_FIELDS,
      issuedAt: "2026-08-15T09:00:00.000Z",
    }, "bad visibility");
    putSealedBytes(context.workspaceDir, badVisibility.bytes);
    expect(await signHumanReviewResponse(context, {
      draftId: "review-run",
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: "urn:jinn:reviewer:a",
      packetSha256: badPacket.digest,
      visibilityReceiptSha256: badVisibility.digest,
      label: "CORRECT",
      complete: true,
      completedAt: "2026-08-15T09:01:00.000Z",
    })).toMatchObject({ ok: false, error: { code: "validation" } });
    const swapped = await signHumanReviewResponse(context, {
      draftId: "review-run",
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: "urn:jinn:reviewer:a",
      packetSha256: packets.result.packets[0]!.packetSha256,
      visibilityReceiptSha256: packets.result.packets[1]!.visibilityReceiptSha256,
      label: "CORRECT",
      complete: true,
      completedAt: "2026-08-15T09:01:00.000Z",
    });
    expect(swapped).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await signHumanReviewResponse(context, {
      draftId: "review-run",
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: "urn:jinn:reviewer:a",
      packetSha256: packets.result.packets[0]!.packetSha256,
      visibilityReceiptSha256: packets.result.packets[0]!.visibilityReceiptSha256,
      label: "CORRECT",
      complete: true,
      completedAt: "2026-08-15T08:59:00.000Z",
    })).toMatchObject({ ok: false, error: { code: "validation" } });

    const missing = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [{
        itemSha256: packets.result.itemSha256,
        itemId: item(0).itemId,
        humanReviewEvaluationSpecSha256: packets.result.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
        reviewVerdictSha256s: [`sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`],
        reviewers: [
          { evaluatorId: "urn:jinn:reviewer:a", personId: "person-a", role: "reviewer", conflicts: [] },
          { evaluatorId: "urn:jinn:reviewer:b", personId: "person-b", role: "reviewer", conflicts: [] },
        ],
      }],
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });

    const draft = readDraftDocument(context.workspaceDir, "review-run");
    writeFileSync(draftPath(context.workspaceDir, "review-run"), JSON.stringify({ ...draft, state: "locked" }, null, 2));
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256: packets.result.itemSha256,
        itemId: item(0).itemId,
        humanReviewEvaluationSpecSha256: packets.result.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT",
      }],
    })).toMatchObject({ ok: false, error: { code: "illegal-transition" } });
  });

  it("rejects duplicate people, declared conflicts, and tampered signatures", async () => {
    const context = setup();
    const reviewed = await reviewedItem(context, 0, ["CORRECT", "CORRECT"]);
    const duplicate = publicationCandidate(reviewed, 0, 1);
    duplicate.reviewers[1].personId = "person-a";
    const duplicateResult = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [duplicate],
    });
    expect(duplicateResult).toMatchObject({ ok: false, error: { code: "validation" } });

    const conflicted = publicationCandidate(reviewed, 0, 1);
    conflicted.reviewers[1].conflicts.push("candidate-author");
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [conflicted],
    })).toMatchObject({ ok: false, error: { code: "validation" } });

    const original = Buffer.from(reviewed.verdicts[0].envelopeBase64, "base64").toString("utf8");
    const envelope = JSON.parse(original) as { signatures: [{ sig: string }] };
    envelope.signatures[0].sig = `${envelope.signatures[0].sig[0] === "A" ? "B" : "A"}${envelope.signatures[0].sig.slice(1)}`;
    const tamperedBytes = new TextEncoder().encode(JSON.stringify(envelope, Object.keys(envelope).sort()));
    // Recreate through the same compact member order instead of weakening exact-envelope parsing.
    const exactTampered = new TextEncoder().encode(
      `{"payload":${JSON.stringify((envelope as unknown as { payload: string }).payload)},"payloadType":${JSON.stringify((envelope as unknown as { payloadType: string }).payloadType)},"signatures":[{"keyid":${JSON.stringify((envelope as unknown as { signatures: [{ keyid: string }] }).signatures[0].keyid)},"sig":${JSON.stringify(envelope.signatures[0].sig)}}]}`,
    );
    expect(tamperedBytes.byteLength).toBeGreaterThan(0);
    const tamperedDigest = recordDigest(exactTampered);
    const tampered = publicationCandidate(reviewed, 0, 1);
    tampered.reviewVerdictSha256s = [tamperedDigest, reviewed.verdicts[1].verdictSha256];
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [tampered],
      evidenceEnvelopesBase64: [Buffer.from(exactTampered).toString("base64")],
    })).toMatchObject({ ok: false, error: { code: "validation" } });

    const signedMutations: Array<(statement: Record<string, unknown>) => void> = [
      (statement) => {
        const subjects = statement.subject as Array<{ digest: { sha256: string } }>;
        subjects[0]!.digest.sha256 = "a".repeat(64);
      },
      (statement) => {
        const subjects = statement.subject as Array<{ digest: { sha256: string } }>;
        subjects[1]!.digest.sha256 = "b".repeat(64);
      },
      (statement) => {
        (statement.predicate as { evidence: unknown[] }).evidence = [];
      },
      (statement) => {
        (statement.predicate as { verdict: string }).verdict = "fail";
      },
      (statement) => {
        (statement.predicate as { evaluatedAt: string }).evaluatedAt = "2026-08-15T09:59:00.000Z";
      },
    ];
    for (const mutate of signedMutations) {
      const altered = await mutateAndResignVerdict(context, reviewed, 0, mutate);
      const candidate = publicationCandidate(reviewed, 0, 1);
      candidate.reviewVerdictSha256s = [altered.digest, reviewed.verdicts[1].verdictSha256];
      expect(admitHumanTruth(context, {
        draftId: "review-run",
        truthAdmission: "two-human-unanimous",
        candidates: [candidate],
        evidenceEnvelopesBase64: [Buffer.from(altered.bytes).toString("base64")],
      })).toMatchObject({ ok: false, error: { code: "validation" } });
    }

    const packetA = reviewed.packets.packets.find((packet) => packet.reviewerId.endsWith(":a"))!;
    const duplicateSigner = await signHumanReviewResponse(context, {
      draftId: "review-run",
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: "urn:jinn:reviewer:a",
      packetSha256: packetA.packetSha256,
      visibilityReceiptSha256: packetA.visibilityReceiptSha256,
      label: "CORRECT",
      complete: true,
      completedAt: "2026-08-15T09:03:00.000Z",
    });
    if (!duplicateSigner.ok) throw new Error(duplicateSigner.error.detail);
    const sameKey = publicationCandidate(reviewed, 0, 1);
    sameKey.reviewVerdictSha256s = [reviewed.verdicts[0].verdictSha256, duplicateSigner.result.verdictSha256];
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [sameKey],
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses truth reveal before both signed reviews complete", async () => {
    const context = setup();
    const reviewed = await reviewedItem(context, 0, ["CORRECT", "CORRECT"]);
    context.setClock("2026-08-15T09:01:30.000Z");
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [publicationCandidate(reviewed, 0, 1)],
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("excludes disagreement and seals a deterministic same-slice reserve replacement", async () => {
    const context = setup();
    const disputed = await reviewedItem(context, 0, ["CORRECT", "WRONG"]);
    const reserve = await reviewedItem(context, 1, ["WRONG", "WRONG"]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [
        publicationCandidate(disputed, 0, 1),
        publicationCandidate(reserve, 1, 2, { replacesItemSha256: disputed.packets.itemSha256 }),
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        publicationGrade: true,
        exclusions: [{
          itemSha256: disputed.packets.itemSha256,
          reason: "review-disagreement",
          replacementItemSha256: reserve.packets.itemSha256,
        }],
      },
    });
    if (result.ok) expect(result.result.resolutions.map((entry) => entry.itemSha256)).toEqual([reserve.packets.itemSha256]);
  });

  it("accounts incomplete and indeterminate reviews and rejects wrong-slice or earlier reserves", async () => {
    const context = setup();
    const incomplete = await reviewedItem(context, 0, ["CORRECT", "CORRECT"], [false, true]);
    const incompleteReserve = await reviewedItem(context, 1, ["WRONG", "WRONG"]);
    const indeterminate = await reviewedItem(context, 2, ["indeterminate", "CORRECT"]);
    const indeterminateReserve = await reviewedItem(context, 3, ["CORRECT", "CORRECT"]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [
        publicationCandidate(incomplete, 0, 1),
        publicationCandidate(incompleteReserve, 1, 2, { replacesItemSha256: incomplete.packets.itemSha256 }),
        publicationCandidate(indeterminate, 2, 3),
        publicationCandidate(indeterminateReserve, 3, 4, { replacesItemSha256: indeterminate.packets.itemSha256 }),
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        exclusions: [
          { reason: "review-incomplete" },
          { reason: "review-indeterminate" },
        ],
      },
    });

    const wrongSlice = publicationCandidate(incompleteReserve, 1, 2, {
      replacesItemSha256: incomplete.packets.itemSha256,
      stratum: "stress",
    });
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [publicationCandidate(incomplete, 0, 1), wrongSlice],
    })).toMatchObject({ ok: false, error: { code: "validation" } });

    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [
        publicationCandidate(incomplete, 0, 2),
        publicationCandidate(incompleteReserve, 1, 1, { replacesItemSha256: incomplete.packets.itemSha256 }),
      ],
    })).toMatchObject({ ok: false, error: { code: "validation" } });

    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [publicationCandidate(incomplete, 0, 1)],
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("marks direct operator truth as non-publication-grade and forbids review evidence", () => {
    const context = setup();
    const packets = createHumanReviewPackets(context, {
      draftId: "review-run",
      item: item(0),
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    });
    if (!packets.ok) throw new Error(packets.error.detail);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256: packets.result.itemSha256,
        itemId: item(0).itemId,
        humanReviewEvaluationSpecSha256: packets.result.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT",
      }],
    });
    expect(result).toMatchObject({ ok: true, result: { publicationGrade: false } });
    if (!result.ok) return;
    const resolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
      context.workspaceDir,
      result.result.resolutions[0]!.labelResolutionSha256.slice("sha256:".length),
    ));
    expect(resolution).toMatchObject({
      truthAdmission: "operator-only",
      truthLabel: "CORRECT",
    });
    expect("reviewVerdictSha256s" in resolution).toBe(false);
    if (resolution.truthAdmission !== "operator-only") throw new Error("wrong admission kind");
    const assertionBytes = getSealedBytes(
      context.workspaceDir,
      resolution.operatorAssertionSha256.slice("sha256:".length),
    );
    const assertionEnvelope = parseExactDsseEnvelope(assertionBytes);
    expect(assertionEnvelope.payloadType).toBe(HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE);
    expect(HumanReviewOperatorAssertionSchema.parse(JSON.parse(new TextDecoder().decode(assertionEnvelope.payloadBytes)))).toEqual({
      protocol: "https://spec.jinn.network/binary-judgment/operator-truth-assertion/v1",
      itemSha256: packets.result.itemSha256,
      truthLabel: "CORRECT",
      assertedBy: "operator",
      assertedAt: "2026-08-15T09:00:00.000Z",
      limitation: "operator-only-not-publication-grade",
    });
    const reportKey = loadOrCreateReportSigningKey(context.workspaceDir);
    expect(verifyReportEnvelopeSignatures(assertionBytes, reportKey).validSignerKeyids).toEqual([reportKey.keyId]);
    const tampered = JSON.parse(new TextDecoder().decode(assertionBytes)) as { payload: string; payloadType: string; signatures: [{ keyid: string; sig: string }] };
    tampered.signatures[0].sig = `${tampered.signatures[0].sig[0] === "A" ? "B" : "A"}${tampered.signatures[0].sig.slice(1)}`;
    const tamperedBytes = new TextEncoder().encode(
      `{"payload":${JSON.stringify(tampered.payload)},"payloadType":${JSON.stringify(tampered.payloadType)},"signatures":[{"keyid":${JSON.stringify(tampered.signatures[0].keyid)},"sig":${JSON.stringify(tampered.signatures[0].sig)}}]}`,
    );
    expect(parseExactDsseEnvelope(tamperedBytes).payloadType).toBe(HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE);
    expect(verifyReportEnvelopeSignatures(tamperedBytes, reportKey).validSignerKeyids).toEqual([]);
    expect(verifyReportEnvelopeSignatures(
      tamperExactEnvelopePayload(assertionBytes, (payload) => { payload.truthLabel = "WRONG"; }),
      reportKey,
    ).validSignerKeyids).toEqual([]);
  });
});
