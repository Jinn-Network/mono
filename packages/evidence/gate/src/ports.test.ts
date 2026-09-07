import { recordDigest } from "@jinn-network/trust-core";
import type { Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { GateConfigurationError } from "./errors.js";
import {
  createInMemoryChallengeStore,
  createInMemoryOfferSource,
  createInMemorySubjectSource,
  createRepositorySubjectSource,
  systemClock,
} from "./ports.js";

const NO_SIGNAL = Object.freeze({});
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ABSENT = `sha256:${"0".repeat(64)}` as Sha256Digest;

let nonceCount = 0;
const countingNonce = (): string => `nonce-${(nonceCount += 1)}`;

describe("createInMemoryOfferSource", () => {
  test("files an envelope under the digest of its own bytes", async () => {
    const envelope = bytes('{"an":"offer"}');
    const source = createInMemoryOfferSource([envelope]);
    const digest = recordDigest(envelope);
    expect(await source.read(digest, NO_SIGNAL)).toEqual(envelope);
  });

  test("an offer it does not hold reads as null, which is what delisting produces", async () => {
    const envelope = bytes('{"an":"offer"}');
    const source = createInMemoryOfferSource([envelope]);
    const digest = recordDigest(envelope);
    expect(source.delist(digest)).toBe(true);
    expect(await source.read(digest, NO_SIGNAL)).toBeNull();
    expect(source.delist(digest)).toBe(false);
    expect(await source.read(ABSENT, NO_SIGNAL)).toBeNull();
  });

  test("a caller cannot mutate the held bytes through what it is handed", async () => {
    const source = createInMemoryOfferSource();
    const digest = source.add(bytes("terms"));
    const first = await source.read(digest, NO_SIGNAL);
    first![0] = 0;
    expect(await source.read(digest, NO_SIGNAL)).toEqual(bytes("terms"));
  });
});

describe("createInMemorySubjectSource", () => {
  test("round-trips bytes by digest and reports an absent subject as null", async () => {
    const source = createInMemorySubjectSource([bytes("the goods")]);
    const digest = recordDigest(bytes("the goods"));
    expect(await source.read(digest, NO_SIGNAL)).toEqual(bytes("the goods"));
    expect(await source.read(ABSENT, NO_SIGNAL)).toBeNull();
    expect(source.remove(digest)).toBe(true);
    expect(await source.read(digest, NO_SIGNAL)).toBeNull();
  });
});

describe("createRepositorySubjectSource", () => {
  test("reads the repository's artifact store, the one purely digest-addressed read", async () => {
    const held = bytes("an image blob");
    const digest = recordDigest(held);
    const reads: Sha256Digest[] = [];
    const source = createRepositorySubjectSource({
      capabilities: {},
      putRecord: async () => {
        throw new Error("a gate never writes");
      },
      getRecord: async () => {
        throw new Error("a subject has no record family to look up by");
      },
      putArtifact: async () => {
        throw new Error("a gate never writes");
      },
      getArtifact: async (reference) => {
        reads.push(reference.digest);
        return reference.digest === digest ? held : null;
      },
    });

    expect(await source.read(digest, NO_SIGNAL)).toEqual(held);
    expect(await source.read(ABSENT, NO_SIGNAL)).toBeNull();
    expect(reads).toEqual([digest, ABSENT]);
  });

  test("forwards an abort signal to the repository", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const source = createRepositorySubjectSource({
      capabilities: {},
      putRecord: async () => {
        throw new Error("unused");
      },
      getRecord: async () => null,
      putArtifact: async () => {
        throw new Error("unused");
      },
      getArtifact: async (_reference, options) => {
        seen = options?.signal;
        return null;
      },
    });
    await source.read(ABSENT, { signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});

describe("createInMemoryChallengeStore", () => {
  const now = "2026-08-31T12:00:00.000Z";

  test("issues a challenge bound to the pickup it was asked about", async () => {
    const store = createInMemoryChallengeStore({ nonce: countingNonce, ttlMs: 60_000 });
    const challenge = await store.issue(
      { offerDigest: ABSENT, rail: "https://rails.test.example/v1", paymentReference: "tx-1", now },
      NO_SIGNAL,
    );
    expect(challenge.offerDigest).toBe(ABSENT);
    expect(challenge.rail).toBe("https://rails.test.example/v1");
    expect(challenge.paymentReference).toBe("tx-1");
    expect(challenge.expiresAt).toBe("2026-08-31T12:01:00.000Z");
    expect(challenge.id).not.toBe(challenge.nonce);
  });

  test("an answer works exactly once", async () => {
    const store = createInMemoryChallengeStore({ nonce: countingNonce });
    const challenge = await store.issue(
      { offerDigest: ABSENT, rail: "https://rails.test.example/v1", paymentReference: "tx", now },
      NO_SIGNAL,
    );
    expect(await store.consume(challenge.id, now, NO_SIGNAL)).toEqual(challenge);
    expect(await store.consume(challenge.id, now, NO_SIGNAL)).toBeUndefined();
  });

  test("a challenge that has expired is not consumable", async () => {
    const store = createInMemoryChallengeStore({ nonce: countingNonce, ttlMs: 1_000 });
    const challenge = await store.issue(
      { offerDigest: ABSENT, rail: "https://rails.test.example/v1", paymentReference: "tx", now },
      NO_SIGNAL,
    );
    expect(await store.consume(challenge.id, "2026-08-31T12:00:02.000Z", NO_SIGNAL)).toBeUndefined();
  });

  test("an unknown id consumes to nothing rather than throwing", async () => {
    const store = createInMemoryChallengeStore({ nonce: countingNonce });
    expect(await store.consume("never-issued", now, NO_SIGNAL)).toBeUndefined();
  });

  test("outstanding challenges are bounded, so a stranger cannot exhaust memory", async () => {
    const store = createInMemoryChallengeStore({
      nonce: countingNonce,
      maxOutstanding: 2,
      ttlMs: 60_000,
    });
    const issue = (reference: string) =>
      store.issue(
        {
          offerDigest: ABSENT,
          rail: "https://rails.test.example/v1",
          paymentReference: reference,
          now,
        },
        NO_SIGNAL,
      );
    const first = await issue("tx-1");
    const second = await issue("tx-2");
    const third = await issue("tx-3");
    // The bound holds: the oldest went, and the two newest are still answerable.
    expect(await store.consume(first.id, now, NO_SIGNAL)).toBeUndefined();
    expect(await store.consume(second.id, now, NO_SIGNAL)).toEqual(second);
    expect(await store.consume(third.id, now, NO_SIGNAL)).toEqual(third);
  });

  test("expired challenges are swept before anything live is evicted", async () => {
    const store = createInMemoryChallengeStore({
      nonce: countingNonce,
      maxOutstanding: 2,
      ttlMs: 1_000,
    });
    const stale = await store.issue(
      { offerDigest: ABSENT, rail: "https://rails.test.example/v1", paymentReference: "old", now },
      NO_SIGNAL,
    );
    const later = "2026-08-31T12:00:05.000Z";
    const live = await store.issue(
      {
        offerDigest: ABSENT,
        rail: "https://rails.test.example/v1",
        paymentReference: "new",
        now: later,
      },
      NO_SIGNAL,
    );
    expect(await store.consume(stale.id, later, NO_SIGNAL)).toBeUndefined();
    expect(await store.consume(live.id, later, NO_SIGNAL)).toEqual(live);
  });

  test("nonsense bounds are a configuration error, not a silent default", () => {
    expect(() => createInMemoryChallengeStore({ ttlMs: 0 })).toThrow(GateConfigurationError);
    expect(() => createInMemoryChallengeStore({ ttlMs: Number.NaN })).toThrow(GateConfigurationError);
    expect(() => createInMemoryChallengeStore({ maxOutstanding: 0 })).toThrow(GateConfigurationError);
    expect(() => createInMemoryChallengeStore({ maxOutstanding: 1.5 })).toThrow(
      GateConfigurationError,
    );
  });

  test("an unparseable clock reading is loud rather than silently unbounded", async () => {
    const store = createInMemoryChallengeStore({ nonce: countingNonce });
    await expect(
      store.issue(
        {
          offerDigest: ABSENT,
          rail: "https://rails.test.example/v1",
          paymentReference: "tx",
          now: "half past four",
        },
        NO_SIGNAL,
      ),
    ).rejects.toThrow(GateConfigurationError);
  });
});

describe("systemClock", () => {
  test("reads an RFC 3339 instant in UTC", () => {
    expect(systemClock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  });
});
