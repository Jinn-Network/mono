// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  binaryJudgmentPromptTemplateDigest,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentLabelResolution,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  sealBinaryJudgmentInstrument,
} from "@jinn-network/task-execution-profiles";
import { dssePreAuthEncoding, parseExactDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import {
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_REVEAL_RECEIPT_MEDIA_TYPE,
  HUMAN_REVIEW_OPERATOR_ASSERTION_MEDIA_TYPE,
  HUMAN_REVIEW_ROSTER_MEDIA_TYPE,
  SCREENING_TABLE_MEDIA_TYPE,
  SCREENING_TABLE_V2_MEDIA_TYPE,
  SCREENING_REVEAL_RECEIPT_MEDIA_TYPE,
  HumanReviewOperatorAssertionSchema,
  HumanReviewRevealReceiptSchema,
  HumanReviewRosterSchema,
  HumanReviewReplacementLedgerSchema,
  HumanReviewReplacementLedgerEntrySchema,
  HumanReviewPacketSchema,
  HumanReviewVisibilityReceiptSchema,
  ScreeningTableSchema,
  ScreeningTableV2Schema,
  ScreeningRevealReceiptSchema,
  PROMPTED_SCREENING_PROCEDURE_PROTOCOL,
  SCREENING_POOL_PROTOCOL,
  SCREENING_POOL_V2_PROTOCOL,
  SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL,
  REGISTERED_SCREENING_SAMPLE_COMMITMENT_V1_SCHEMA,
  SCREENING_SAMPLE_COMMITMENT_PROTOCOL,
  PromptedScreeningProcedureV1Schema,
  ScreeningPoolV1Schema,
  ScreeningPoolV2Schema,
  RegisteredScreeningSampleCommitmentV1Schema,
  ScreeningSampleCommitmentV1Schema,
  computeScreeningPoolDigest,
  computeScreeningSample,
  HUMAN_REVIEW_PACKET_PROTOCOL,
  HUMAN_REVIEW_VISIBILITY_RECEIPT_PROTOCOL,
  HUMAN_REVIEW_OMITTED_FIELDS,
  parseCanonicalHumanReviewBytes,
  sealHumanReviewDocument,
} from "../human-review/contracts.js";
import {
  BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED,
  binaryJudgmentItemBytes,
} from "../human-review/application.js";
import {
  buildBinaryJudgmentAdmissionClosureWorkspacePorts,
  verifyBinaryJudgmentAdmissionClosureInWorkspace,
} from "../human-review/verification-workspace.js";
import { verifyBinaryJudgmentAdmissionClosure, type AdmissionSha256 } from "../human-review/verification.js";
import { readDraftDocument } from "./drafts.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import {
  createVerdictDsseSigner,
  loadOrCreateEvaluatorSigningKeys,
  sealVerdictStatement,
} from "../venue/signing.js";
import { didKeyFromEd25519PublicKey, loadOrCreateReportSigningKey, verifyReportEnvelopeSignatures } from "../report/signing.js";
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
  const digestHex = String(index + 1).repeat(64);
  return {
    itemId: `urn:uuid:123e4567-e89b-12d3-a456-42661417400${index}`,
    question: `Question ${index}?`,
    referenceAnswer: `Reference ${index}`,
    candidateAnswer: `Candidate ${index}`,
    provenance: { sourceCommitment: `sha256:${digestHex}` as const, timestamp: "2026-01-01T00:00:00Z" },
    sources: [{ digest: { sha256: digestHex } }],
  };
}

function screeningMaterials() {
  const messages = [
    { role: "developer", segments: [{ literal: "Synthetic screening rubric. " }] },
    {
      role: "user",
      segments: [
        { literal: "Question: " }, { field: "question" },
        { literal: "\nReference: " }, { field: "referenceAnswer" },
        { literal: "\nCandidate: " }, { field: "candidateAnswer" },
        { literal: "\nEvidence: " }, { field: "evidence" },
      ],
    },
  ] as const;
  const descriptor = {
    uri: "https://fixtures.example.test/screening/prompt",
    digest: { sha256: "a".repeat(64) },
  };
  const instrument = sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: "screening-only",
    messages: messages as never,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: { ...descriptor, uri: "https://fixtures.example.test/licenses/synthetic" },
    attribution: { ...descriptor, uri: "https://fixtures.example.test/screening/attribution" },
    model: {
      adapter: "jinn-openai",
      requested: "gpt-5.6-luna",
      generation: {
        reasoningEffort: "low", maxOutputTokens: 128, store: false, background: false,
        stream: false, serviceTier: "default", tools: [], fallbackModels: [], retries: 0,
        persistedConversation: false, metadata: null, promptCacheIdentifier: null,
      },
    },
    response: {
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
      parser: BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
      invalidOutputDecision: "REJECT",
    },
  });
  const samplingScriptBytes = new Uint8Array([0, 255, 1, 254]);
  const rawOutputsBytes = new Uint8Array([255, 0, 253, 2]);
  return {
    screeningInstrumentSha256: instrument.digest,
    screeningInstrumentBase64: Buffer.from(instrument.bytes).toString("base64"),
    samplingScriptSha256: recordDigest(samplingScriptBytes),
    samplingScriptBase64: Buffer.from(samplingScriptBytes).toString("base64"),
    rawOutputsSha256: recordDigest(rawOutputsBytes),
    rawOutputsBase64: Buffer.from(rawOutputsBytes).toString("base64"),
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

function overlayRecord(overrides: Map<string, Uint8Array>, bytes: Uint8Array): AdmissionSha256 {
  const digest = recordDigest(bytes);
  overrides.set(digest, bytes);
  return digest;
}

function closurePortsWithOverrides(
  context: ReturnType<typeof setup>,
  overrides: Map<string, Uint8Array>,
) {
  const ports = buildBinaryJudgmentAdmissionClosureWorkspacePorts(context.workspaceDir);
  return {
    ...ports,
    resolveExactRecord: (digest: AdmissionSha256) => overrides.get(digest) ?? ports.resolveExactRecord(digest),
  };
}

function rewriteSingleAcceptedResolution(
  context: ReturnType<typeof setup>,
  manifestSha256: string,
  overrides: Map<string, Uint8Array>,
  mutate: (resolution: ReturnType<typeof parseBinaryJudgmentLabelResolution>) => unknown,
): AdmissionSha256 {
  const manifest = BinaryJudgmentAdmissionManifestSchema.parse(JSON.parse(new TextDecoder().decode(
    getSealedBytes(context.workspaceDir, manifestSha256.slice("sha256:".length)),
  )));
  const oldResolutionSha256 = manifest.labelResolutionSha256s[0]!;
  const oldResolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
    context.workspaceDir,
    oldResolutionSha256.slice("sha256:".length),
  ));
  const newResolutionSha256 = overlayRecord(overrides, canonicalJsonBytes(mutate(oldResolution)));
  const oldContextSha256 = manifest.analysisContextSha256s[0]!;
  const oldContext = parseBinaryJudgmentAnalysisContext(getSealedBytes(
    context.workspaceDir,
    oldContextSha256.slice("sha256:".length),
  ));
  const newContextSha256 = overlayRecord(overrides, canonicalJsonBytes({
    ...oldContext,
    labelResolutionSha256: newResolutionSha256,
  }));
  return overlayRecord(overrides, canonicalJsonBytes({
    ...manifest,
    labelResolutionSha256s: [newResolutionSha256],
    analysisContextSha256s: [newContextSha256],
  }));
}

