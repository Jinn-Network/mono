// SPDX-License-Identifier: Apache-2.0

import {
  BENCHMARKING_PROTOCOL_V2,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference,
  type SealedRecord,
  type TypedRecordReference,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest } from "@jinn-network/evidence-protocol";
import type {
  ExecutionEvidenceArtifactSource,
  ExecutionEvidenceBuilderInput,
} from "@jinn-network/execution-evidence-builder";
import { describe, expect, test } from "vitest";

import {
  NativeCaptureCoordinator,
  type FixedNativeInvocation,
  type NativeAdapterProbe,
  type NativeCaptureSession,
  type NativeCaptureStore,
  type NativeExecutionAdapter,
  type NativeLaunchResult,
  type NativeSnapshot,
  type NativeSnapshotPort,
  type SnapshotPolicy,
} from "./index.js";

const POLICY: SnapshotPolicy = {
  followSymlinks: false,
  allowHardlinks: false,
  allowSpecialFiles: false,
  maximumBytes: 1024 * 1024,
  maximumEntries: 100,
};

function hex(digit: string): string {
  return digit.repeat(64);
}

function descriptor(name: string, digit: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: hex(digit) } };
}

function source(digit: string, mediaType: string): ExecutionEvidenceArtifactSource {
  return { digest: `sha256:${hex(digit)}`, size: 4, mediaType };
}

const ORIGIN = {
  kind: "producer-observed",
  observer: "urn:agent:native-capture-test",
} as const;

