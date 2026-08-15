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
  task: "sha256:f25fd2b71ff04466ecee612928dccc09de15345f4aa1557f4eec6e7422f37a08",
  submission: "sha256:af448a258715f9bdc67850a498f14561d90fe1df965f3da4514ad23d5d723dd6",
  delivery: "sha256:f9619708602a95bf11f987fbee3652aacdff47f6679c909f9a41fe337209588f",
  "profile-document": "sha256:9bc41f97a68ab8f6c663106c049d71e8bbd8bc4651e35a6c855404a73e5503e7",
  "evaluation-spec": "sha256:5173d4c796f6d06ce47e2483fbf98d44133749881ec582308e225898a7c4b97e",
  plugin: "sha256:c35617178306f8321b25459a03b0dd0bd540ce95691dce3ef15af29fbc5f33b3",
  checkpoint: "sha256:44eda1daf7e0d69e470c4d494937b144a24a53ea1af29c945ae137c43a65a545",
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
