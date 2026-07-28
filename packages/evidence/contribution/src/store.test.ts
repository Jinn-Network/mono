// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import { createProposedContributionRequestState } from "./state.js";
import type { ContributionRequestState } from "./state.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type { CreateContributionRequestInput } from "./types.js";

function proposal(): CreateContributionRequestInput {
  return {
    idempotencyKey: "plugin:attempt-1",
    source: {
      repositoryBindingId: "private-local",
      record: { family: "execution-evidence", digest: `sha256:${"b".repeat(64)}` },
    },
    stagingRepositoryBindingId: "private-staging",
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    destinations: [{
      destination: "https://destinations.example/ipfs",
      medium: "https://media.example/ipfs",
      profile: "https://profiles.example/evidence/v1",
      configurationDigest: `sha256:${"c".repeat(64)}`,
      label: "Public IPFS",
      irreversible: true,
      deactivation: "unsupported",
    }],
    limits: {
      maxDestinations: 4,
      maxArtifacts: 128,
      maxArtifactBytes: 16_777_216,
      maxTotalArtifactBytes: 67_108_864,
      maxManifestBytes: 1_048_576,
      maxConcurrentDestinations: 2,
    },
  };
}

function initialState(requestId = "request-1"): ContributionRequestState {
  return createProposedContributionRequestState({
    requestId,
    proposal: proposal(),
    proposalFingerprint: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-07-28T00:00:00Z",
  });
}

describe("InMemoryContributionStore", () => {
  test("moves a request from proposed to preparing via compare-and-swap", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    await expect(
      store.compareAndSwapRequest(created, {
        ...created.value,
        preparation: { status: "preparing" },
        updatedAt: "2026-07-28T00:00:01Z",
      }),
    ).resolves.toMatchObject({ revision: 2 });
  });

  test("rejects create for a duplicate request id", async () => {
    const store = new InMemoryContributionStore();
    await store.createRequest(initialState());
    await expect(store.createRequest(initialState()))
      .rejects.toThrow(EvidenceContributionError);
  });

  test("rejects a compare-and-swap against a stale revision", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    await store.compareAndSwapRequest(created, {
      ...created.value,
      preparation: { status: "preparing" },
      updatedAt: "2026-07-28T00:00:01Z",
    });
    await expect(
      store.compareAndSwapRequest(created, {
        ...created.value,
        preparation: {
          status: "declined",
          declinedAt: "2026-07-28T00:00:02Z",
          reasonCode: "OPERATOR_ATTENTION_REQUIRED",
        },
        updatedAt: "2026-07-28T00:00:02Z",
      }),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("rejects an impossible preparation transition", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    await expect(
      store.compareAndSwapRequest(created, {
        ...created.value,
        preparation: {
          status: "preview-ready",
          disclosure: {
            manifest: {} as never,
            manifestBytes: new Uint8Array(),
            previewFingerprint: `sha256:${"e".repeat(64)}`,
          },
        },
        updatedAt: "2026-07-28T00:00:01Z",
      }),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("rejects changing the immutable proposal after creation", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    await expect(
      store.compareAndSwapRequest(created, {
        ...created.value,
        proposal: { ...created.value.proposal, stagingRepositoryBindingId: "changed" },
        preparation: { status: "preparing" },
        updatedAt: "2026-07-28T00:00:01Z",
      }),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("rejects rewriting append-only audit event history", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    await expect(
      store.compareAndSwapRequest(created, {
        ...created.value,
        preparation: { status: "preparing" },
        auditEvents: [],
        updatedAt: "2026-07-28T00:00:01Z",
      }),
    ).rejects.toThrow(EvidenceContributionError);
  });

  test("returns defensive snapshots that never alias durable state", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(initialState());
    const loaded = await store.loadRequest("request-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.value).not.toBe(created.value);
    expect(loaded!.value.destinations).not.toBe(created.value.destinations);
    (loaded!.value as { proposal: { stagingRepositoryBindingId: string } })
      .proposal.stagingRepositoryBindingId = "mutated";
    const reloaded = await store.loadRequest("request-1");
    expect(reloaded!.value.proposal.stagingRepositoryBindingId)
      .toBe("private-staging");
  });

  test("finds a request by idempotency key", async () => {
    const store = new InMemoryContributionStore();
    await store.createRequest(initialState());
    const found = await store.findRequestByIdempotencyKey("plugin:attempt-1");
    expect(found?.value.requestId).toBe("request-1");
  });

  test("counts operations without side effects on the caller", async () => {
    const store = new InMemoryContributionStore();
    await store.createRequest(initialState());
    await store.loadRequest("request-1");
    await store.loadRequest("request-1");
    expect(store.counters.createRequest).toBe(1);
    expect(store.counters.loadRequest).toBe(2);
  });

  test("honors an already-aborted signal", async () => {
    const store = new InMemoryContributionStore();
    const controller = new AbortController();
    controller.abort();
    await expect(
      store.loadRequest("request-1", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });
});
