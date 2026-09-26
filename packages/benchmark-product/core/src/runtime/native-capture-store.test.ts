// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentDigest, type SealedRecord } from "@jinn-network/benchmarking-protocol";
import type { NativeCaptureSession } from "@jinn-network/benchmarking-native-capture";
import { describe, expect, test } from "vitest";
import { createWorkspaceNativeCaptureStore } from "./native-capture-store.js";
import { evidenceSessionRecordsDir } from "../workspace/layout.js";

const encoder = new TextEncoder();
const SESSION = "session-1";
const CAPTURE_RECORD_KIND = "https://spec.jinn.network/records/execution-batch-capture/v2";

function store(): {
  readonly workspaceDir: string;
  readonly store: ReturnType<typeof createWorkspaceNativeCaptureStore>;
} {
  const workspaceDir = mkdtempSync(join(tmpdir(), "native-capture-store-"));
  return { workspaceDir, store: createWorkspaceNativeCaptureStore({ workspaceDir, sessionId: SESSION }) };
}

function sealed(value: unknown): SealedRecord {
  const bytes = encoder.encode(JSON.stringify(value));
  return { bytes, digest: documentDigest(bytes) };
}

function ingesting(revision: number): NativeCaptureSession {
  return {
    sessionId: SESSION,
    revision,
    phase: "ingesting",
    mode: "retrospective",
    owner: "urn:agent:owner",
    adapterId: "harbor",
    resultSnapshot: {
      snapshotId: "snap-1",
      source: { kind: "filesystem", locator: "/jobs" },
      root: { name: "/jobs", digest: { sha256: "9".repeat(64) } },
      capturedAt: "2026-08-16T10:00:00.000Z",
    },
    policy: {
      followSymlinks: false,
      allowHardlinks: false,
      allowSpecialFiles: false,
      maximumBytes: 1024,
      maximumEntries: 16,
    },
    launchLimitations: [],
  };
}

describe("workspace native capture store", () => {
  test("round-trips a sealed record and re-verifies its digest on the way out", () => {
    const { store: subject } = store();
    const record = sealed({ units: 1 });
    const reference = subject.putRecord(CAPTURE_RECORD_KIND, "capture.json", record);
    expect(reference.record.digest.sha256).toBe(record.digest.slice(7));
    expect(subject.resolveEvidence({ family: "execution-evidence", record: reference.record }))
      .toEqual(record.bytes);
  });

  test("refuses a record whose stored bytes were altered underneath it", () => {
    const { workspaceDir, store: subject } = store();
    const reference = subject.putExecution("adapter-unit-1", encoder.encode("original"));
    const path = join(evidenceSessionRecordsDir(workspaceDir, SESSION), `${reference.record.digest.sha256}.bin`);
    writeFileSync(path, encoder.encode("tampered"));
    expect(() => subject.resolveEvidence(reference)).toThrow(/reads back as/u);
  });

  test("honors the execution idempotency key and refuses to rebind it to other bytes", () => {
    const { store: subject } = store();
    const key = "harbor/1.0.0/harbor-trial-1/root/trial-1";
    const first = subject.putExecution(key, encoder.encode("evidence-a"));
    expect(subject.putExecution(key, encoder.encode("evidence-a"))).toEqual(first);
    expect(() => subject.putExecution(key, encoder.encode("evidence-b")))
      .toThrow(/an idempotency key cannot be reused/u);
  });

  test("applies the coordinator's revision compare-and-set instead of overwriting", () => {
    const { workspaceDir, store: subject } = store();
    subject.saveSession(ingesting(0), undefined);
    expect(subject.loadSession(SESSION)).toMatchObject({ revision: 0, phase: "ingesting" });

    // A second first-write is a second capture racing the first, not an overwrite.
    expect(() => subject.saveSession(ingesting(0), undefined))
      .toThrow(/already holds a native capture session/u);
    expect(() => subject.saveSession(ingesting(7), 6)).toThrow(/is at revision 0, not 6/u);

    subject.saveSession(ingesting(1), 0);
    expect(subject.loadSession(SESSION)).toMatchObject({ revision: 1 });
    const onDisk = join(workspaceDir, "evidence-sessions", SESSION, "capture-session.json");
    expect(JSON.parse(readFileSync(onDisk, "utf8"))).toMatchObject({ revision: 1 });
  });

  test("refuses an artifact whose descriptor disagrees with its bytes, and a record that is absent", () => {
    const { store: subject } = store();
    const bytes = encoder.encode("artifact");
    subject.putArtifact({ digest: documentDigest(bytes), size: bytes.byteLength, mediaType: "text/plain" }, bytes);
    expect(() => subject.putArtifact(
      { digest: `sha256:${"0".repeat(64)}`, size: bytes.byteLength, mediaType: "text/plain", name: "claimed.txt" },
      bytes,
    )).toThrow(/but its bytes hash to/u);

    expect(() => subject.resolveEvidence({
      family: "result-evaluation",
      record: { name: "absent.dsse.json", digest: { sha256: "1".repeat(64) } },
    })).toThrow(/holds no record/u);
  });

  test("refuses to answer for a session it is not bound to", () => {
    const { store: subject } = store();
    expect(() => subject.loadSession("other")).toThrow(/bound to session session-1/u);
  });
});
