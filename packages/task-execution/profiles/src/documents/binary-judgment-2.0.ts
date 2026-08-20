// SPDX-License-Identifier: Apache-2.0

import {
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  TASK_PROFILE_FORMAT_URI,
} from "../identifiers.js";
import { sealTaskProfile } from "../task-profile/seal.js";
import type { TaskProfileDocument } from "../task-profile/schema.js";
import { BINARY_JUDGMENT_TIMESTAMP_PATTERN } from "../binary-judgment/contracts.js";

/**
 * Backend-neutral judge work over one closed question/reference/candidate payload, plus an
 * optional evidence passage and a records-admitted `provenance` commitment (source-manifest
 * digest + publication timestamp). Analysis truth, class, stratum, reviewer evidence, and other
 * arms are deliberately absent from this profile.
 */
export function buildBinaryJudgmentProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: BINARY_JUDGMENT_PROFILE_URI,
    description:
      "One binary judgment over a question, reference answer, and candidate answer, with an "
      + "exact sealed judge instrument and evaluator-only admitted truth.",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        itemId: {
          type: "string",
          pattern: "^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
        question: { type: "string" },
        referenceAnswer: { type: "string" },
        candidateAnswer: { type: "string" },
        evidence: { type: "string" },
        provenance: {
          type: "object",
          additionalProperties: false,
          properties: {
            sourceCommitment: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            timestamp: { type: "string", pattern: BINARY_JUDGMENT_TIMESTAMP_PATTERN },
          },
          required: ["sourceCommitment", "timestamp"],
        },
        sources: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              digest: {
                type: "object",
                additionalProperties: false,
                properties: { sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
                required: ["sha256"],
              },
            },
            required: ["digest"],
          },
        },
      },
      required: ["itemId", "question", "referenceAnswer", "candidateAnswer", "provenance", "sources"],
    },
    inputConventions: { slots: [] },
    outputConventions: {
      slots: [
        {
          name: "judge-response",
          required: true,
          mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
        },
        {
          name: "judge-observation",
          required: true,
          mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
        },
        {
          name: "inspect-log",
          required: false,
          mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
        },
      ],
    },
    evaluationFamilies: ["deterministic-process"],
    requirementKeys: [{
      key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
      comparisonClass: "exact",
    }],
  };
}

export const BINARY_JUDGMENT_PROFILE_DIGEST: `sha256:${string}` =
  sealTaskProfile(buildBinaryJudgmentProfile()).digest;

export const BINARY_JUDGMENT_PROFILE_DIGEST_HEX =
  BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length);
