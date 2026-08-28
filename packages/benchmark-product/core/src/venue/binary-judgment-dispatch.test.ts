// SPDX-License-Identifier: Apache-2.0

/**
 * Regression cover for the local venue's binary-judgment evaluator dispatch.
 *
 * A paid production canary imported its item bank with `parserInvalidPolicy: "abstain"`, which
 * seals every Task's EvaluationSpec against the v2 evaluation parser
 * (`network.jinn.parser.binary-judgment-evaluation@2.0.0`). Every solve delivered, and then every
 * cell terminaled `could-not-grade` with "local venue has no evaluator registration for parser
 * network.jinn.parser.binary-judgment-evaluation" — `prepareEvaluationCell` compared the sealed
 * parser key against the v1 identity alone, so the v2 spec fell through to the terminal refusal
 * even though the registration, its compatibility predicate, and the deployment parser allowlist
 * all admit both identities.
 *
 * Both sealed evaluation-parser identities must reach the binary-judgment evaluator. The v1
 * (reject-policy) case is the control: its dispatch must be unchanged.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINARY_ACCEPT_REJECT_PARSER_IDENTITY,
  BINARY_COMPLETE_JSON_LABEL_PARSER_V2_IDENTITY,
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  binaryJudgmentSemanticRequestDigest,
  parseEvaluationSpec,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealBinaryJudgmentObservation,
  sealEvaluationSpec,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentPayload,
  type DeterministicProcessBlock,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
  TASK_EXECUTION_PROTOCOL_URI,
} from "@jinn-network/task-execution-protocol";
import { buildBinaryJudgmentEvaluationSpecification } from "@jinn-network/task-execution-evaluator-adapters";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { initWorkspace } from "../operations/init.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { createLocalVenue, type LocalVenue } from "./venue.js";

const NOW = () => "2026-08-27T00:00:00.000Z";
const encoder = new TextEncoder();

const roots: string[] = [];
const venues: LocalVenue[] = [];

afterEach(async () => {
  for (const venue of venues.splice(0)) await venue.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// The 1.0 oracle is superseded (see task-execution/profiles/fixtures/manifest.sha256.json
// errata); profile-2 is the payload/instrument pair that still validates.
const oracle = JSON.parse(await readFile(new URL(
  "../../../../task-execution/profiles/fixtures/binary-judgment-request/golden/unicode-line-endings-profile-2.json",
  import.meta.url,
), "utf8")) as {
  input: { readonly payload: BinaryJudgmentPayload; readonly instrument: BinaryJudgmentInstrument };
};

function bare(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

/**
 * The whole binary-judgment cell for one parser-invalid policy: sealed material in the workspace
 * store, a subject Task binding that policy's EvaluationSpec, and a Delivery over real judge
 * outputs. The response parser is the one the policy's arms would really carry; the venue's
 * adapter selection reads only the EvaluationSpec's own parser identity.
 */
