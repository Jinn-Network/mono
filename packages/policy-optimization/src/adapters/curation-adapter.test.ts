// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { curateAnnouncements, type CurationObservation } from "./curation-adapter.js";
import type { AnnouncedVerdict } from "./types.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/adapters/${name}`, import.meta.url)), "utf8"));

describe("curateAnnouncements: the seven joins, golden path", () => {
  const records = read("curation-golden.json") as AnnouncedVerdict[];
  const { observations, refusals } = curateAnnouncements(records);

  it("produces one observation per announced verdict, none refused", () => {
    expect(refusals).toEqual([]);
    expect(observations).toHaveLength(3);
  });

  it("joins taskDigest from whichever single candidate is present (evaluation-task join)", () => {
    expect(observations[0]!.taskDigest).toBe(
      "sha256:1111111111111111111111111111111111111111111111111111111111111101",
    );
  });

  it("joins taskDigest from whichever single candidate is present (statement-subjects join)", () => {
    expect(observations[2]!.taskDigest).toBe(
      "sha256:1111111111111111111111111111111111111111111111111111111111111101",
    );
  });

  it("accepts agreeing two-candidate subject digest and attribution without refusing", () => {
    const observation = observations[1]!;
    expect(observation.taskDigest).toBe(
      "sha256:1111111111111111111111111111111111111111111111111111111111111102",
    );
    expect(observation.attribution).toBe("urn:jinn:agent:evaluator-b");
  });

  it("carries verdict, observedAt, attribution, and benchmarkRun straight through", () => {
    expect(observations.map((o) => o.verdict)).toEqual(["pass", "fail", "inconclusive"]);
    expect(observations[0]!.observedAt).toBe("2026-08-03T01:00:00Z");
    expect(observations[1]!.benchmarkRun).toBe(
      "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    );
    expect(observations[0]!.benchmarkRun).toBeUndefined();
  });

  it("assembles ref from provenance + record digest + attemptUri", () => {
    const ref = observations[0]!.ref;
    expect(ref).toEqual({
      source: { agent: "https://jinn.network/agents/projector", name: "base-marketplace" },
      entry: "sha256:3333333333333333333333333333333333333333333333333333333333333101",
      announcementId: "ann-c8-golden-101",
      record: "sha256:4444444444444444444444444444444444444444444444444444444444444101",
      attemptUri: "urn:uuid:0189d1c2-0000-7000-8000-000000008101",
    });
  });

  it("output observations are structurally a valid @jinn-network/task-curation CurationObservation[]", () => {
    // No import from packages/task-supply is allowed (source-boundary guard) -- this is a
    // structural/shape assertion, not a cross-package call.
    const shape: readonly CurationObservation[] = observations;
    expect(shape).toBe(observations);
  });
});

describe("curateAnnouncements: fail-closed conflict policy", () => {
  const records = read("curation-conflict.json") as AnnouncedVerdict[];
  const { observations, refusals } = curateAnnouncements(records);

  it("refuses three of the four records and admits the honest control record", () => {
    expect(refusals).toHaveLength(3);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.ref.announcementId).toBe("ann-c8-conflict-204");
  });

  it("refuses a conflicting subject-task-digest join with the disagreeing candidates named", () => {
    const refusal = refusals.find((r) => r.provenance.announcementId === "ann-c8-conflict-201")!;
    expect(refusal.reasons).toEqual([
      {
        kind: "conflicting-subject-task-digest",
        candidates: [
          "sha256:1111111111111111111111111111111111111111111111111111111111111201",
          "sha256:1111111111111111111111111111111111111111111111111111111111111202",
        ],
      },
    ]);
  });

  it("refuses with every failing reason at once, not just the first (missing verdict + missing attribution)", () => {
    const refusal = refusals.find((r) => r.provenance.announcementId === "ann-c8-conflict-202")!;
    expect(refusal.reasons).toEqual([{ kind: "missing-verdict" }, { kind: "missing-attribution" }]);
  });

  it("refuses a conflicting attribution join with the disagreeing candidates named", () => {
    const refusal = refusals.find((r) => r.provenance.announcementId === "ann-c8-conflict-203")!;
    expect(refusal.reasons).toEqual([
      {
        kind: "conflicting-attribution",
        candidates: ["urn:jinn:agent:evaluator-a", "urn:jinn:agent:evaluator-b"],
      },
    ]);
  });

  it("never silently drops a refused record -- every input record is accounted for", () => {
    expect(observations.length + refusals.length).toBe(records.length);
  });
});