function evidence(unit: "trial-1" | "trial-2"): ExecutionEvidenceBuilderInput {
  const second = unit === "trial-2";
  return {
    recording: {
      executionId: second
        ? "urn:uuid:22222222-2222-4222-8222-222222222222"
        : "urn:uuid:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-16T09:00:00.000Z",
      record: {
        name: unit,
        description: "One native Trial.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: {
        entityId: "task/memory.json",
        name: "Memory task",
        source: source("1", "application/json"),
        origin: ORIGIN,
      },
      initialInputs: [],
      executor: {
        entityId: "urn:agent:memory-system",
        kind: "software",
        name: "Memory system",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime/harbor.json",
        specification: source("2", "application/json"),
        name: "Harbor",
        softwareVersion: "0.21.0",
        origin: ORIGIN,
        components: [{
          kind: "controlled",
          artifact: {
            kind: "file",
            entityId: "runtime/harbor.bin",
            source: source("d", "application/octet-stream"),
            origin: ORIGIN,
          },
        }],
      },
      producer: {
        entityId: "urn:agent:native-capture-test",
        kind: "software",
        name: "Native capture test",
        origin: ORIGIN,
      },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: "2026-08-16T09:00:01.000Z",
    finalizedAt: "2026-08-16T09:00:02.000Z",
    results: [{
      kind: "file",
      entityId: `results/${unit}.txt`,
      source: source(second ? "6" : "3", "text/plain"),
      origin: ORIGIN,
    }],
    nativeTrace: {
      artifact: {
        kind: "file",
        entityId: `trace/${unit}.json`,
        source: source(second ? "7" : "4", "application/json"),
        origin: ORIGIN,
      },
      format: { entityId: "https://harborframework.com/formats/atif" },
    },
  };
}

class Store implements NativeCaptureStore {
  readonly events: string[] = [];
  readonly sessions = new Map<string, NativeCaptureSession>();
  readonly evidenceByKey = new Map<string, { digest: string; bytes: Uint8Array; reference: EvidenceRecordReference }>();
  readonly evidenceByDigest = new Map<string, Uint8Array>();
  readonly artifacts = new Map<string, Uint8Array>();

  loadSession(sessionId: string): NativeCaptureSession | undefined {
    return this.sessions.get(sessionId);
  }

  saveSession(session: NativeCaptureSession, expectedRevision: number | undefined): void {
    const current = this.sessions.get(session.sessionId);
    expect(current?.revision).toBe(expectedRevision);
    this.events.push(`save:${session.phase}`);
    this.sessions.set(session.sessionId, session);
  }

  putRecord(recordKind: string, name: string, record: SealedRecord): TypedRecordReference {
    this.events.push(`record:${recordKind.split("/").at(-2)}`);
    return { recordKind, record: { name, digest: { sha256: record.digest.slice(7) } } };
  }

  putExecution(idempotencyKey: string, bytes: Uint8Array): EvidenceRecordReference {
    const digest = recordDigest(bytes);
    const existing = this.evidenceByKey.get(idempotencyKey);
    if (existing !== undefined) {
      if (existing.digest !== digest) throw new Error("idempotency collision");
      return existing.reference;
    }
    const reference: EvidenceRecordReference = {
      family: "execution-evidence",
      record: { name: "ro-crate-metadata.json", digest: { sha256: digest.slice(7) } },
    };
    this.evidenceByKey.set(idempotencyKey, { digest, bytes, reference });
    this.evidenceByDigest.set(digest.slice(7), bytes);
    this.events.push("evidence:put");
    return reference;
  }

  putArtifact(sourceValue: ExecutionEvidenceArtifactSource, bytes: Uint8Array): void {
    this.artifacts.set(sourceValue.digest, bytes);
  }

  resolveEvidence(reference: EvidenceRecordReference): Uint8Array {
    const bytes = this.evidenceByDigest.get(reference.record.digest.sha256);
    if (bytes === undefined) throw new Error("missing execution evidence");
    return bytes;
  }
}

class Snapshots implements NativeSnapshotPort {
  readonly changed = new Set<string>();
  snapshot(sourceValue: { kind: string; locator: string }): NativeSnapshot {
    const digit = sourceValue.locator === "job.toml" ? "8" : "9";
    return {
      snapshotId: `${sourceValue.locator}-snapshot`,
      source: sourceValue,
      root: descriptor(sourceValue.locator, digit),
      capturedAt: "2026-08-16T09:00:00Z",
    };
  }
  assertUnchanged(snapshot: NativeSnapshot): void {
    if (this.changed.has(snapshot.snapshotId)) throw new Error("immutable snapshot changed");
  }
}

class Launcher {
  readonly events: string[];
  readonly starts = new Set<string>();
  constructor(events: string[]) { this.events = events; }
  ensureStarted(launchId: string, _invocation: FixedNativeInvocation): void {
    if (!this.starts.has(launchId)) {
      this.starts.add(launchId);
      this.events.push("launch:start");
    }
  }
  wait(_launchId: string): NativeLaunchResult {
    this.events.push("launch:wait");
    return {
      exitCode: 0,
      resultSource: { kind: "directory", locator: "archive" },
      limitations: [],
    };
  }
}

const PROBE: NativeAdapterProbe = {
  compatible: true,
  adapter: {
    id: "urn:jinn:native-adapter:harbor",
    version: "1.0.0",
    mappingVersion: "harbor-trial/1",
  },
  runtimeClosure: [descriptor("harbor", "d")],
  expectedScope: {
    unitKind: "harbor-trial",
    expectedUnitCount: 2,
    scope: descriptor("job-scope", "e"),
  },
  limitations: [],
};

const adapter: NativeExecutionAdapter = {
  probe: () => PROBE,
  prepareLaunch: () => ({
    executable: { path: "/opt/harbor", artifact: descriptor("harbor", "d") },
    argv: ["run", "--job", "job.toml"],
    environment: [{ name: "LANG", value: "C.UTF-8" }],
    workingDirectoryPolicy: "isolated-workspace",
    runtimeClosure: [descriptor("harbor", "d")],
  }),
  inventory: () => ({
    nativeGroup: { scheme: "urn:harbor:job-id", value: "job-1" },
    units: ["trial-2", "trial-1"].map((unitKey) => ({
      unitKey,
      identifiers: [{ scheme: "urn:harbor:trial-id", value: unitKey }],
    })),
    limitations: [],
  }),
  atomize: (_snapshot, unit) => ({
    unitKey: unit.unitKey,
    status: "captured",
    evidence: evidence(unit.unitKey as "trial-1" | "trial-2"),
    artifacts: [],
    projectedEvaluations: [],
    limitations: [],
  }),
};

function harness() {
  const store = new Store();
  const snapshots = new Snapshots();
  const launcher = new Launcher(store.events);
  const coordinator = new NativeCaptureCoordinator(
    { harbor: adapter },
    snapshots,
    launcher,
    store,
    { now: () => "2026-08-16T10:00:00Z" },
  );
  return { coordinator, store, snapshots, launcher };
}

describe("NativeCaptureCoordinator", () => {
  test("durably seals intent before one native launch and atomizes every unit", () => {
    const value = harness();
    const planned = value.coordinator.plan({
      sessionId: "golden",
      owner: "urn:agent:owner",
      adapterId: "harbor",
      source: { kind: "file", locator: "job.toml" },
      privacy: {
        policy: descriptor("privacy", "f"),
        publication: "transport-neutral",
        defaultAvailability: "digest-only",
        lowEntropyDigestPolicy: "explicit-review",
      },
      policy: POLICY,
    });
    expect(planned.phase).toBe("planned");
    const completed = value.coordinator.capture("golden");
    expect(completed.phase).toBe("complete");
    expect(value.store.events.indexOf("save:planned")).toBeLessThan(
      value.store.events.indexOf("launch:start"),
    );
    expect(value.store.events.indexOf("save:launching")).toBeLessThan(
      value.store.events.indexOf("launch:start"),
    );
    expect(value.launcher.starts.size).toBe(1);
    expect(value.store.evidenceByKey.size).toBe(2);
    const verification = value.coordinator.verify("golden");
    expect(verification).toMatchObject({ conforms: true, diagnostics: [] });
    expect(verification.capture?.units.map(({ unitKey }) => unitKey)).toEqual([
      "trial-1",
      "trial-2",
    ]);
    expect(JSON.stringify(verification.capture)).not.toMatch(/Submission|Attempt|Delivery/u);

    value.coordinator.resume("golden");
    expect(value.launcher.starts.size).toBe(1);
  });

  test("imports completed native material without invoking the launcher", () => {
    const value = harness();
    value.coordinator.import({
      sessionId: "historical",
      owner: "urn:agent:owner",
      adapterId: "harbor",
      source: { kind: "directory", locator: "archive" },
      policy: POLICY,
    });
    const verification = value.coordinator.verify("historical");
    expect(value.launcher.starts.size).toBe(0);
    expect(verification.capture?.intent).toBeUndefined();
    expect(verification.capture?.assurance).toMatchObject({
      origin: "historical-sparse-import",
      timing: "retrospective-artifacts-only",
    });
  });

  test("refuses source mutation before any process starts", () => {
    const value = harness();
    value.coordinator.plan({
      sessionId: "mutated",
      owner: "urn:agent:owner",
      adapterId: "harbor",
      source: { kind: "file", locator: "job.toml" },
      privacy: {
        policy: descriptor("privacy", "f"),
        publication: "local-only",
        defaultAvailability: "digest-only",
        lowEntropyDigestPolicy: "forbid",
      },
      policy: POLICY,
    });
    value.snapshots.changed.add("job.toml-snapshot");
    expect(() => value.coordinator.capture("mutated")).toThrow("immutable snapshot changed");
    expect(value.launcher.starts.size).toBe(0);
  });
});
