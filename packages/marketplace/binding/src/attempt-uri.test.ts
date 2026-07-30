import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveAttemptUri, isValidUrnUuid } from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";
import {
  MARKETPLACE_BINDING_NAME,
  deriveMarketplaceAttemptUri,
  normalizeAttemptTuple,
} from "./attempt-uri.js";
import { BASE_SEPOLIA_TODAY } from "./addresses.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "attempt-uri-agreement.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  chainId: number;
  coordinator: string;
  taskId: string;
  attemptIndex: number;
  uri: string;
};

const canonicalInput = {
  chainId: BASE_SEPOLIA_TODAY.chainId,
  coordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
  taskId: 1n,
  attemptIndex: 0,
};

describe("MARKETPLACE_BINDING_NAME", () => {
  test("is frozen to the pinned binding name", () => {
    expect(MARKETPLACE_BINDING_NAME).toBe("jinn:marketplace");
  });
});

describe("normalizeAttemptTuple", () => {
  test("lowercases the coordinator and stringifies taskId/attemptIndex as decimal", () => {
    expect(
      normalizeAttemptTuple({
        chainId: 84532,
        coordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
        taskId: 1n,
        attemptIndex: 0,
      }),
    ).toEqual([84532, "0x8a34793e10595c89b7e41cc7ff0f76850f44ad98", "1", "0"]);
  });
});

describe("deriveMarketplaceAttemptUri", () => {
  // (a) proves the binding calls the protocol export byte-for-byte, never re-deriving UUIDv5
  // (must #2) -- the adapter's output over the normalized marketplace tuple equals a direct call
  // to the protocol's own `deriveAttemptUri` over the same normalized tuple.
  test("(a) equals a direct deriveAttemptUri call over the normalized marketplace tuple", () => {
    const adapterUri = deriveMarketplaceAttemptUri(canonicalInput);
    const directUri = deriveAttemptUri(MARKETPLACE_BINDING_NAME, [
      84532,
      "0x8a34793e10595c89b7e41cc7ff0f76850f44ad98",
      "1",
      "0",
    ]);
    expect(adapterUri).toBe(directUri);
  });

  test("(b) is a valid urn:uuid", () => {
    expect(isValidUrnUuid(deriveMarketplaceAttemptUri(canonicalInput))).toBe(true);
  });

  test("(c) checksum vs lowercase coordinator produce the same URI (normalization freeze)", () => {
    const checksumUri = deriveMarketplaceAttemptUri({
      ...canonicalInput,
      coordinator: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    });
    const lowercaseUri = deriveMarketplaceAttemptUri({
      ...canonicalInput,
      coordinator: "0x8a34793e10595c89b7e41cc7ff0f76850f44ad98",
    });
    expect(checksumUri).toBe(lowercaseUri);
  });

  test("(d) distinct attemptIndex values never collide across a released/re-claimed slot (§5.2)", () => {
    const first = deriveMarketplaceAttemptUri({ ...canonicalInput, attemptIndex: 0 });
    const second = deriveMarketplaceAttemptUri({ ...canonicalInput, attemptIndex: 1 });
    expect(first).not.toBe(second);
  });

  test("matches the pinned agreement fixture for the canonical marketplace tuple", () => {
    expect(fixture.chainId).toBe(canonicalInput.chainId);
    expect(fixture.coordinator).toBe(canonicalInput.coordinator.toLowerCase());
    expect(fixture.taskId).toBe(canonicalInput.taskId.toString());
    expect(fixture.attemptIndex).toBe(canonicalInput.attemptIndex);
    expect(deriveMarketplaceAttemptUri(canonicalInput)).toBe(fixture.uri);
  });
});
