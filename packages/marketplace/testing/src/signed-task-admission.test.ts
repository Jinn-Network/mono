// SPDX-License-Identifier: MIT

import * as conformance from "./backend-conformance.js";
import {
  dssePreAuthEncoding,
  sealDsseEnvelope,
} from "@jinn-network/trust-core";
import {
  sealTask,
  sha256Hex,
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

test("one admission boundary handles canonical and hostile signed Task envelopes", async () => {
  const fixture = conformance.buildDefaultTrustFixture();
  const task = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: {
      uri: "https://jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "1".repeat(64) },
    },
    instructions: "admission boundary fixture",
    outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
  });
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

  await expect(admit(envelope(task, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey)))
    .resolves.toMatchObject({ ok: true, taskBytes: task });
  await expect(admit(envelope(new TextEncoder().encode(`${new TextDecoder().decode(task)} `), "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey)))
    .resolves.toMatchObject({ ok: false, reason: "task-canonical" });
  const document = JSON.parse(new TextDecoder().decode(task)) as Record<string, unknown>;
  const reordered = new TextEncoder().encode(JSON.stringify({
    outputs: document["outputs"], instructions: document["instructions"],
    profile: document["profile"], protocol: document["protocol"],
  }));
  await expect(admit(envelope(reordered, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey)))
    .resolves.toMatchObject({ ok: false, reason: "task-canonical" });
  const substituted = sealTask({
    ...document,
    instructions: "substituted after signing",
  } as Parameters<typeof sealTask>[0]);
  await expect(admit(envelope(substituted, "application/vnd.jinn.task-execution.task.v1+json", fixture.requesterKey, task)))
    .resolves.toMatchObject({ ok: false, reason: "requester-binding" });
  await expect(admit(envelope(task, "application/json", fixture.requesterKey)))
    .resolves.toMatchObject({ ok: false, reason: "media-type" });
  await expect(admit(envelope(task, "application/vnd.jinn.task-execution.task.v1+json", fixture.executorKey), fixture.executorKey, fixture.executorAgent))
    .resolves.toMatchObject({ ok: false, reason: "requester-binding" });
});
