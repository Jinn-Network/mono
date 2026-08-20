// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../bytes.js";
import { compilePayloadValidator } from "../task-profile/payload-schema.js";
import { parseTaskProfile, sealTaskProfile } from "../task-profile/seal.js";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_PROFILE_URI,
} from "../identifiers.js";
import {
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_DIGEST_HEX,
  buildBinaryJudgmentProfile,
} from "./binary-judgment-2.0.js";

describe("binary-judgment/2.0 sealed profile", () => {
  it("pins a closed payload, one exact instrument requirement, and the three output slots", async () => {
    const profile = buildBinaryJudgmentProfile();
    const sealed = sealTaskProfile(profile);
    const bytes = await readFile(new URL(
      "../../profiles/task-profiles/binary-judgment/2.0/profile.json",
      import.meta.url,
    ));
    const digest = (await readFile(new URL(
      "../../profiles/task-profiles/binary-judgment/2.0/profile.sha256",
      import.meta.url,
    ), "utf8")).trim();

    expect(profile.profile).toBe(BINARY_JUDGMENT_PROFILE_URI);
    expect(profile.payloadSchema.additionalProperties).toBe(false);
    expect(profile.requirementKeys).toStrictEqual([{
      key: BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
      comparisonClass: "exact",
    }]);
    expect(profile.outputConventions.slots.map((slot) => [slot.name, slot.required]))
      .toStrictEqual([
        ["judge-response", true],
        ["judge-observation", true],
        ["inspect-log", false],
      ]);
    expect(new Uint8Array(bytes)).toEqual(sealed.bytes);
    expect(parseTaskProfile(new Uint8Array(bytes))).toStrictEqual(profile);
    expect(digest).toBe(sealed.digest);
    expect(BINARY_JUDGMENT_PROFILE_DIGEST).toBe(digest);
    expect(BINARY_JUDGMENT_PROFILE_DIGEST_HEX).toBe(digest.slice("sha256:".length));
  });

  it("rejects truth, class, stratum, reviewer, and open provenance fields at payload validation", () => {
    const profile = buildBinaryJudgmentProfile();
    const validate = compilePayloadValidator(
      profile.payloadSchema,
      canonicalJsonBytes(profile.payloadSchema),
    );
    const valid = {
      itemId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      question: "Question?",
      referenceAnswer: "Reference.",
      candidateAnswer: "Candidate.",
      provenance: {
        sourceCommitment: `sha256:${"a".repeat(64)}`,
        timestamp: "2026-03-09T00:00:00Z",
      },
      sources: [{
        digest: { sha256: "a".repeat(64) },
      }],
    };
    expect(validate(valid)).toStrictEqual({ ok: true });
    for (const leaked of [
      { ...valid, truthLabel: "CORRECT" },
      { ...valid, candidateClass: "temporal" },
      { ...valid, stratum: "core" },
      { ...valid, reviewerIds: ["one", "two"] },
      {
        ...valid,
        sources: [{ ...valid.sources[0], annotations: { truthLabel: "CORRECT" } }],
      },
      {
        ...valid,
        sources: [{
          ...valid.sources[0],
          uri: "https://example.test/stress/wrong",
        }],
      },
      { ...valid, itemId: "wrong-stress-17" },
    ]) {
      expect(validate(leaked).ok).toBe(false);
    }
  });

  it("accepts an optional evidence string and rejects a non-string evidence value", () => {
    const profile = buildBinaryJudgmentProfile();
    const validate = compilePayloadValidator(
      profile.payloadSchema,
      canonicalJsonBytes(profile.payloadSchema),
    );
    const valid = {
      itemId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      question: "Question?",
      referenceAnswer: "Reference.",
      candidateAnswer: "Candidate.",
      provenance: {
        sourceCommitment: `sha256:${"a".repeat(64)}`,
        timestamp: "2026-03-09T00:00:00Z",
      },
      sources: [{
        digest: { sha256: "a".repeat(64) },
      }],
    };
    expect(validate({
      ...valid,
      evidence: "Synthetic passage: the fixture's own words.",
    })).toStrictEqual({ ok: true });
    expect(validate({ ...valid, evidence: 42 }).ok).toBe(false);
  });

  it("rejects the superseded 1.0 array-shaped provenance and an extra key inside provenance", () => {
    const profile = buildBinaryJudgmentProfile();
    const validate = compilePayloadValidator(
      profile.payloadSchema,
      canonicalJsonBytes(profile.payloadSchema),
    );
    const valid = {
      itemId: "urn:uuid:22222222-2222-4222-8222-222222222222",
      question: "Question?",
      referenceAnswer: "Reference.",
      candidateAnswer: "Candidate.",
      provenance: {
        sourceCommitment: `sha256:${"a".repeat(64)}`,
        timestamp: "2026-03-09T00:00:00Z",
      },
      sources: [{
        digest: { sha256: "a".repeat(64) },
      }],
    };
    expect(validate({
      ...valid,
      provenance: [{ digest: { sha256: "a".repeat(64) } }],
    }).ok).toBe(false);
    expect(validate({
      ...valid,
      provenance: { ...valid.provenance, extra: "leak" },
    }).ok).toBe(false);
  });
});
