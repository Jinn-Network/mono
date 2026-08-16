// SPDX-License-Identifier: Apache-2.0

import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { buildExecutionEvidence } from "@jinn-network/execution-evidence-builder";
import { describe, expect, test } from "vitest";

import {
  createHarborNativeAdapter,
  type NativeSnapshot,
  type NativeSnapshotReader,
} from "./index.js";

const encoder = new TextEncoder();

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

class Reader implements NativeSnapshotReader {
  constructor(readonly files: ReadonlyMap<string, Uint8Array>) {}
  list() {
    return [...this.files].map(([path, bytes]) => ({
      path,
      kind: "file" as const,
      size: bytes.byteLength,
    }));
  }
  read(_snapshot: NativeSnapshot, path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`missing ${path}`);
    return bytes;
  }
}

describe("Harbor native adapter", () => {
  test("treats Job as a group and every Trial/retry as one independently accounted unit", () => {
    const executable = encoder.encode("harbor executable");
    const files = new Map<string, Uint8Array>([
      ["config.json", json({ job_name: "memory-job", agents: [{ name: "memory-agent" }] })],
      ["result.json", json({ id: "job-1", status: "success", n_total_trials: 2 })],
      ["trial-1/config.json", json({ task: { id: "memory-1" }, agent: { name: "memory-agent" }, attempt_number: 1 })],
      ["trial-1/result.json", json({
        id: "trial-1", status: "success",
        started_at: "2026-08-16T09:00:00Z",
        ended_at: "2026-08-16T09:00:01Z",
      })],
      ["trial-1/task.json", json({ question: "Where was the key stored?", context: ["drawer"] })],
      ["trial-1/artifacts/prediction.json", json({ answer: "drawer" })],
      ["trial-1/agent/trajectory.json", json({ schema: "ATIF", steps: [] })],
      ["trial-2/config.json", json({
        task: { id: "memory-1" }, agent: { name: "memory-agent" },
        attempt_number: 2, source_trial: "trial-1",
      })],
      ["trial-2/result.json", json({ id: "trial-2", status: "failed" })],
      ["trial-2/agent/trajectory.json", json({ schema: "ATIF", steps: [] })],
    ]);
    const snapshot: NativeSnapshot = {
      snapshotId: "archive-1",
      source: { kind: "directory", locator: "/sealed/archive" },
      root: {
        name: "harbor-job-tree",
        digest: { sha256: "9".repeat(64) },
      },
      capturedAt: "2026-08-16T10:00:00Z",
    };
    const adapter = createHarborNativeAdapter(new Reader(files), {
      adapterVersion: "1.0.0",
      mappingVersion: "harbor-trial/1",
      harborVersion: "0.21.0",
      executable: {
        path: "/opt/harbor",
        descriptor: {
          name: "harbor",
          digest: { sha256: recordDigest(executable).slice(7) },
          mediaType: "application/octet-stream",
        },
        bytes: executable,
      },
      producer: {
        id: "urn:agent:colophon",
        name: "Colophon",
        version: "1.0.0",
      },
    });

    expect(adapter.probe(snapshot)).toMatchObject({ compatible: true });
    const inventory = adapter.inventory(snapshot);
    expect(inventory.units.map(({ unitKey }) => unitKey)).toEqual(["trial-1", "trial-2"]);
    expect(inventory.units[1]?.identifiers).toEqual(expect.arrayContaining([
      { scheme: "urn:harbor:attempt-number", value: "2" },
      { scheme: "urn:harbor:source-trial-id", value: "trial-1" },
    ]));

    const first = adapter.atomize(snapshot, inventory.units[0]!, {
      mode: "retrospective",
      owner: "urn:agent:owner",
    });
    expect(first).toMatchObject({ status: "captured", unitKey: "trial-1" });
    expect(first.evidence).toBeDefined();
    expect(validateExecutionEvidence(buildExecutionEvidence(first.evidence!))).toMatchObject({
      conforms: true,
      diagnostics: [],
    });
    expect(first.artifacts.map(({ source }) => source.name)).toEqual(expect.arrayContaining([
      "trial-1/task.json",
      "trial-1/artifacts/prediction.json",
      "trial-1/agent/trajectory.json",
    ]));

    const retry = adapter.atomize(snapshot, inventory.units[1]!, {
      mode: "retrospective",
      owner: "urn:agent:owner",
    });
    expect(retry).toMatchObject({
      status: "failed",
      limitations: [expect.stringContaining("no Execution Evidence was fabricated")],
    });
  });

  test("rejects traversal-shaped archive entries before parsing", () => {
    const reader = new Reader(new Map([
      ["config.json", json({})],
      ["result.json", json({})],
      ["../trial/config.json", json({})],
    ]));
    const executable = encoder.encode("harbor");
    const adapter = createHarborNativeAdapter(reader, {
      adapterVersion: "1.0.0",
      mappingVersion: "harbor-trial/1",
      harborVersion: "0.21.0",
      executable: {
        path: "/opt/harbor",
        descriptor: { name: "harbor", digest: { sha256: recordDigest(executable).slice(7) } },
        bytes: executable,
      },
      producer: { id: "urn:agent:colophon", name: "Colophon", version: "1.0.0" },
    });
    const snapshot: NativeSnapshot = {
      snapshotId: "unsafe",
      source: { kind: "directory", locator: "/unsafe" },
      root: { name: "unsafe", digest: { sha256: "f".repeat(64) } },
      capturedAt: "2026-08-16T10:00:00Z",
    };
    expect(() => adapter.probe(snapshot)).toThrow(/UNSAFE_ARCHIVE_PATH/u);
  });
});