function rewriteLedger(
  context: ReturnType<typeof setup>,
  manifestSha256: string,
  overrides: Map<string, Uint8Array>,
  mutate: (ledger: ReturnType<typeof HumanReviewReplacementLedgerSchema.parse>) => unknown,
): AdmissionSha256 {
  const manifest = BinaryJudgmentAdmissionManifestSchema.parse(JSON.parse(new TextDecoder().decode(
    getSealedBytes(context.workspaceDir, manifestSha256.slice("sha256:".length)),
  )));
  const ledger = HumanReviewReplacementLedgerSchema.parse(JSON.parse(new TextDecoder().decode(
    getSealedBytes(context.workspaceDir, manifest.replacementLedgerSha256.slice("sha256:".length)),
  )));
  const replacementLedgerSha256 = overlayRecord(overrides, canonicalJsonBytes(mutate(ledger)));
  return overlayRecord(overrides, canonicalJsonBytes({ ...manifest, replacementLedgerSha256 }));
}

function rewriteAuthorityPayload(
  context: ReturnType<typeof setup>,
  envelopeBytes: Uint8Array,
  mutate: (payload: Record<string, unknown>) => void,
): Uint8Array {
  const envelope = parseExactDsseEnvelope(envelopeBytes);
  const payload = JSON.parse(new TextDecoder().decode(envelope.payloadBytes)) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = canonicalJsonBytes(payload);
  const key = loadOrCreateReportSigningKey(context.workspaceDir);
  return sealDsseEnvelope({
    payloadType: envelope.payloadType,
    payloadBytes,
    signatures: [{
      keyid: key.keyId,
      signature: key.sign(dssePreAuthEncoding(envelope.payloadType, payloadBytes)),
    }],
  });
}

