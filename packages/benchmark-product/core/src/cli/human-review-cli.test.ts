// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  binaryJudgmentPromptTemplateDigest,
  recordDigest,
  sealBinaryJudgmentInstrument,
} from "@jinn-network/task-execution-profiles";
import { runCli } from "./main.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function screeningMaterials() {
  const messages = [
    { role: "developer", segments: [{ literal: "Synthetic screening rubric. " }] },
    { role: "user", segments: [
      { field: "question" }, { field: "referenceAnswer" }, { field: "candidateAnswer" },
      { field: "evidence" },
    ] },
  ] as const;
  const descriptor = { uri: "https://fixtures.example.test/screening", digest: { sha256: "a".repeat(64) } };
  const instrument = sealBinaryJudgmentInstrument({
    protocol: BINARY_JUDGMENT_INSTRUMENT_FORMAT_URI,
    instrumentId: "screening-only",
    messages: messages as never,
    promptTemplateSha256: binaryJudgmentPromptTemplateDigest(messages as never),
    promptSource: descriptor,
    license: descriptor,
    attribution: descriptor,
    model: {
      adapter: "jinn-openai", requested: "gpt-5.6-luna",
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
  const script = new Uint8Array([0, 255, 1]);
  const raw = new Uint8Array([255, 0, 2]);
  return {
    screeningInstrumentSha256: instrument.digest,
    screeningInstrumentBase64: Buffer.from(instrument.bytes).toString("base64"),
    samplingScriptSha256: recordDigest(script),
    samplingScriptBase64: Buffer.from(script).toString("base64"),
    rawOutputsSha256: recordDigest(raw),
    rawOutputsBase64: Buffer.from(raw).toString("base64"),
  };
}

describe("human-review CLI", () => {
  it("uses file-backed packet, configured-signer, and admission operations without raw key flags", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-human-review-cli-"));
    roots.push(workspaceDir);
    const context = { cwd: workspaceDir, clock: () => "2026-08-15T09:00:00.000Z" };
    expect((await runCli(["init", "--workspace", workspaceDir, "--principal", "operator", "--json"], context)).exitCode).toBe(0);
    expect((await runCli([
      "draft", "create", "--workspace", workspaceDir, "--principal", "operator",
      "--id", "review-run", "--name", "Review run", "--json",
    ], context)).exitCode).toBe(0);

    const packetFile = join(workspaceDir, "packet-request.json");
    writeFileSync(packetFile, JSON.stringify({
      item: {
        itemId: "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
        question: "Question?",
        referenceAnswer: "Reference",
        candidateAnswer: "Candidate",
        provenance: { sourceCommitment: `sha256:${"1".repeat(64)}`, timestamp: "2026-01-01T00:00:00Z" },
        sources: [{ digest: { sha256: "1".repeat(64) } }],
      },
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    }));
    const packets = await runCli([
      "human-review", "packet", "create", "--workspace", workspaceDir, "--principal", "operator",
      "--draft", "review-run", "--file", packetFile, "--json",
    ], context);
    expect(packets.exitCode).toBe(0);
    const packetResult = JSON.parse(packets.stdout).result as {
      itemSha256: string;
      humanReviewEvaluationSpecSha256: string;
      packets: Array<{ reviewerId: string; packetSha256: string; visibilityReceiptSha256: string }>;
    };

    const signerFile = join(workspaceDir, "signer.json");
    writeFileSync(signerFile, JSON.stringify({
      configuredEvaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
      activeEvaluatorId: packetResult.packets[0]!.reviewerId,
    }));
    const responseFile = join(workspaceDir, "response.json");
    writeFileSync(responseFile, JSON.stringify({
      packetSha256: packetResult.packets[0]!.packetSha256,
      visibilityReceiptSha256: packetResult.packets[0]!.visibilityReceiptSha256,
      label: "CORRECT",
      complete: true,
      completedAt: "2026-08-15T09:01:00.000Z",
    }));
    const signed = await runCli([
      "human-review", "response", "sign", "--workspace", workspaceDir, "--principal", "operator",
      "--draft", "review-run", "--file", responseFile, "--signer", signerFile, "--json",
    ], context);
    expect(signed.exitCode).toBe(0);
    expect(JSON.parse(signed.stdout).result.verdictSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const admissionFile = join(workspaceDir, "admission.json");
    writeFileSync(admissionFile, JSON.stringify({
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256: packetResult.itemSha256,
        itemId: "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
        humanReviewEvaluationSpecSha256: packetResult.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT",
      }],
    }));
    const admitted = await runCli([
      "human-review", "admit", "--workspace", workspaceDir, "--principal", "operator",
      "--draft", "review-run", "--file", admissionFile, "--json",
    ], context);
    expect(admitted.exitCode).toBe(0);
    expect(JSON.parse(admitted.stdout).result).toMatchObject({ publicationGrade: false });
    expect(signed.stdout).not.toContain("PRIVATE KEY");
  });

  // H-6 (packet P6): the CLI's `human-review admit` handler forwards `AdmitHumanTruthInput` by an
  // explicit field-by-field spread, so a new top-level field (here, the bank-scoped `screening`
  // table content) must be named explicitly or it is silently dropped on the CLI path while the
  // library path (`admitHumanTruth` called directly, as in operations/human-review.test.ts) works.
  it("forwards bank-scoped screening table content from the admission file (H-6)", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-human-review-cli-screened-"));
    roots.push(workspaceDir);
    const context = { cwd: workspaceDir, clock: () => "2026-08-15T09:00:00.000Z" };
    expect((await runCli(["init", "--workspace", workspaceDir, "--principal", "operator", "--json"], context)).exitCode).toBe(0);
    expect((await runCli([
      "draft", "create", "--workspace", workspaceDir, "--principal", "operator",
      "--id", "review-run", "--name", "Review run", "--json",
    ], context)).exitCode).toBe(0);

    const packetFile = join(workspaceDir, "packet-request.json");
    writeFileSync(packetFile, JSON.stringify({
      item: {
        itemId: "urn:uuid:123e4567-e89b-12d3-a456-426614174001",
        question: "Question?",
        referenceAnswer: "Reference",
        candidateAnswer: "Candidate",
        provenance: { sourceCommitment: `sha256:${"2".repeat(64)}`, timestamp: "2026-01-01T00:00:00Z" },
        sources: [{ digest: { sha256: "2".repeat(64) } }],
      },
      evaluatorIds: ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"],
    }));
    const packets = await runCli([
      "human-review", "packet", "create", "--workspace", workspaceDir, "--principal", "operator",
      "--draft", "review-run", "--file", packetFile, "--json",
    ], context);
    expect(packets.exitCode).toBe(0);
    const packetResult = JSON.parse(packets.stdout).result as {
      itemSha256: string;
      humanReviewEvaluationSpecSha256: string;
    };

    const admissionFile = join(workspaceDir, "screened-admission.json");
    writeFileSync(admissionFile, JSON.stringify({
      truthAdmission: "screened-operator-sampled",
      candidates: [{
        itemSha256: packetResult.itemSha256,
        itemId: "urn:uuid:123e4567-e89b-12d3-a456-426614174001",
        humanReviewEvaluationSpecSha256: packetResult.humanReviewEvaluationSpecSha256,
        candidateClass: "factual",
        stratum: "core",
        poolPosition: 1,
      }],
      screening: {
        ...screeningMaterials(),
        sampleSeed: "synthetic-cli-seed",
        sampleSize: 1,
        rows: [{
          itemSha256: packetResult.itemSha256,
          intendedLabel: "CORRECT",
          screeningVerdict: "CORRECT",
          handChecked: true,
          handVerdict: "confirm",
        }],
      },
    }));
    const admitted = await runCli([
      "human-review", "admit", "--workspace", workspaceDir, "--principal", "operator",
      "--draft", "review-run", "--file", admissionFile, "--json",
    ], context);
    // If `screening` were dropped by the CLI handler (H-6's trap), this would refuse with
    // "screened-operator-sampled admission requires bank-scoped screening table content"
    // (code "validation") instead of succeeding.
    expect(admitted.exitCode).toBe(0);
    expect(JSON.parse(admitted.stdout).result).toMatchObject({ publicationGrade: true, exclusions: [] });
  });
});
