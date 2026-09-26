// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  policyDigestOf,
  readEvidenceSession,
  requireEvidenceSession,
  requireMember,
  writeEvidenceSession,
  type EvidenceSessionDocument,
  type EvidenceSessionMember,
} from "./session.js";
import { evidenceSessionStatePath } from "../workspace/layout.js";

const SESSION = "session-1";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "evidence-session-"));
}

function descriptor(name: string, fill: string): EvidenceSessionDocument["benchmark"] {
  return { name, digest: { sha256: fill.repeat(64).slice(0, 64) } };
}

function member(memberKey: string): EvidenceSessionMember {
  return {
    memberKey,
    groupId: "memory",
    slotId: "trial-1",
    unitKey: "trial-1",
    correlationKey: "harbor/job-1/trial-1",
    execution: {
      family: "execution-evidence",
      record: { name: "ro-crate-metadata.json", digest: { sha256: "a".repeat(64) } },
    },
    taskDigest: `sha256:${"b".repeat(64)}`,
    resultDigests: [`sha256:${"c".repeat(64)}`],
    task: { name: "task.json", sha256: "b".repeat(64), size: 3, mediaType: "application/json" },
    results: [{ name: "prediction.json", sha256: "c".repeat(64), size: 3, mediaType: "application/json" }],
    assurance: {
      origin: "native-direct",
      timing: "prospective-native-observed",
      closure: "complete-relative-to-sealed-source",
      availability: "public-exact",
      limitations: [],
    },
    evaluations: [],
  };
}

function session(overrides: Partial<EvidenceSessionDocument> = {}): EvidenceSessionDocument {
  const analysis = { owner: "urn:agent:analysis-owner", preregistration: "local-sealed-before-selection" };
  return {
    documentVersion: 1,
    sessionId: SESSION,
    phase: "preregistered",
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
    policyDigest: policyDigestOf(analysis),
    benchmark: descriptor("benchmark.json", "d"),
    analysis,
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "1",
      parameters: { k: 1 },
      implementation: descriptor("assembly.json", "e"),
    },
    evaluationMethod: descriptor("binary-instrument.json", "f"),
    members: [],
    ...overrides,
  };
}

describe("evidence session document", () => {
  test("round-trips through the workspace", () => {
    const dir = workspace();
    const written = session({ members: [member("memory/trial-1")], phase: "captured" });
    writeEvidenceSession(dir, written);
    expect(readEvidenceSession(dir, SESSION)).toEqual(written);
    expect(readEvidenceSession(dir, "absent")).toBeUndefined();
  });

  test("the policy digest is a function of the policy, not of key order", () => {
    const first = policyDigestOf({ owner: "urn:a", closeAt: "2026-08-16T14:00:00.000Z" });
    const second = policyDigestOf({ closeAt: "2026-08-16T14:00:00.000Z", owner: "urn:a" });
    expect(first).toBe(second);
    expect(policyDigestOf({ owner: "urn:b" })).not.toBe(first);
  });

  test("an unknown session is not-found and points at the verb that creates one", () => {
    const dir = workspace();
    expect(() => requireEvidenceSession(dir, SESSION, "capture", ["preregistered"]))
      .toThrow(/does not exist; "evidence prereg" creates it/u);
  });

  test("a wrong-phase session is a conflict naming both the required and the actual phase", () => {
    const dir = workspace();
    writeEvidenceSession(dir, session({ phase: "sealed" }));
    expect(() => requireEvidenceSession(dir, SESSION, "capture", ["preregistered"]))
      .toThrow(/requires an evidence session in phase preregistered; "session-1" is sealed/u);
    expect(() => requireEvidenceSession(dir, SESSION, "publish", ["sealed"])).not.toThrow();
  });

  test("a traversal-shaped session id is refused before any path is joined", () => {
    const dir = workspace();
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      expect(() => requireEvidenceSession(dir, bad, "capture", ["preregistered"]), bad)
        .toThrow(/must be 1-64 characters/u);
    }
  });

  test("a corrupted session document is record-integrity, never a silent default", () => {
    const dir = workspace();
    writeEvidenceSession(dir, session());
    writeFileSync(evidenceSessionStatePath(dir, SESSION), JSON.stringify({ documentVersion: 1, phase: "nope" }));
    expect(() => readEvidenceSession(dir, SESSION)).toThrow();
  });

  test("an uncaptured member names what the session actually holds", () => {
    const captured = session({ members: [member("memory/trial-1")], phase: "captured" });
    expect(requireMember(captured, "memory/trial-1").unitKey).toBe("trial-1");
    expect(() => requireMember(captured, "memory/trial-9"))
      .toThrow(/captured no member "memory\/trial-9"; it holds memory\/trial-1/u);
    expect(() => requireMember(session(), "memory/trial-1")).toThrow(/it holds none/u);
  });

  test("the document on disk is pretty-printed JSON a human can read during an incident", () => {
    const dir = workspace();
    writeEvidenceSession(dir, session());
    expect(readFileSync(evidenceSessionStatePath(dir, SESSION), "utf8")).toMatch(/^\{\n {2}"documentVersion": 1,/u);
  });
});
