import { RECORD_KINDS, cloudEventsFields, referenceBearingFields, sealJson } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  checkpointProfile,
  deliveryProfile,
  evaluationSpecProfile,
  pluginProfile,
  profileDocumentProfile,
  submissionProfile,
  taskProfile,
} from "./profiles.js";

// Pinned-digest golden documents (plan Task 24 Step 3, mirroring
// protocol/src/fixtures.test.ts's pinned-digest convention): each facts
// profile is a sealed, digest-pinned document. Update these only when a
// field or key ordering changes deliberately.
const EXPECTED_DIGESTS: Record<string, string> = {
  task: "sha256:8ff3c73468baacd5de80855bcb2407f231f9d001ac1c321f461313b7fc660ed3",
  submission: "sha256:8ed303ec5e2de98a106e4fc650b6586e729259214859b64b89312600fd978517",
  delivery: "sha256:26f86278e2683db503b9afcbe7ba991c88eb55186e9649bbdc2dd331252c3ca8",
  "profile-document": "sha256:f14c323b57fcff68866ff4386be8edc8f252a3192edb2dcd913e025506fbd391",
  "evaluation-spec": "sha256:bd24399e0b509f2857bb0b10e171095df82321dc5e8d407024ae30052b67744f",
  plugin: "sha256:49a32e7e6e514264e2ff4f63c6dca4e2c8339c7f06468b1d744141580c9d1d3b",
  checkpoint: "sha256:706b642cecb5b4f8358c7ef4bfb4bdf1a69c1d5dc6472992dca04e078d80e634",
};

function expectPinnedDigest(name: string, digest: string) {
  const expected = EXPECTED_DIGESTS[name];
  if (expected === undefined || expected === "sha256:PENDING") {
    throw new Error(
      `No pinned digest for "${name}" yet -- actual digest: ${digest}\n`
        + "Paste this into EXPECTED_DIGESTS and re-run.",
    );
  }
  expect(digest).toBe(expected);
}

describe("facts/task-execution profile documents", () => {
  it("task profile names the task kind and labels every field record-class", () => {
    expect(taskProfile.kind).toBe(RECORD_KINDS.task);
    expect(taskProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(taskProfile)).toEqual(["profileDigest", "evaluationDigest", "supersedesDigest"]);
    expect(cloudEventsFields(taskProfile).map((field) => field.name)).toEqual(["profileUri"]);
    expectPinnedDigest("task", sealJson(taskProfile).digest);
  });

  it("submission profile carries the operator-filter card plus one substrate field and the benchmarking triple", () => {
    expect(submissionProfile.kind).toBe(RECORD_KINDS.submission);
    expect(referenceBearingFields(submissionProfile)).toEqual(["taskDigest"]);
    const substrateFields = submissionProfile.fields.filter((field) => field.class === "substrate");
    expect(substrateFields.map((field) => field.name)).toEqual(["terms"]);
    expect(cloudEventsFields(submissionProfile).map((field) => field.name)).toEqual([
      "taskProfileUri", "requesterIri", "benchrun", "benchcell", "bencharm",
    ]);
    expectPinnedDigest("submission", sealJson(submissionProfile).digest);
  });

  it("delivery profile carries Task digest, Attempt URI, outcome, and the benchmarking triple", () => {
    expect(deliveryProfile.kind).toBe(RECORD_KINDS.delivery);
    expect(referenceBearingFields(deliveryProfile)).toEqual(["taskDigest"]);
    expect(deliveryProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(cloudEventsFields(deliveryProfile).map((field) => field.name)).toEqual([
      "outcome", "benchrun", "benchcell", "bencharm",
    ]);
    expectPinnedDigest("delivery", sealJson(deliveryProfile).digest);
  });

  it("profile-document profile names the profile-document kind", () => {
    expect(profileDocumentProfile.kind).toBe(RECORD_KINDS.profileDocument);
    expect(profileDocumentProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(referenceBearingFields(profileDocumentProfile)).toEqual(["extendsDigest"]);
    expectPinnedDigest("profile-document", sealJson(profileDocumentProfile).digest);
  });

  it("evaluation-spec profile names the evaluation-spec kind", () => {
    expect(evaluationSpecProfile.kind).toBe(RECORD_KINDS.evaluationSpec);
    expect(evaluationSpecProfile.fields.every((field) => field.class === "record")).toBe(true);
    expect(cloudEventsFields(evaluationSpecProfile).map((field) => field.name)).toEqual(["family"]);
    expectPinnedDigest("evaluation-spec", sealJson(evaluationSpecProfile).digest);
  });

  it("plugin and checkpoint profiles register their kinds with zero fields (documented gap, no fabricated schema)", () => {
    expect(pluginProfile.kind).toBe(RECORD_KINDS.plugin);
    expect(pluginProfile.fields).toEqual([]);
    expectPinnedDigest("plugin", sealJson(pluginProfile).digest);

    expect(checkpointProfile.kind).toBe(RECORD_KINDS.checkpoint);
    expect(checkpointProfile.fields).toEqual([]);
    expectPinnedDigest("checkpoint", sealJson(checkpointProfile).digest);
  });

  it("no task-execution facts profile carries a substrate field except Submission's terms (§5.4)", () => {
    for (const profile of [taskProfile, deliveryProfile, profileDocumentProfile, evaluationSpecProfile, pluginProfile, checkpointProfile]) {
      expect(profile.fields.some((field) => field.class === "substrate")).toBe(false);
    }
  });

  it("seals to a stable digest independent of source key order (JCS)", () => {
    const sealed = sealJson(taskProfile);
    const shuffled = sealJson({
      protocol: taskProfile.protocol,
      fields: taskProfile.fields,
      kind: taskProfile.kind,
      profile: taskProfile.profile,
    });
    expect(shuffled.digest).toBe(sealed.digest);
    expect(sealed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