describe("createHumanReviewPackets — evidence round-trip (P2 acceptance)", () => {
  it("carries an evidence-carrying item through packet creation and back out unchanged", () => {
    const context = setup();
    const evidenceCarryingItem = { ...item(0), evidence: "Direct synthetic verification of item 0." };
    const created = createHumanReviewPackets(context, {
      draftId: "review-run",
      item: evidenceCarryingItem,
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.result.packets).toHaveLength(2);

    for (const packet of created.result.packets) {
      const sealedPacket = parseCanonicalHumanReviewBytes(
        HumanReviewPacketSchema,
        getSealedBytes(context.workspaceDir, packet.packetSha256.slice("sha256:".length)),
        "human review packet",
      );
      expect(sealedPacket.item.evidence).toBe(evidenceCarryingItem.evidence);
      expect(sealedPacket.itemSha256).toBe(created.result.itemSha256);
    }
  });
});

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
    const verifiedClosure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(verifiedClosure).toMatchObject({
      publicationGrade: true,
      classes: ["factual"],
      strata: ["core"],
      accepted: [{ itemSha256: reviewed.packets.itemSha256, truthLabel: "WRONG" }],
      excluded: [],
    });
    expect(verifiedClosure.reachableSha256s).toContain(result.result.admissionManifestSha256);
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
      attestedBy: "operator",
      attestorKeyId: revealEnvelope.signatures[0]!.keyid,
      attestorRole: "truth-reveal-attestor",
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

  it("portable closure replay rejects reviewer signatures and signed authority role/order changes", async () => {
    const context = setup();
    const reviewed = await reviewedItem(context, 0, ["CORRECT", "CORRECT"]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [publicationCandidate(reviewed, 0, 1)],
    });
    if (!result.ok) throw new Error(result.error.detail);
    const resolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
      context.workspaceDir,
      result.result.resolutions[0]!.labelResolutionSha256.slice("sha256:".length),
    ));
    if (resolution.truthAdmission !== "two-human-unanimous") throw new Error("wrong admission kind");

    const badReviewerOverrides = new Map<string, Uint8Array>();
    const badVerdictSha256 = overlayRecord(
      badReviewerOverrides,
      tamperExactEnvelopeSignature(getSealedBytes(
        context.workspaceDir,
        resolution.reviewVerdictSha256s[0].slice("sha256:".length),
      )),
    );
    const badReviewerManifest = rewriteSingleAcceptedResolution(
      context,
      result.result.admissionManifestSha256,
      badReviewerOverrides,
      (value) => ({
        ...value,
        reviewVerdictSha256s: [badVerdictSha256, resolution.reviewVerdictSha256s[1]].sort(compareCodeUnitStrings),
      }),
    );
    expect(() => verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256: badReviewerManifest,
      expectedDraftId: "review-run",
    }, closurePortsWithOverrides(context, badReviewerOverrides))).toThrow(/reviewer signature/u);

    const badRosterOverrides = new Map<string, Uint8Array>();
    const badRosterSha256 = overlayRecord(badRosterOverrides, tamperExactEnvelopeSignature(getSealedBytes(
      context.workspaceDir,
      resolution.reviewerRosterSha256.slice("sha256:".length),
    )));
    const badRosterManifest = rewriteSingleAcceptedResolution(
      context,
      result.result.admissionManifestSha256,
      badRosterOverrides,
      (value) => ({ ...value, reviewerRosterSha256: badRosterSha256 }),
    );
    expect(() => verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256: badRosterManifest,
      expectedDraftId: "review-run",
    }, closurePortsWithOverrides(context, badRosterOverrides))).toThrow(/authority signature/u);

    for (const mutate of [
      (payload: Record<string, unknown>) => { payload.attestorRole = "roster-attestor"; },
      (payload: Record<string, unknown>) => { payload.truthFrozenAt = "2026-08-15T08:00:00.000Z"; },
    ]) {
      const overrides = new Map<string, Uint8Array>();
      const revealSha256 = overlayRecord(overrides, rewriteAuthorityPayload(
        context,
        getSealedBytes(context.workspaceDir, resolution.revealReceiptSha256.slice("sha256:".length)),
        mutate,
      ));
      const manifestSha256 = rewriteSingleAcceptedResolution(
        context,
        result.result.admissionManifestSha256,
        overrides,
        (value) => ({ ...value, revealReceiptSha256: revealSha256 }),
      );
      expect(() => verifyBinaryJudgmentAdmissionClosure({
        admissionManifestSha256: manifestSha256,
        expectedDraftId: "review-run",
      }, closurePortsWithOverrides(context, overrides))).toThrow();
    }
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

  // Item 3 (§6.10 byte-compatibility, the ledger byte-identity proof the coordinator specifically
  // asked for): S1 widened `HumanReviewReplacementLedgerEntrySchema`'s four per-item two-human
  // digest fields (reviewVerdictSha256s, visibilityReceiptSha256s, reviewerRosterSha256,
  // revealReceiptSha256) from unconditionally required to present-iff-a-two-human-reason. That is
  // a compatible widening under §0.4 only if a REAL two-human ledger entry still carries all four
  // fields, byte for byte, exactly as it did before the schema could express their absence. This
  // test proves the field SET on a real two-human entry is unchanged (all four present) and, by
  // contrast, that a real screened entry (built via `admitHumanTruth`, not hand-constructed) never
  // carries any of the four -- the two ends of the same present-iff rule, both driven by the real
  // production operation.
  it("byte-identity: a two-human ledger entry still carries all four review digests; a screened one carries none", async () => {
    const context = setup();
    const disputed = await reviewedItem(context, 0, ["CORRECT", "WRONG"]);
    const reserve = await reviewedItem(context, 1, ["WRONG", "WRONG"]);
    const twoHumanResult = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [
        publicationCandidate(disputed, 0, 1),
        publicationCandidate(reserve, 1, 2, { replacesItemSha256: disputed.packets.itemSha256 }),
      ],
    });
    if (!twoHumanResult.ok) throw new Error(twoHumanResult.error.detail);
    const twoHumanLedger = HumanReviewReplacementLedgerSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, twoHumanResult.result.replacementLedgerSha256.slice("sha256:".length)),
    )));
    expect(twoHumanLedger.entries).toHaveLength(1);
    expect(Object.keys(twoHumanLedger.entries[0]!).sort()).toEqual([
      "candidateClass", "excludedItemSha256", "excludedPoolPosition", "reason", "replacementItemSha256",
      "replacementPoolPosition", "reviewVerdictSha256s", "reviewerRosterSha256", "revealReceiptSha256",
      "stratum", "visibilityReceiptSha256s",
    ].sort());
    for (const field of ["reviewVerdictSha256s", "visibilityReceiptSha256s", "reviewerRosterSha256", "revealReceiptSha256"]) {
      expect(twoHumanLedger.entries[0]).toHaveProperty(field);
    }

    function screenableItemForByteIdentity(index: number) {
      const packets = createHumanReviewPackets(context, {
        draftId: "review-run",
        item: item(index),
        evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      });
      if (!packets.ok) throw new Error(packets.error.detail);
      return packets.result;
    }
    const screenedDisputed = screenableItemForByteIdentity(2);
    const screenedReserve = screenableItemForByteIdentity(3);
    const screenedResult = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [
        {
          itemSha256: screenedDisputed.itemSha256,
          itemId: item(2).itemId,
          humanReviewEvaluationSpecSha256: screenedDisputed.humanReviewEvaluationSpecSha256,
          candidateClass: "factual",
          stratum: "core",
          poolPosition: 3,
        },
        {
          itemSha256: screenedReserve.itemSha256,
          itemId: item(3).itemId,
          humanReviewEvaluationSpecSha256: screenedReserve.humanReviewEvaluationSpecSha256,
          candidateClass: "factual",
          stratum: "core",
          poolPosition: 4,
          replacesItemSha256: screenedDisputed.itemSha256,
        },
      ],
      screening: {
        ...screeningMaterials(),
        sampleSeed: "synthetic-byte-identity-seed",
        sampleSize: 2,
        rows: [screenedDisputed, screenedReserve]
          .map((packets, index) => ({
            itemSha256: packets.itemSha256,
            // index 0 (disputed): screen disagrees with the intended label, hand-excludes it.
            // index 1 (reserve): screen agrees, hand-confirms it -- the admitted replacement.
            intendedLabel: index === 0 ? "CORRECT" as const : "WRONG" as const,
            screeningVerdict: "WRONG" as const,
            handChecked: true,
            handVerdict: index === 0 ? "exclude" as const : "confirm" as const,
          }))
          .sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256)),
      },
    });
    if (!screenedResult.ok) throw new Error(screenedResult.error.detail);
    const screenedLedger = HumanReviewReplacementLedgerSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, screenedResult.result.replacementLedgerSha256.slice("sha256:".length)),
    )));
    expect(screenedLedger.entries).toHaveLength(1);
    expect(Object.keys(screenedLedger.entries[0]!).sort()).toEqual([
      "candidateClass", "excludedItemSha256", "excludedPoolPosition", "reason",
      "replacementItemSha256", "replacementPoolPosition", "stratum",
    ].sort());
    for (const field of ["reviewVerdictSha256s", "visibilityReceiptSha256s", "reviewerRosterSha256", "revealReceiptSha256"]) {
      expect(screenedLedger.entries[0]).not.toHaveProperty(field);
    }
  });

  it("verifies a replacement-ledger entry carrying a four-category stratum (spec §3.1 site 9)", async () => {
    const context = setup();
    const disputed = await reviewedItem(context, 0, ["CORRECT", "WRONG"]);
    const reserve = await reviewedItem(context, 1, ["WRONG", "WRONG"]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "two-human-unanimous",
      candidates: [
        publicationCandidate(disputed, 0, 1, { stratum: "category-3" }),
        publicationCandidate(reserve, 1, 2, { stratum: "category-3", replacesItemSha256: disputed.packets.itemSha256 }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verifiedClosure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(verifiedClosure.strata).toEqual(["category-3"]);
    expect(verifiedClosure.excluded).toEqual([{
      itemSha256: disputed.packets.itemSha256,
      itemId: item(0).itemId,
      candidateClass: "factual",
      stratum: "category-3",
      reason: "review-disagreement",
      replacementItemSha256: reserve.packets.itemSha256,
    }]);
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
    if (!result.ok) throw new Error(result.error.detail);
    expect(verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    }).excluded.map((entry) => entry.reason)).toEqual(["review-incomplete", "review-indeterminate"]);

    const forgedManifestOverrides = new Map<string, Uint8Array>();
    const manifest = BinaryJudgmentAdmissionManifestSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, result.result.admissionManifestSha256.slice("sha256:".length)),
    )));
    const forgedManifestSha256 = overlayRecord(forgedManifestOverrides, canonicalJsonBytes({
      ...manifest,
      admittedAt: "2026-08-15T09:11:00.000Z",
    }));
    expect(() => verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256: forgedManifestSha256,
      expectedDraftId: "review-run",
    }, closurePortsWithOverrides(context, forgedManifestOverrides))).toThrow(/ledger draft\/time/u);

    const ledgerMutations: Array<(ledger: ReturnType<typeof HumanReviewReplacementLedgerSchema.parse>) => unknown> = [
      (ledger) => ({ ...ledger, entries: [...ledger.entries].reverse() }),
      (ledger) => ({ ...ledger, entries: ledger.entries.map((entry, index) => index === 0 ? { ...entry, reason: "review-disagreement" } : entry) }),
      (ledger) => ({
        ...ledger,
        entries: ledger.entries.map((entry, index) => index === 1 ? {
          ...entry,
          replacementItemSha256: ledger.entries[0]!.replacementItemSha256,
          replacementPoolPosition: ledger.entries[0]!.replacementPoolPosition,
        } : entry),
      }),
      (ledger) => {
        const value = JSON.parse(JSON.stringify(ledger)) as { entries: Array<Record<string, unknown>> };
        delete value.entries[0]!.reviewerRosterSha256;
        return value;
      },
    ];
    for (const mutate of ledgerMutations) {
      const overrides = new Map<string, Uint8Array>();
      const admissionManifestSha256 = rewriteLedger(
        context,
        result.result.admissionManifestSha256,
        overrides,
        mutate,
      );
      expect(() => verifyBinaryJudgmentAdmissionClosure({
        admissionManifestSha256,
        expectedDraftId: "review-run",
      }, closurePortsWithOverrides(context, overrides))).toThrow();
    }

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
    expect(verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    })).toMatchObject({ publicationGrade: false, accepted: [{ truthAdmission: "operator-only" }], excluded: [] });
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
      attestorKeyId: assertionEnvelope.signatures[0]!.keyid,
      attestorRole: "operator-truth-attestor",
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
    const assertionOverrides = new Map<string, Uint8Array>();
    const badAssertionSha256 = overlayRecord(assertionOverrides, tamperExactEnvelopeSignature(assertionBytes));
    const badAssertionManifestSha256 = rewriteSingleAcceptedResolution(
      context,
      result.result.admissionManifestSha256,
      assertionOverrides,
      (value) => ({ ...value, operatorAssertionSha256: badAssertionSha256 }),
    );
    expect(() => verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256: badAssertionManifestSha256,
      expectedDraftId: "review-run",
    }, closurePortsWithOverrides(context, assertionOverrides))).toThrow(/authority signature/u);
  });
});

