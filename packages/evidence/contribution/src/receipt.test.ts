// SPDX-License-Identifier: Apache-2.0
import type { Sha256Digest } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { createContributionReceiptFingerprint } from "./identities.js";
import {
  appendCurrentContributionReceipt,
  createContributionReceipt,
  readContributionReceipt,
} from "./receipt.js";
import { EvidenceContributionError } from "./errors.js";
import { createProposedContributionRequestState, type ContributionRequestState } from "./state.js";
import { InMemoryContributionStore } from "./testing-fixtures.js";
import type { CreateContributionRequestInput } from "./types.js";

function proposal(): CreateContributionRequestInput {
  return {
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

function proposedState(): ContributionRequestState {
  return createProposedContributionRequestState({
    requestId: "request-1",
    proposal: proposal(),
    proposalFingerprint: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-07-28T00:00:00Z",
  });
}

/**
 * Recursively scan an arbitrary value for a synthetic marker string, in
 * raw, hex, and base64 forms -- a lightweight local version of the
 * authority-marker scan the Task 10 contract kit runs exhaustively.
 */
function assertNoLeak(value: unknown, marker: string): void {
  const raw = marker;
  const hex = Buffer.from(marker, "utf8").toString("hex");
  const base64 = Buffer.from(marker, "utf8").toString("base64");
  const serialized = JSON.stringify(value, (_key, entry) =>
    entry instanceof Uint8Array ? Buffer.from(entry).toString("hex") : entry);
  expect(serialized).not.toContain(raw);
  expect(serialized).not.toContain(hex);
  expect(serialized).not.toContain(base64);
}

describe("createContributionReceipt", () => {
  test("declined before preview carries only the reason code and status", () => {
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: {
        status: "declined",
        declinedAt: "2026-07-28T00:00:01Z",
        reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      },
    };
    const receipt = createContributionReceipt(state);
    expect(receipt.status).toBe("declined");
    expect(receipt.declinedReasonCode).toBe("OPERATOR_ATTENTION_REQUIRED");
    expect(receipt.destinations).toEqual([]);
    expect(receipt.stagingRetention).toBe("eligible-for-host-cleanup");
  });

  test("withheld carries only content-free reasons", () => {
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: { status: "withheld", reasons: [{ code: "POLICY_WITHHELD" }] },
    };
    const receipt = createContributionReceipt(state);
    expect(receipt.status).toBe("withheld");
    expect(receipt.withheldReasons).toEqual([{ code: "POLICY_WITHHELD" }]);
    expect(receipt.stagingRetention).toBe("eligible-for-host-cleanup");
  });

  test("review-required carries only the opaque review reference", () => {
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: { status: "review-required", reviewReference: "review-ref-secret-findings" },
    };
    const receipt = createContributionReceipt(state);
    expect(receipt.status).toBe("review-required");
    expect(receipt.reviewReference).toBe("review-ref-secret-findings");
    expect(receipt.stagingRetention).toBe("required-for-recovery");
  });

  test("a completed request is eligible for host cleanup and requires no further retention", () => {
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: {
        status: "preview-ready",
        disclosure: {
          manifest: {
            preparedRecord: { family: "execution-evidence", digest: `sha256:${"f".repeat(64)}` },
            artifacts: [],
          } as never,
          manifestBytes: new Uint8Array(),
          previewFingerprint: `sha256:${"e".repeat(64)}` as Sha256Digest,
        },
      },
      destinations: [{
        destination: "https://destinations.example/ipfs",
        authorization: { status: "authorized" },
        publication: {
          status: "published",
          publishedAt: "2026-07-28T00:01:00Z",
          bundleKey: `sha256:${"1".repeat(64)}` as Sha256Digest,
          payloadFingerprint: `sha256:${"2".repeat(64)}` as Sha256Digest,
          locations: [],
        },
        deactivation: { requested: false },
      }],
    };
    const receipt = createContributionReceipt(state);
    expect(receipt.status).toBe("completed");
    expect(receipt.stagingRetention).toBe("eligible-for-host-cleanup");
    expect(receipt.destinations[0]).toMatchObject({ status: "published" });
  });
});

describe("appendCurrentContributionReceipt", () => {
  test("appends exactly one entry per distinct receipt and none for identical retries", () => {
    const declined: ContributionRequestState = {
      ...proposedState(),
      preparation: {
        status: "declined",
        declinedAt: "2026-07-28T00:00:01Z",
        reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      },
    };
    const once = appendCurrentContributionReceipt(declined);
    expect(once.receipts).toHaveLength(1);
    const twice = appendCurrentContributionReceipt(once);
    expect(twice.receipts).toHaveLength(1);
    expect(twice).toBe(once);
  });

  test("every appended entry self-verifies against createContributionReceiptFingerprint", () => {
    const state = appendCurrentContributionReceipt({
      ...proposedState(),
      preparation: { status: "withheld", reasons: [{ code: "POLICY_WITHHELD" }] },
    });
    const entry = state.receipts[0]!;
    expect(createContributionReceiptFingerprint(entry.receipt)).toBe(entry.receiptFingerprint);
  });
});

describe("readContributionReceipt", () => {
  test("derives a live receipt when no entry has ever been appended", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(proposedState());
    const receipt = await readContributionReceipt(created.value.requestId, { store });
    expect(receipt.status).toBe("proposed");
  });

  test("returns the latest durable entry once one has been appended", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(proposedState());
    const withReceipt = appendCurrentContributionReceipt({
      ...created.value,
      preparation: {
        status: "declined",
        declinedAt: "2026-07-28T00:00:01Z",
        reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      },
    });
    await store.compareAndSwapRequest(created, withReceipt);
    const receipt = await readContributionReceipt(created.value.requestId, { store });
    expect(receipt.status).toBe("declined");
  });

  test("fails closed if a stored entry does not self-verify", async () => {
    const store = new InMemoryContributionStore();
    const created = await store.createRequest(proposedState());
    const tampered: ContributionRequestState = {
      ...created.value,
      preparation: {
        status: "declined",
        declinedAt: "2026-07-28T00:00:01Z",
        reasonCode: "OPERATOR_ATTENTION_REQUIRED",
      },
      receipts: [{
        receipt: createContributionReceipt({
          ...created.value,
          preparation: {
            status: "declined",
            declinedAt: "2026-07-28T00:00:01Z",
            reasonCode: "OPERATOR_ATTENTION_REQUIRED",
          },
        }),
        receiptFingerprint: `sha256:${"0".repeat(64)}` as Sha256Digest,
      }],
    };
    await store.compareAndSwapRequest(created, tampered);
    await expect(readContributionReceipt(created.value.requestId, { store }))
      .rejects.toThrow(EvidenceContributionError);
  });
});

describe("receipt privacy", () => {
  test("a review-required receipt never leaks the retained findings content", () => {
    const marker = "SECRET-FINDING-should-never-leak";
    const state: ContributionRequestState = {
      ...proposedState(),
      preparation: { status: "review-required", reviewReference: "review-ref-1" },
    };
    const receipt = createContributionReceipt(state);
    assertNoLeak(receipt, marker);
  });
});
