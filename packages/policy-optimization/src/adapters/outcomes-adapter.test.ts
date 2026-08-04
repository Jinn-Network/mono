// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveExecutionTuple, tupleDigest } from "@jinn-network/policy-identity";
import { describe, expect, it } from "vitest";
import { deriveOutcomeObservations, type AnnouncedPolicyVerdict } from "./outcomes-adapter.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/adapters/${name}`, import.meta.url)), "utf8"));

describe("deriveOutcomeObservations: joins plus tuple derivation plus per-axis fidelity", () => {
  const records = read("outcomes-golden.json") as AnnouncedPolicyVerdict[];
  const { observations, refusals, divergentRecordDigestGroups } = deriveOutcomeObservations(records);

  it("produces one observation per record, none refused or flagged", () => {
    expect(refusals).toEqual([]);
    expect(divergentRecordDigestGroups).toEqual([]);
    expect(observations).toHaveLength(2);
  });

  it("derives the SAME tuple deriveExecutionTuple would from the same (task, submission, profile)", () => {
    const [armA] = records;
    const expected = deriveExecutionTuple(armA!.task, armA!.submission, armA!.profile);
    const observation = observations.find((o) => o.ref.announcementId === "ann-c8-outcomes-301")!;
    expect(observation.tuple).toEqual(expected);
    expect(tupleDigest(observation.tuple)).toBe(tupleDigest(expected));
  });

  it("two different loadout arms derive two different tuples", () => {
    const [a, b] = observations;
    expect(tupleDigest(a!.tuple)).not.toBe(tupleDigest(b!.tuple));
  });

  it("fully-specified fidelity evidence rides straight through", () => {
    const observation = observations.find((o) => o.ref.announcementId === "ann-c8-outcomes-301")!;
    expect(observation.perAxisStatus).toEqual({
      harness: "match",
      model: "match",
      loadout: "match",
      isolationPolicy: "match",
    });
  });

  it("an axis with no supplied fidelity evidence defaults to the honest unverifiable, never upgraded", () => {
    const observation = observations.find((o) => o.ref.announcementId === "ann-c8-outcomes-302")!;
    expect(observation.perAxisStatus).toEqual({
      harness: "match",
      model: "unverifiable",
      loadout: "mismatch",
      isolationPolicy: "unverifiable",
    });
  });

  it("carries the shared joins through exactly as the curation adapter does", () => {
    const observation = observations.find((o) => o.ref.announcementId === "ann-c8-outcomes-302")!;
    expect(observation.taskDigest).toBe(
      "sha256:1111111111111111111111111111111111111111111111111111111111111302",
    );
    expect(observation.verdict).toBe("fail");
    expect(observation.attribution).toBe("urn:jinn:agent:bench-harness");
    expect(observation.benchmarkRun).toBe(
      "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    );
  });
});

describe("deriveOutcomeObservations: fail-closed joins and tuple-derivation refusal", () => {
  it("a bad profile pin refuses with a typed tuple-derivation-refused reason, not an uncaught throw", () => {
    const [good] = read("outcomes-golden.json") as AnnouncedPolicyVerdict[];
    const broken: AnnouncedPolicyVerdict = {
      ...good!,
      task: {
        ...good!.task,
        profile: { uri: good!.task.profile.uri, digest: { sha256: "0".repeat(64) } },
      },
    };
    const { observations, refusals } = deriveOutcomeObservations([broken]);
    expect(observations).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reasons).toHaveLength(1);
    expect(refusals[0]!.reasons[0]!.kind).toBe("tuple-derivation-refused");
  });

  it("a missing verdict/attribution join refuses before tuple derivation is even attempted", () => {
    const [good] = read("outcomes-golden.json") as AnnouncedPolicyVerdict[];
    const noVerdict: AnnouncedPolicyVerdict = {
      ...good!,
      statementVerdict: undefined,
      attributionFromChainEvent: undefined,
    };
    const { observations, refusals } = deriveOutcomeObservations([noVerdict]);
    expect(observations).toEqual([]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reasons).toEqual([{ kind: "missing-verdict" }, { kind: "missing-attribution" }]);
  });
});

describe("deriveOutcomeObservations: dedupe by underlying verdict record digest (substrate §6.3, F-C2-2)", () => {
  it("same record digest via two sources collapses to ONE observation, not two", () => {
    const records = read("outcomes-reannouncement.json") as AnnouncedPolicyVerdict[];
    const { observations, refusals, divergentRecordDigestGroups } = deriveOutcomeObservations(records);
    expect(refusals).toEqual([]);
    expect(divergentRecordDigestGroups).toEqual([]);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.ref.record).toBe(
      "sha256:4444444444444444444444444444444444444444444444444444444444444401",
    );
  });

  it("the collapsed observation's ref is chosen deterministically regardless of input order", () => {
    const records = read("outcomes-reannouncement.json") as AnnouncedPolicyVerdict[];
    const forward = deriveOutcomeObservations(records).observations[0]!.ref;
    const reversed = deriveOutcomeObservations([...records].reverse()).observations[0]!.ref;
    expect(reversed).toEqual(forward);
  });

  it("different record digests for what claims to be the same verdict: BOTH kept, and flagged", () => {
    const records = read("outcomes-divergent-digest.json") as AnnouncedPolicyVerdict[];
    const { observations, refusals, divergentRecordDigestGroups } = deriveOutcomeObservations(records);
    expect(refusals).toEqual([]);
    expect(observations).toHaveLength(2); // neither is dropped -- the adapter cannot know which is honest
    expect(divergentRecordDigestGroups).toHaveLength(1);
    const [group] = divergentRecordDigestGroups;
    expect(group!.attemptUri).toBe("urn:uuid:0189d1c2-0000-7000-8000-000000008501");
    expect(group!.attribution).toBe("urn:jinn:agent:evaluator-a");
    expect([...group!.digests].sort()).toEqual([
      "sha256:4444444444444444444444444444444444444444444444444444444444444501",
      "sha256:4444444444444444444444444444444444444444444444444444444444444502",
    ]);
    expect(group!.refs).toHaveLength(2);
  });
});