// Screened-operator-sampled admission (spec §6.3, §6.4, §6.6; packet P6, S3b). RULING C-4: the
// screening table and reveal receipt are sealed BY admitHumanTruth from caller-supplied content,
// exactly as the reviewer roster and per-item reveal receipt are today. RULING C-6: the table is
// DSSE-signed via sealRoleEvidence, never bare canonical JSON. Every digest and label below is
// synthetic.
describe("binary screened-operator-sampled admission", () => {
  const syntheticDigest = (character: string) => `sha256:${character.repeat(64)}` as const;

  function screenableItem(context: ReturnType<typeof setup>, index: number) {
    const packets = createHumanReviewPackets(context, {
      draftId: "review-run",
      item: item(index),
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    });
    if (!packets.ok) throw new Error(packets.error.detail);
    return packets.result;
  }

  function screenedCandidate(
    packets: CreateHumanReviewPacketsResult,
    index: number,
    poolPosition: number,
    extras: Record<string, unknown> = {},
  ) {
    return {
      itemSha256: packets.itemSha256,
      itemId: item(index).itemId,
      humanReviewEvaluationSpecSha256: packets.humanReviewEvaluationSpecSha256,
      candidateClass: "factual",
      stratum: "core" as const,
      poolPosition,
      ...extras,
    };
  }

  function screeningRow(
    itemSha256: string,
    intendedLabel: "CORRECT" | "WRONG",
    screeningVerdict: "CORRECT" | "WRONG" | "indeterminate",
    handChecked: boolean,
    handVerdict?: "confirm" | "exclude",
  ) {
    return {
      itemSha256,
      intendedLabel,
      screeningVerdict,
      handChecked,
      ...(handVerdict === undefined ? {} : { handVerdict }),
    };
  }

  function sortedRows<T extends { itemSha256: string }>(rows: readonly T[]): T[] {
    return [...rows].sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256));
  }

  function screeningInput(rows: ReturnType<typeof screeningRow>[]) {
    return {
      ...screeningMaterials(),
      sampleSeed: "synthetic-screening-seed",
      sampleSize: 1,
      rows: sortedRows(rows),
    };
  }

  function promptedScreeningInput(context: ReturnType<typeof setup>, sharedReserves = false) {
    const candidateClasses = ["correct", "specific-wrong", "vague-topical-wrong"] as const;
    const strata = ["category-1", "category-2", "category-3", "category-4"] as const;
    const source = Array.from({ length: 664 }, (_, index) => {
      const mainIndex = index < 240 ? index : index < 480 ? index - 240 : index - 480;
      const candidateClass = candidateClasses[Math.floor(mainIndex / 80)]!;
      const stratum = strata[Math.floor((mainIndex % 80) / 20)]!;
      const payload = {
        itemId: `urn:uuid:00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        question: `Synthetic prompted question ${index + 1}?`,
        referenceAnswer: `Synthetic reference ${index + 1}`,
        candidateAnswer: `Synthetic candidate ${index + 1}`,
        provenance: {
          sourceCommitment: recordDigest(new TextEncoder().encode(`source-${index + 1}`)),
          timestamp: "2026-08-15T07:00:00Z",
        },
        sources: [{ digest: { sha256: recordDigest(new TextEncoder().encode(`record-${index + 1}`)).slice("sha256:".length) } }],
      };
      const bytes = binaryJudgmentItemBytes(payload);
      const itemSha256 = recordDigest(bytes);
      if (!sharedReserves) putSealedBytes(context.workspaceDir, bytes);
      const slotNumber = mainIndex + 1;
      return {
        payload,
        candidate: {
          itemSha256,
          itemId: payload.itemId,
          ...(sharedReserves ? { itemBase64: Buffer.from(bytes).toString("base64") } : {}),
          humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
          candidateClass,
          stratum,
          poolPosition: index + 1,
        },
        poolItem: sharedReserves
          ? index < 240
            ? {
                screeningIdentitySha256: recordDigest(new TextEncoder().encode(`screening-identity-${index + 1}`)),
                itemSha256,
                intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const,
                candidateClass,
                stratum,
                poolPosition: index + 1,
                sourceQuestionLineageId: `question-${index + 1}`,
                slotId: `slot-${String(slotNumber).padStart(3, "0")}`,
                poolKind: "main" as const,
              }
            : {
                screeningIdentitySha256: recordDigest(new TextEncoder().encode(`screening-identity-${index + 1}`)),
                itemSha256,
                intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const,
                candidateClass,
                stratum,
                poolPosition: index + 1,
                sourceQuestionLineageId: `question-${index + 1}`,
                poolKind: "reserve" as const,
                reserveOrder: (index < 480 ? 0 : 20) + (mainIndex % 20) + 1,
              }
          : index < 240
            ? { itemSha256, intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const, candidateClass, stratum, poolPosition: index + 1, slotId: `slot-${String(slotNumber).padStart(3, "0")}`, poolKind: "main" as const }
            : { itemSha256, intendedLabel: candidateClass === "correct" ? "CORRECT" as const : "WRONG" as const, candidateClass, stratum, poolPosition: index + 1, slotId: `slot-${String(slotNumber).padStart(3, "0")}`, poolKind: "reserve" as const, reserveOrder: index < 480 ? 1 : 2 },
      };
    });
    const promptBytes = new TextEncoder().encode("Synthetic opaque coordinator prompt\n");
    const transcriptBytes = new Uint8Array([0, 255, 2, 253]);
    const scriptBytes = new Uint8Array([255, 1, 254, 3]);
    const promptSha256 = recordDigest(promptBytes);
    const transcriptSha256 = recordDigest(transcriptBytes);
    const procedure = sealHumanReviewDocument(PromptedScreeningProcedureV1Schema, {
      protocol: PROMPTED_SCREENING_PROCEDURE_PROTOCOL,
      procedureId: "prompted-codex-screening/v1",
      coordinatorPromptSha256: promptSha256,
      coordinator: { alias: "Sol", model: "gpt-5.6-sol", reasoningEffort: "high", mayOrchestrate: true },
      judgmentAgents: [
        { alias: "Luna", model: "gpt-5.6-luna", reasoningEffort: "medium", maxBatchSize: 32 },
        { alias: "Terra", model: "gpt-5.6-terra", reasoningEffort: "high", maxBatchSize: 16 },
        { alias: "Sol", model: "gpt-5.6-sol", reasoningEffort: "high", maxBatchSize: 8 },
      ],
      toolPolicy: { coordinator: "orchestration-only", judgmentAgents: { web: false, shell: false, repository: false, search: false } },
      output: { alphabet: ["CORRECT", "WRONG", "UNSURE"], invalidOutputDecision: "UNSURE" },
      retry: { maxRetries: 1, onlyWhen: "infrastructure-failure-with-no-model-output", prompt: "identical" },
      transcriptSha256,
      // The shared-reserve fixture mirrors the real append-only transport amendment: the
      // procedure may be sealed after the pool/sample commitment, but still before admission.
      sealedAt: sharedReserves ? "2026-08-15T08:30:00.000Z" : "2026-08-15T08:00:00.000Z",
    }, "prompted screening procedure");
    const poolIdentities: string[] = source.map((entry) => {
      if (sharedReserves && "screeningIdentitySha256" in entry.poolItem) {
        const identity = entry.poolItem.screeningIdentitySha256;
        if (identity === undefined) throw new Error("shared reserve fixture lacks a screening identity");
        return identity;
      }
      return entry.poolItem.itemSha256;
    });
    const pool = sharedReserves
      ? sealHumanReviewDocument(ScreeningPoolV2Schema, {
          protocol: SCREENING_POOL_V2_PROTOCOL,
          reserveSelectionProtocol: SCREENING_POOL_V2_RESERVE_SELECTION_PROTOCOL,
          draftId: "review-run",
          identityCommitmentSha256: computeScreeningPoolDigest(poolIdentities),
          items: source.map((entry) => entry.poolItem),
          sealedAt: "2026-08-15T08:40:00.000Z",
        }, "screening pool v2")
      : sealHumanReviewDocument(ScreeningPoolV1Schema, {
          protocol: SCREENING_POOL_PROTOCOL,
          draftId: "review-run",
          identityCommitmentSha256: computeScreeningPoolDigest(poolIdentities),
          items: source.map((entry) => entry.poolItem),
          sealedAt: "2026-08-15T08:10:00.000Z",
        }, "screening pool");
    const sampleItemSha256s = [...computeScreeningSample({ itemSha256s: poolIdentities, sampleSeed: "synthetic-prompted-seed", sampleSize: 72 }).sample]
      .sort(compareCodeUnitStrings);
    const registeredCommitment = RegisteredScreeningSampleCommitmentV1Schema.parse({
          schema: REGISTERED_SCREENING_SAMPLE_COMMITMENT_V1_SCHEMA,
          candidateItemDigests: [...poolIdentities].sort(compareCodeUnitStrings),
          committedAt: "2026-08-15T08:20:00.000Z",
          poolDigest: pool.value.identityCommitmentSha256,
          sampleSeed: "synthetic-prompted-seed",
          sampleSize: 72,
          samplingScriptSha256: recordDigest(scriptBytes),
        });
    const registeredCommitmentBytes = new Uint8Array([...canonicalJsonBytes(registeredCommitment), 0x0a]);
    const commitment = sharedReserves
      ? { value: registeredCommitment, bytes: registeredCommitmentBytes, digest: recordDigest(registeredCommitmentBytes) }
      : sealHumanReviewDocument(ScreeningSampleCommitmentV1Schema, {
          protocol: SCREENING_SAMPLE_COMMITMENT_PROTOCOL,
          draftId: "review-run",
          poolSha256: pool.digest,
          poolIdentityCommitmentSha256: pool.value.identityCommitmentSha256,
          samplingProcedure: "screening-sample/1",
          sampleSeed: "synthetic-prompted-seed",
          sampleSize: 72,
          sampleItemSha256s,
          committedAt: "2026-08-15T08:20:00.000Z",
        }, "screening sample commitment");
    const rows = source.map((entry, index) => ({
      itemSha256: entry.poolItem.itemSha256,
      intendedLabel: entry.poolItem.intendedLabel,
      screeningVerdict: entry.poolItem.intendedLabel,
      ritsuDecision: index === 0
        ? { checked: true as const, verdict: "exclude" as const, decidedAt: "2026-08-15T08:30:00.000Z" }
        : { checked: true as const, verdict: "confirm" as const, decidedAt: "2026-08-15T08:30:00.000Z" },
    })).sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256));
    return {
      candidates: source.map((entry) => entry.candidate),
      screening: {
        coordinatorPromptSha256: promptSha256,
        coordinatorPromptBase64: Buffer.from(promptBytes).toString("base64"),
        procedureSha256: procedure.digest,
        procedureBase64: Buffer.from(procedure.bytes).toString("base64"),
        poolSha256: pool.digest,
        poolBase64: Buffer.from(pool.bytes).toString("base64"),
        sampleCommitmentSha256: commitment.digest,
        sampleCommitmentBase64: Buffer.from(commitment.bytes).toString("base64"),
        samplingScriptSha256: recordDigest(scriptBytes),
        samplingScriptBase64: Buffer.from(scriptBytes).toString("base64"),
        transcriptSha256,
        transcriptBase64: Buffer.from(transcriptBytes).toString("base64"),
        rows,
      },
    };
  }

  it("admits a complete prompted-v2 pool, selects first admissible reserves, and publishes every nested role", () => {
    const context = setup();
    const fixture = promptedScreeningInput(context);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      ...fixture,
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.result.resolutions).toHaveLength(240);
    expect(result.result.exclusions).toHaveLength(1);
    expect(result.result.exclusions[0]).toMatchObject({
      itemSha256: fixture.candidates[0]!.itemSha256,
      replacementItemSha256: fixture.candidates[240]!.itemSha256,
      reason: "screening-hand-excluded",
    });
    const closure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(closure.promptedScreening).toMatchObject({ profile: "prompted-codex-screening/v1", sampleAgreementRate: 1 });
    expect(closure.reachableRecords.flatMap((entry) => entry.roles)).toEqual(expect.arrayContaining([
      "screening-prompt", "screening-procedure", "screening-pool", "screening-sample-commitment",
      "screening-sampling-script", "screening-transcript", "screening-table", "source-item",
    ]));
    const resolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
      context.workspaceDir,
      result.result.resolutions[0]!.labelResolutionSha256.slice("sha256:".length),
    ));
    if (resolution.truthAdmission !== "screened-operator-sampled") throw new Error("wrong admission kind");
    const envelope = parseExactDsseEnvelope(getSealedBytes(context.workspaceDir, resolution.screeningTableSha256.slice("sha256:".length)));
    expect(envelope.payloadType).toBe(SCREENING_TABLE_V2_MEDIA_TYPE);
    expect(ScreeningTableV2Schema.parse(JSON.parse(new TextDecoder().decode(envelope.payloadBytes)))).toMatchObject({ operator: "Ritsu", draftId: "review-run" });
  }, 60_000);

  it("admits a privacy-identity pool with shared cell reserves and records the receiving slot", () => {
    const context = setup();
    const fixture = promptedScreeningInput(context, true);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      ...fixture,
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.result.resolutions).toHaveLength(240);
    expect(result.result.exclusions).toEqual([expect.objectContaining({
      itemSha256: fixture.candidates[0]!.itemSha256,
      replacementItemSha256: fixture.candidates[240]!.itemSha256,
      receivingSlotId: "slot-001",
    })]);
    const closure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(closure.accepted).toHaveLength(240);
    expect(closure.excluded).toEqual([expect.objectContaining({ receivingSlotId: "slot-001" })]);
    expect(closure.promptedScreening?.sampleAgreementRate).toBe(1);
  }, 60_000);

  it("orders a shared-reserve ledger by receiving slot even when valid mains arrive out of slot order", () => {
    const context = setup();
    const fixture = promptedScreeningInput(context, true);
    const pool = ScreeningPoolV2Schema.parse(JSON.parse(Buffer.from(
      fixture.screening.poolBase64,
      "base64",
    ).toString("utf8")));
    const firstSlotId = pool.items[0]!.poolKind === "main" ? pool.items[0]!.slotId : undefined;
    const secondSlotId = pool.items[1]!.poolKind === "main" ? pool.items[1]!.slotId : undefined;
    if (firstSlotId === undefined || secondSlotId === undefined) throw new Error("fixture mains lack slots");
    const reorderedPool = sealHumanReviewDocument(ScreeningPoolV2Schema, {
      ...pool,
      items: pool.items.map((item, index) => {
        if (item.poolKind !== "main") return item;
        if (index === 0) return { ...item, slotId: secondSlotId };
        if (index === 1) return { ...item, slotId: firstSlotId };
        return item;
      }),
    }, "reordered screening pool v2");
    const additionallyExcluded = fixture.candidates[1]!.itemSha256;
    const rows = fixture.screening.rows.map((row) => row.itemSha256 === additionallyExcluded
      ? {
          ...row,
          ritsuDecision: {
            checked: true as const,
            verdict: "exclude" as const,
            decidedAt: "2026-08-15T08:30:00.000Z",
          },
        }
      : row);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: fixture.candidates,
      screening: {
        ...fixture.screening,
        poolSha256: reorderedPool.digest,
        poolBase64: Buffer.from(reorderedPool.bytes).toString("base64"),
        rows,
      },
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    const ledger = HumanReviewReplacementLedgerSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, result.result.replacementLedgerSha256.slice("sha256:".length)),
    )));
    expect(ledger.entries.map((entry) => entry.receivingSlotId)).toEqual(["slot-001", "slot-002"]);
    expect(() => verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    })).not.toThrow();
  }, 60_000);

  it("refuses prompted-v2 nested-byte tampering before storing a partial closure", () => {
    const context = setup();
    const fixture = promptedScreeningInput(context);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: fixture.candidates,
      screening: { ...fixture.screening, transcriptBase64: Buffer.from("tampered").toString("base64") },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation", issues: [{ path: "screening.transcriptSha256" }] } });
  }, 60_000);

  it("admits screened truth from a bank-scoped table when the screen agrees, DSSE-signed once", async () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [screenedCandidate(packets, 0, 1)],
      screening: screeningInput([screeningRow(packets.itemSha256, "CORRECT", "CORRECT", true, "confirm")]),
    });
    expect(result).toMatchObject({ ok: true, result: { publicationGrade: true, exclusions: [] } });
    if (!result.ok) return;

    const resolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
      context.workspaceDir,
      result.result.resolutions[0]!.labelResolutionSha256.slice("sha256:".length),
    ));
    expect(resolution).toMatchObject({ truthAdmission: "screened-operator-sampled", truthLabel: "CORRECT" });
    // §6.7: a row never hand-checked has no human-review evaluation — but this test's row WAS
    // hand-checked, and the screened resolution still carries no humanReviewEvaluationSpecSha256
    // at all, unconditionally, because the screened branch never references it (truth comes from
    // the table, not a human-review evaluation).
    expect("humanReviewEvaluationSpecSha256" in resolution).toBe(false);
    if (resolution.truthAdmission !== "screened-operator-sampled") throw new Error("wrong admission kind");

    // RULING C-6: the table digest names a DSSE envelope, not bare canonical JSON.
    const tableEnvelope = parseExactDsseEnvelope(getSealedBytes(
      context.workspaceDir,
      resolution.screeningTableSha256.slice("sha256:".length),
    ));
    expect(tableEnvelope.payloadType).toBe(SCREENING_TABLE_MEDIA_TYPE);
    expect(tableEnvelope.signatures).toHaveLength(1);
    const table = ScreeningTableSchema.parse(JSON.parse(new TextDecoder().decode(tableEnvelope.payloadBytes)));
    expect(table).toMatchObject({ draftId: "review-run", sampleSeed: "synthetic-screening-seed" });
    expect(table.rows).toEqual([{
      itemSha256: packets.itemSha256, intendedLabel: "CORRECT", screeningVerdict: "CORRECT",
      handChecked: true, handVerdict: "confirm",
    }]);

    const receiptEnvelope = parseExactDsseEnvelope(getSealedBytes(
      context.workspaceDir,
      resolution.screeningRevealReceiptSha256.slice("sha256:".length),
    ));
    expect(receiptEnvelope.payloadType).toBe(SCREENING_REVEAL_RECEIPT_MEDIA_TYPE);
    expect(receiptEnvelope.signatures).toHaveLength(1);
    const receipt = ScreeningRevealReceiptSchema.parse(JSON.parse(new TextDecoder().decode(receiptEnvelope.payloadBytes)));
    expect(receipt).toMatchObject({
      draftId: "review-run",
      screeningTableSha256: resolution.screeningTableSha256,
      judgeExecutionState: "not-started",
      attestorRole: "truth-reveal-attestor",
    });
    // Both bank-scoped records are signed by the SAME report signing key.
    expect(receiptEnvelope.signatures[0]!.keyid).toBe(tableEnvelope.signatures[0]!.keyid);

    const closure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(closure).toMatchObject({
      publicationGrade: true,
      accepted: [{ truthAdmission: "screened-operator-sampled", truthLabel: "CORRECT" }],
      excluded: [],
      screening: { sampleAgreementRate: 1 },
    });
    const materials = screeningMaterials();
    expect(getSealedBytes(context.workspaceDir, materials.screeningInstrumentSha256.slice("sha256:".length)))
      .toEqual(new Uint8Array(Buffer.from(materials.screeningInstrumentBase64, "base64")));
    expect(getSealedBytes(context.workspaceDir, materials.samplingScriptSha256.slice("sha256:".length)))
      .toEqual(new Uint8Array(Buffer.from(materials.samplingScriptBase64, "base64")));
    expect(getSealedBytes(context.workspaceDir, materials.rawOutputsSha256.slice("sha256:".length)))
      .toEqual(new Uint8Array(Buffer.from(materials.rawOutputsBase64, "base64")));
    expect(closure.reachableRecords.flatMap((entry) => entry.roles)).toEqual(expect.arrayContaining([
      "screening-instrument", "screening-sampling-script", "screening-raw-outputs",
    ]));
  });

  it.each([
    "screeningInstrumentSha256",
    "samplingScriptSha256",
    "rawOutputsSha256",
  ] as const)("refuses when %s does not match the supplied exact bytes", (field) => {
    const context = setup();
    const packets = screenableItem(context, 0);
    const screening = screeningInput([
      screeningRow(packets.itemSha256, "CORRECT", "CORRECT", true, "confirm"),
    ]);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [screenedCandidate(packets, 0, 1)],
      screening: { ...screening, [field]: syntheticDigest("d") },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation", issues: [{ path: `screening.${field}` }] },
    });
  });

  it("refuses a digest-valid marker or noncanonical bytes as the screening instrument", () => {
    for (const instrumentBytes of [
      new TextEncoder().encode("synthetic screening instrument"),
      new TextEncoder().encode(JSON.stringify(
        JSON.parse(Buffer.from(screeningMaterials().screeningInstrumentBase64, "base64").toString("utf8")),
        null,
        2,
      )),
    ]) {
      const context = setup();
      const packets = screenableItem(context, 0);
      const result = admitHumanTruth(context, {
        draftId: "review-run",
        truthAdmission: "screened-operator-sampled",
        candidates: [screenedCandidate(packets, 0, 1)],
        screening: {
          ...screeningInput([screeningRow(packets.itemSha256, "CORRECT", "CORRECT", true, "confirm")]),
          screeningInstrumentSha256: recordDigest(instrumentBytes),
          screeningInstrumentBase64: Buffer.from(instrumentBytes).toString("base64"),
        },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "validation", issues: [{ path: "screening.screeningInstrumentBase64" }] },
      });
    }
  });

  it("excludes a screen-disagreement row and seals a same-slice reserve replacement", async () => {
    const context = setup();
    const disputed = screenableItem(context, 0);
    const reserve = screenableItem(context, 1);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [
        screenedCandidate(disputed, 0, 1),
        screenedCandidate(reserve, 1, 2, { replacesItemSha256: disputed.itemSha256 }),
      ],
      screening: screeningInput([
        screeningRow(disputed.itemSha256, "CORRECT", "WRONG", true, "exclude"),
        screeningRow(reserve.itemSha256, "WRONG", "WRONG", true, "confirm"),
      ]),
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        publicationGrade: true,
        exclusions: [{
          itemSha256: disputed.itemSha256,
          reason: "screening-disagreement",
          replacementItemSha256: reserve.itemSha256,
        }],
      },
    });
    if (!result.ok) return;
    expect(result.result.resolutions.map((entry) => entry.itemSha256)).toEqual([reserve.itemSha256]);

    const ledger = HumanReviewReplacementLedgerSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, result.result.replacementLedgerSha256.slice("sha256:".length)),
    )));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ reason: "screening-disagreement" });
    expect("reviewVerdictSha256s" in ledger.entries[0]!).toBe(false);
    expect("reviewerRosterSha256" in ledger.entries[0]!).toBe(false);

    const closure = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    });
    expect(closure.excluded).toEqual([{
      itemSha256: disputed.itemSha256,
      itemId: item(0).itemId,
      candidateClass: "factual",
      stratum: "core",
      reason: "screening-disagreement",
      replacementItemSha256: reserve.itemSha256,
    }]);
  });

  it("excludes an indeterminate screen and, separately, an R-3 hand-excluded tie-break", async () => {
    const context = setup();
    const indeterminate = screenableItem(context, 0);
    const indeterminateReserve = screenableItem(context, 1);
    const tieBreak = screenableItem(context, 2);
    const tieBreakReserve = screenableItem(context, 3);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [
        screenedCandidate(indeterminate, 0, 1),
        screenedCandidate(indeterminateReserve, 1, 2, { replacesItemSha256: indeterminate.itemSha256 }),
        screenedCandidate(tieBreak, 2, 3),
        screenedCandidate(tieBreakReserve, 3, 4, { replacesItemSha256: tieBreak.itemSha256 }),
      ],
      screening: screeningInput([
        screeningRow(indeterminate.itemSha256, "CORRECT", "indeterminate", true, "exclude"),
        screeningRow(indeterminateReserve.itemSha256, "WRONG", "WRONG", true, "confirm"),
        // R-3 tie-break: the screen AGREED (WRONG === WRONG), but the hand check overrode it.
        screeningRow(tieBreak.itemSha256, "WRONG", "WRONG", true, "exclude"),
        screeningRow(tieBreakReserve.itemSha256, "CORRECT", "CORRECT", true, "confirm"),
      ]),
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        exclusions: [
          { itemSha256: indeterminate.itemSha256, reason: "screening-indeterminate" },
          { itemSha256: tieBreak.itemSha256, reason: "screening-hand-excluded" },
        ],
      },
    });
    if (!result.ok) throw new Error(result.error.detail);
    expect(verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: context.workspaceDir,
      admissionManifestSha256: result.result.admissionManifestSha256 as AdmissionSha256,
      expectedDraftId: "review-run",
    }).excluded.map((entry) => entry.reason)).toEqual(["screening-indeterminate", "screening-hand-excluded"]);
  });

  it("refuses a screened candidate carrying operator or review fields (item B shape check)", () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    const screening = screeningInput([screeningRow(packets.itemSha256, "CORRECT", "CORRECT", true, "confirm")]);
    for (const extras of [
      { operatorTruthLabel: "CORRECT" as const },
      { reviewVerdictSha256s: [syntheticDigest("1"), syntheticDigest("2")] as [string, string] },
      {
        reviewers: [
          { evaluatorId: "urn:jinn:reviewer:a", personId: "person-a", role: "domain-reviewer", conflicts: [] },
          { evaluatorId: "urn:jinn:reviewer:b", personId: "person-b", role: "domain-reviewer", conflicts: [] },
        ],
      },
    ]) {
      expect(admitHumanTruth(context, {
        draftId: "review-run",
        truthAdmission: "screened-operator-sampled",
        candidates: [screenedCandidate(packets, 0, 1, extras)],
        screening,
      })).toMatchObject({ ok: false, error: { code: "validation" } });
    }
  });

  it("refuses screened-operator-sampled admission without screening table content", () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [screenedCandidate(packets, 0, 1)],
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses screening table content on a non-screened admission (present-iff, both directions)", () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256: packets.itemSha256,
        itemId: item(0).itemId,
        humanReviewEvaluationSpecSha256: packets.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT" as const,
      }],
      screening: screeningInput([screeningRow(packets.itemSha256, "CORRECT", "CORRECT", false)]),
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("refuses a screened candidate with no covering screening-table row", () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    expect(admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [screenedCandidate(packets, 0, 1)],
      screening: screeningInput([screeningRow(syntheticDigest("f"), "CORRECT", "CORRECT", false)]),
    })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  // Item 4b (RULING C-6, spec §6.3's final sentence + §6.9's argument for dropping 240 per-item
  // signatures): D1's shape is ONE operator key signing BOTH bank-scoped records. A runtime keyId
  // cross-check between the table and the receipt is NOT needed, and adding one would be a
  // redundant pin -- the existing authority path already refuses a two-key screened bundle, and
  // the mechanism is stronger than an authority-set-shape argument. This test proves the refusal;
  // it adds no production code.
  //
  // The mechanism, mirrored here at the admission-closure level (this workspace's own
  // `buildBinaryJudgmentAdmissionClosureWorkspacePorts`, `../human-review/verification-workspace.ts`)
  // and structurally identical to the standalone bundle verifier's own port
  // (`packages/benchmark-product/check/src/verify.ts:610-612`): every authority signature must
  // (1) name a keyId that binds the record's role, AND (2) that keyId must equal the single
  // report-signing key for the whole workspace/bundle -- so if the table is signed by key A and
  // the receipt by key B, at most one of the two can ever equal the report key, and the other
  // fails clause (2) regardless of what any authority-role SET declares. Going through the full
  // bundle-materialization pipeline to prove this would require re-signing every verdict for the
  // affected item (the receipt digest is embedded in the resolution, which is embedded in every
  // verdict's `labelResolutionSha256` measurement) -- an unrelated cascade this admission-closure
  // level does not need, because `verifyBinaryJudgmentAdmissionClosure` never reads verdicts,
  // Matrix, or Report at all.
  it("refuses a screened admission whose table and reveal receipt are signed by different keys (item 4b, RULING C-6)", () => {
    const context = setup();
    const packets = screenableItem(context, 0);
    const result = admitHumanTruth(context, {
      draftId: "review-run",
      truthAdmission: "screened-operator-sampled",
      candidates: [screenedCandidate(packets, 0, 1)],
      screening: screeningInput([screeningRow(packets.itemSha256, "CORRECT", "CORRECT", true, "confirm")]),
    });
    if (!result.ok) throw new Error(result.error.detail);
    const resolution = parseBinaryJudgmentLabelResolution(getSealedBytes(
      context.workspaceDir,
      result.result.resolutions[0]!.labelResolutionSha256.slice("sha256:".length),
    ));
    if (resolution.truthAdmission !== "screened-operator-sampled") throw new Error("wrong admission kind");

    // The original receipt: correctly signed under the workspace's single report-signing key.
    const originalReceiptBytes = getSealedBytes(
      context.workspaceDir,
      resolution.screeningRevealReceiptSha256.slice("sha256:".length),
    );
    const originalReceiptEnvelope = parseExactDsseEnvelope(originalReceiptBytes);
    const reportKey = loadOrCreateReportSigningKey(context.workspaceDir);
    expect(originalReceiptEnvelope.signatures[0]!.keyid).toBe(reportKey.keyId);

    // A SECOND, genuinely different key -- not the workspace's report-signing key -- signs the
    // exact same receipt payload bytes. The table stays untouched, still signed under the
    // original single key.
    const { privateKey: otherPrivateKey, publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
    const otherKeyId = didKeyFromEd25519PublicKey(otherPublicKey);
    expect(otherKeyId).not.toBe(reportKey.keyId);
    const otherSignedReceiptBytes = sealDsseEnvelope({
      payloadType: originalReceiptEnvelope.payloadType,
      payloadBytes: originalReceiptEnvelope.payloadBytes,
      signatures: [{
        keyid: otherKeyId,
        signature: new Uint8Array(edSign(null, Buffer.from(
          dssePreAuthEncoding(originalReceiptEnvelope.payloadType, originalReceiptEnvelope.payloadBytes),
        ), otherPrivateKey)),
      }],
    });

    const overrides = new Map<string, Uint8Array>();
    const tamperedReceiptSha256 = overlayRecord(overrides, otherSignedReceiptBytes);
    const tamperedManifestSha256 = rewriteSingleAcceptedResolution(
      context,
      result.result.admissionManifestSha256,
      overrides,
      (value) => ({ ...value, screeningRevealReceiptSha256: tamperedReceiptSha256 }),
    );

    expect(() => verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256: tamperedManifestSha256,
      expectedDraftId: "review-run",
    }, closurePortsWithOverrides(context, overrides))).toThrow(/authority signature/u);
  });
});

describe("replacement-ledger entry stratum (spec §3.1 site 9)", () => {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  function replacementLedgerEntry(stratum: string) {
    return {
      excludedItemSha256: digest("1"),
      replacementItemSha256: digest("2"),
      candidateClass: "factual",
      stratum,
      excludedPoolPosition: 1,
      replacementPoolPosition: 2,
      reason: "review-disagreement" as const,
      reviewVerdictSha256s: [digest("3"), digest("4")] as [string, string],
      visibilityReceiptSha256s: [digest("5"), digest("6")] as [string, string],
      reviewerRosterSha256: digest("7"),
      revealReceiptSha256: digest("8"),
    };
  }

  it("accepts a four-category stratum and refuses a non-grammar-conforming one", () => {
    expect(HumanReviewReplacementLedgerEntrySchema.safeParse(replacementLedgerEntry("category-3")).success).toBe(true);
    expect(HumanReviewReplacementLedgerEntrySchema.safeParse(replacementLedgerEntry("1bad")).success).toBe(false);
    expect(HumanReviewReplacementLedgerEntrySchema.safeParse(replacementLedgerEntry("")).success).toBe(false);
  });
});
