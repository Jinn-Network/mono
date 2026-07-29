// SPDX-License-Identifier: MIT

import * as conformance from "./backend-conformance.js";
import {
  dssePreAuthEncoding,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import {
  sealTask,
  sha256Hex,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import { expect, test } from "vitest";

test("exports one reusable signed Task admission boundary", () => {
  expect("checkSignedTaskAdmission" in conformance).toBe(true);
});

function envelope(
  payloadBytes: Uint8Array,
  payloadType: string,
  keyid: string,
  signedPayloadBytes = payloadBytes,
): Uint8Array {
  const signature = new TextEncoder().encode(
    `${keyid}:${sha256Hex(dssePreAuthEncoding(payloadType, signedPayloadBytes))}`,
  );
  return sealDsseEnvelope({ payloadBytes, payloadType, signatures: [{ signature, keyid }] });
}

test("shared signed-Task vectors exercise only the exported admission boundary", async () => {
  const fixture = conformance.buildDefaultTrustFixture();
  const task: TaskSpecification = {
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "1".repeat(64) },
    },
    instructions: "admission boundary fixture",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  };
  const canonicalTaskBytes = sealTask(task);
  const dependencies = {
    bindingResolver: fixture.bindingResolver,
    witnessVerifier: { verify1271Witness: async () => ({ verified: true }) },
    dsseVerifier: fixture.dsseVerifier,
  };
  const admit = (envelopeBytes: Uint8Array, key = fixture.requesterKey, agent = fixture.requesterAgent) =>
    conformance.checkSignedTaskAdmission({
      envelopeBytes,
      requesterKey: key,
      requesterAgent: agent,
      atTime: "2026-01-01T00:00:00Z",
      dependencies,
    });

  const noncanonicalTaskBytes = new TextEncoder().encode(
    `${new TextDecoder().decode(canonicalTaskBytes)} `,
  );
  const reorderedTaskBytes = new TextEncoder().encode(JSON.stringify({
    outputs: task.outputs,
    instructions: task.instructions,
    profile: task.profile,
    protocol: task.protocol,
  }));
  const substitutedTaskBytes = sealTask({ ...task, instructions: "substituted after signing" });
  const canonicalEnvelope = envelope(
    canonicalTaskBytes,
    "application/vnd.jinn.task-execution.task.v1+json",
    fixture.requesterKey,
  );

  const vectors: ReadonlyArray<{
    readonly name: string;
    readonly envelopeBytes: Uint8Array;
    readonly key?: string;
    readonly agent?: string;
    readonly expected: conformance.SignedTaskAdmissionResult;
  }> = [
    {
      name: "canonical requester Task",
      envelopeBytes: canonicalEnvelope,
      expected: {
        ok: true as const,
        envelopeBytes: canonicalEnvelope,
        taskBytes: canonicalTaskBytes,
        task,
      },
    },
    {
      name: "trailing-byte noncanonical Task",
      envelopeBytes: envelope(noncanonicalTaskBytes, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey),
      expected: { ok: false as const, reason: "task-canonical" as const, detail: "DSSE payload differs from the canonical sealed Task bytes" },
    },
    {
      name: "reordered noncanonical Task",
      envelopeBytes: envelope(reorderedTaskBytes, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey),
      expected: { ok: false as const, reason: "task-canonical" as const, detail: "DSSE payload differs from the canonical sealed Task bytes" },
    },
    {
      name: "PAE signature for substituted Task",
      envelopeBytes: envelope(substitutedTaskBytes, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey, canonicalTaskBytes),
      expected: {
        ok: false as const,
        reason: "requester-binding" as const,
        detail: "no valid signature by claimed key \"did:key:z6MkRequesterFixtureKey\" on the envelope.",
      },
    },
    {
      name: "wrong DSSE media type",
      envelopeBytes: envelope(canonicalTaskBytes, "application/json", fixture.requesterKey),
      expected: {
        ok: false as const,
        reason: "media-type" as const,
        detail: "expected application/vnd.jinn.task-execution.task.v1+json, got application/json",
      },
    },
    {
      name: "signer without requester authority",
      envelopeBytes: envelope(canonicalTaskBytes, "application/vnd.jinn.task-execution.task.v1+json", fixture.executorKey),
      key: fixture.executorKey,
      agent: fixture.executorAgent,
      expected: {
        ok: false as const,
        reason: "requester-binding" as const,
        detail: "binding scope [jinn:marketplace] does not cover family \"authorizations\".",
      },
    },
  ];

  for (const vector of vectors) {
    expect(await admit(vector.envelopeBytes, vector.key, vector.agent), vector.name).toEqual(vector.expected);
  }
});
