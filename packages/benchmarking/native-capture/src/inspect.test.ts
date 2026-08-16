// SPDX-License-Identifier: Apache-2.0

import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { buildExecutionEvidence } from "@jinn-network/execution-evidence-builder";
import { describe, expect, test } from "vitest";

import {
  createInspectNativeAdapter,
  type InspectOfficialProjection,
  type NativeSnapshot,
} from "./index.js";

const encoder = new TextEncoder();

function artifact(name: string, value: unknown, origin: "native-emitted" | "aggregate-extracted" = "native-emitted") {
  return {
    name,
    mediaType: "application/json",
    bytes: encoder.encode(JSON.stringify(value)),
    origin,
  } as const;
}

function projection(overrides: Partial<InspectOfficialProjection> = {}): InspectOfficialProjection {
  return {
    inspectVersion: "0.3.255",
    runId: "memory-eval",
    sourceFormat: "inspect-eval-log",
    limitations: [],
    samples: ["sample-1", "sample-2"].flatMap((sampleId) => [1, 2, 3].map((epoch) => ({
      evalId: "memory-eval",
      taskId: "memory-judge",
      sampleId,
      epoch,
      startedAt: `2026-08-16T09:00:0${epoch}Z`,
      endedAt: `2026-08-16T09:00:1${epoch}Z`,
      status: "success" as const,
      evaluator: {
        id: "urn:agent:instrument-a" as const,
        name: "Binary instrument A",
        version: "1.0.0",
      },
      task: artifact(`${sampleId}-${epoch}-task.json`, {
        originalTaskDigest: `sha256:${"a".repeat(64)}`,
        candidateResultDigest: `sha256:${"b".repeat(64)}`,
        instruction: "Judge the candidate without reference truth.",
      }),
      result: artifact(`${sampleId}-${epoch}-result.json`, { verdict: "ACCEPT" }),
      trace: artifact(`${sampleId}-${epoch}-trace.json`, { events: [] }),
      runtime: artifact(`${sampleId}-${epoch}-runtime.json`, { model: "judge-model" }),
      truthMaterialPresent: false,
      scores: [{ name: "accuracy", value: 1 }],
    }))),
    ...overrides,
  };
}

function setup(current: InspectOfficialProjection) {
  const executable = encoder.encode("inspect executable");
  const snapshot: NativeSnapshot = {
    snapshotId: "inspect-snapshot",
    source: { kind: "file", locator: "/sealed/eval.eval" },
    root: { name: "eval.eval", digest: { sha256: "9".repeat(64) } },
    capturedAt: "2026-08-16T10:00:00Z",
  };
  const adapter = createInspectNativeAdapter({ read: () => current }, {
    adapterVersion: "1.0.0",
    mappingVersion: "inspect-sample-epoch/1",
    executable: {
      path: "/opt/inspect",
      descriptor: {
        name: "inspect",
        digest: { sha256: recordDigest(executable).slice(7) },
        mediaType: "application/octet-stream",
      },
      bytes: executable,
    },
    producer: { id: "urn:agent:colophon", name: "Colophon", version: "1.0.0" },
  });
  return { adapter, snapshot };
}

describe("Inspect native adapter", () => {
  test("atomizes two samples by three epochs into six independent evaluator executions", () => {
    const { adapter, snapshot } = setup(projection());
    const inventory = adapter.inventory(snapshot);
    expect(inventory.units).toHaveLength(6);
    expect(new Set(inventory.units.map(({ unitKey }) => unitKey)).size).toBe(6);

    const atoms = inventory.units.map((unit) => adapter.atomize(snapshot, unit, {
      mode: "prospective",
      owner: "urn:agent:operator",
    }));
    expect(atoms.every(({ status }) => status === "captured")).toBe(true);
    for (const atom of atoms) {
      const built = buildExecutionEvidence(atom.evidence!);
      expect(validateExecutionEvidence(built)).toMatchObject({ conforms: true, diagnostics: [] });
      expect(atom.artifacts.map(({ source }) => source.name)).not.toContain("accuracy");
      expect(atom.evidence?.results).toHaveLength(1);
    }
  });

  test("refuses truth-bearing judge input and aggregate extraction in exact Evidence v1 roles", () => {
    const base = projection();
    const truthBearing = { ...base.samples[0]!, truthMaterialPresent: true };
    const aggregateOnly = {
      ...base.samples[1]!,
      task: { ...base.samples[1]!.task, origin: "aggregate-extracted" as const },
    };
    const current = { ...base, samples: [truthBearing, aggregateOnly] };
    const { adapter, snapshot } = setup(current);
    const inventory = adapter.inventory(snapshot);

    expect(adapter.atomize(snapshot, inventory.units[0]!, {
      mode: "retrospective",
      owner: "urn:agent:operator",
    })).toMatchObject({
      status: "excluded",
      limitations: [expect.stringContaining("truth/reference")],
    });
    expect(adapter.atomize(snapshot, inventory.units[1]!, {
      mode: "retrospective",
      owner: "urn:agent:operator",
    })).toMatchObject({
      status: "failed",
      limitations: [expect.stringContaining("aggregate-only")],
    });
  });
});