async function buildCell(parserInvalidPolicy: "reject" | "abstain") {
  const root = await mkdtemp(join(tmpdir(), "binary-judgment-dispatch-"));
  roots.push(root);
  const workspaceDir = join(root, "workspace");
  expect(initWorkspace({ workspaceDir, principal: "sponsor-1", clock: NOW }).ok).toBe(true);

  const instrumentDocument: BinaryJudgmentInstrument = {
    ...oracle.input.instrument,
    response: parserInvalidPolicy === "abstain"
      ? {
        mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
        parser: { ...BINARY_COMPLETE_JSON_LABEL_PARSER_V2_IDENTITY },
        invalidOutputDecision: "INVALID",
      }
      : {
        mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
        parser: { ...BINARY_ACCEPT_REJECT_PARSER_IDENTITY },
        invalidOutputDecision: "REJECT",
      },
  };
  const instrument = sealBinaryJudgmentInstrument(instrumentDocument);
  putSealedBytes(workspaceDir, instrument.bytes);

  const itemSha256 = recordDigest(canonicalJsonBytes(oracle.input.payload));
  const labelResolution = sealBinaryJudgmentLabelResolution({
    protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
    itemSha256,
    itemId: oracle.input.payload.itemId,
    humanReviewEvaluationSpecSha256: `sha256:${"5".repeat(64)}`,
    truthLabel: "CORRECT",
    candidateClass: "unicode_crlf",
    stratum: "stress",
    truthAdmission: "two-human-unanimous",
    reviewVerdictSha256s: [`sha256:${"6".repeat(64)}`, `sha256:${"7".repeat(64)}`],
    reviewerRosterSha256: `sha256:${"8".repeat(64)}`,
    visibilityReceiptSha256s: [`sha256:${"9".repeat(64)}`, `sha256:${"a".repeat(64)}`],
    revealReceiptSha256: `sha256:${"b".repeat(64)}`,
    resolvedAt: NOW(),
  });
  putSealedBytes(workspaceDir, labelResolution.bytes);
  const analysisContext = sealBinaryJudgmentAnalysisContext({
    protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
    itemSha256,
    itemId: oracle.input.payload.itemId,
    labelResolutionSha256: labelResolution.digest,
    truthLabel: "CORRECT",
    candidateClass: "unicode_crlf",
    stratum: "stress",
  });
  putSealedBytes(workspaceDir, analysisContext.bytes);

  const evaluationSpec = sealEvaluationSpec(
    buildBinaryJudgmentEvaluationSpecification(analysisContext.digest, parserInvalidPolicy),
  );
  putSealedBytes(workspaceDir, evaluationSpec.bytes);

  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: BINARY_JUDGMENT_PROFILE_URI,
      digest: { sha256: bare(BINARY_JUDGMENT_PROFILE_DIGEST) },
    },
    instructions: "Return exactly ACCEPT or REJECT.",
    payload: oracle.input.payload,
    outputs: [
      { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
      { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
      { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
    ],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: bare(evaluationSpec.digest) },
    },
    "network.jinn.binary-judgment.item-sha256": itemSha256,
  });
  const taskDigest = documentDigest(taskBytes);

  const responseBytes = encoder.encode(
    parserInvalidPolicy === "abstain" ? "{\"label\":\"CORRECT\"}" : "ACCEPT",
  );
  const observationBytes = sealBinaryJudgmentObservation({
    protocol: BINARY_JUDGMENT_OBSERVATION_FORMAT_URI,
    taskDigest,
    armId: "alpha",
    replicate: 1,
    instrumentSha256: instrument.digest,
    requestSha256: binaryJudgmentSemanticRequestDigest(oracle.input.payload, instrumentDocument),
    response: {
      digest: recordDigest(responseBytes),
      mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
    },
    provider: {
      requestedModel: oracle.input.instrument.model.requested,
      resolvedModel: oracle.input.instrument.model.requested,
      responseId: "synthetic-no-provider-1",
      eventSha256: `sha256:${"c".repeat(64)}`,
      usage: { inputTokens: 11, outputTokens: 1, totalTokens: 12 },
    },
    call: { count: 1, retries: 0, fallbacks: 0 },
    limitations: ["mutable-model-alias"],
  }).bytes;

  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: `urn:uuid:${randomUUID()}`,
    task: taskDigest,
    outputs: [
      {
        name: "judge-response",
        mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
        digest: { sha256: bare(recordDigest(responseBytes)) },
      },
      {
        name: "judge-observation",
        mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
        digest: { sha256: bare(recordDigest(observationBytes)) },
      },
    ],
    outcome: "fulfilled",
    createdAt: NOW(),
  });

  const venue = createLocalVenue({ workspaceDir, now: NOW });
  venues.push(venue);
  return {
    venue,
    evaluationSpec,
    cell: {
      subjectTaskBytes: taskBytes,
      subjectDeliveryBytes: deliveryBytes,
      resultArtifacts: [
        { name: "judge-response", bytes: responseBytes },
        { name: "judge-observation", bytes: observationBytes },
      ],
      evaluationSpecBytes: evaluationSpec.bytes,
    },
  };
}

describe("local venue binary-judgment evaluator dispatch", () => {
  for (const parserInvalidPolicy of ["reject", "abstain"] as const) {
    it(
      `dispatches the ${parserInvalidPolicy}-policy EvaluationSpec to the binary-judgment evaluator`,
      async () => {
        const { venue, evaluationSpec, cell } = await buildCell(parserInvalidPolicy);
        const familyBlock = parseEvaluationSpec(evaluationSpec.bytes)
          .familyBlock as DeterministicProcessBlock;
        expect(familyBlock.parser.id).toBe("network.jinn.parser.binary-judgment-evaluation");
        expect(familyBlock.parser.version).toBe(parserInvalidPolicy === "abstain" ? "2.0.0" : "1.0.0");

        // Before the fix the abstain (v2) spec refused here with "local venue has no evaluator
        // registration for parser network.jinn.parser.binary-judgment-evaluation".
        const prepared = await venue.prepareEvaluationCell(cell);
        expect(prepared.taskSha256).toMatch(/^[0-9a-f]{64}$/u);
      },
      30_000,
    );
  }
});
