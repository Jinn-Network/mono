// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { recordDigest } from "@jinn-network/trust-core";
import type { Sha256Digest } from "@jinn-network/trust-core";

import { GateConfigurationError } from "./errors.js";
import type { GateChallenge } from "./rail.js";

export interface GateOperationOptions {
  readonly signal?: AbortSignal;
}

/**
 * Where the gate finds the terms it is being asked to honor.
 *
 * It returns sealed envelope *bytes*, not a parsed offer, because the offer's identity is
 * the digest of those bytes: the gate re-derives it and compares. A source that hands back
 * a parsed object would be asking the gate to take its word for which offer this is.
 *
 * Returning `null` is delisting. It is the holder's only way to stop honoring terms, and it
 * is a different act from repricing — superseding an offer announces new terms and says
 * nothing about the old one, which the gate goes on honoring until it is taken off the gate.
 *
 * `offerDigest` is always `sha256:<64 lowercase hex>`: the gate validates the shape of the
 * caller's digest before it calls this, so a source may interpolate it into a path or a URL
 * without escaping it. `Sha256Digest` is a template-literal type rather than a validated
 * brand, so this is a promise the gate keeps rather than one the type does.
 */
export interface OfferSource {
  read(
    offerDigest: Sha256Digest,
    options: GateOperationOptions,
  ): Promise<Uint8Array | null>;
}

/**
 * Where the gate finds the bytes it sells. Digest-addressed and nothing else: a subject is
 * any digest-addressed content — a sealed record, an OCI image blob — and the gate has no
 * business knowing which.
 */
export interface SubjectSource {
  read(
    subject: Sha256Digest,
    options: GateOperationOptions,
  ): Promise<Uint8Array | null>;
}

export interface IssueChallengeInput {
  readonly offerDigest: Sha256Digest;
  readonly rail: string;
  readonly paymentReference: string;
  readonly now: string;
}

/**
 * The one-shot questions the gate asks would-be collectors on publicly-visible rails.
 *
 * `consume` both looks a challenge up and retires it, so an answer works exactly once. That
 * is the whole anti-replay story, and it is not download bookkeeping: nothing here records
 * which subject anyone has collected, and a payer who wants their bytes again simply asks a
 * fresh question.
 */
export interface ChallengeStore {
  issue(input: IssueChallengeInput, options: GateOperationOptions): Promise<GateChallenge>;
  consume(
    challengeId: string,
    now: string,
    options: GateOperationOptions,
  ): Promise<GateChallenge | undefined>;
}

/** RFC 3339 now. Injected so a gate's timestamps are testable and a holder can pin a source. */
export interface Clock {
  now(): string;
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date().toISOString(),
});

interface MutableByteStore {
  read(digest: Sha256Digest, options: GateOperationOptions): Promise<Uint8Array | null>;
  /** Returns the digest the bytes were filed under. */
  add(bytes: Uint8Array): Sha256Digest;
  remove(digest: Sha256Digest): boolean;
}

function createByteStore(initial: readonly Uint8Array[]): MutableByteStore {
  const held = new Map<string, Uint8Array>();
  const store: MutableByteStore = {
    async read(digest, options) {
      options.signal?.throwIfAborted();
      const bytes = held.get(digest);
      return bytes === undefined ? null : Uint8Array.prototype.slice.call(bytes);
    },
    add(bytes) {
      const digest = recordDigest(bytes);
      held.set(digest, Uint8Array.prototype.slice.call(bytes));
      return digest;
    },
    remove(digest) {
      return held.delete(digest);
    },
  };
  for (const bytes of initial) store.add(bytes);
  return store;
}

export interface InMemoryOfferSource extends OfferSource {
  /** Files a sealed offer envelope under its own digest and returns it. */
  add(envelopeBytes: Uint8Array): Sha256Digest;
  /** Delists an offer. The gate then answers `unknown-offer`, which is what delisting is. */
  delist(offerDigest: Sha256Digest): boolean;
}

/**
 * Offers held in memory, keyed by the digest of the envelope bytes themselves — so this
 * source cannot file an offer under a digest that is not its own.
 */
export function createInMemoryOfferSource(
  envelopes: readonly Uint8Array[] = [],
): InMemoryOfferSource {
  const store = createByteStore(envelopes);
  return {
    read: (offerDigest, options) => store.read(offerDigest, options),
    add: (envelopeBytes) => store.add(envelopeBytes),
    delist: (offerDigest) => store.remove(offerDigest),
  };
}

export interface InMemorySubjectSource extends SubjectSource {
  add(bytes: Uint8Array): Sha256Digest;
  remove(subject: Sha256Digest): boolean;
}

export function createInMemorySubjectSource(
  subjects: readonly Uint8Array[] = [],
): InMemorySubjectSource {
  const store = createByteStore(subjects);
  return {
    read: (subject, options) => store.read(subject, options),
    add: (bytes) => store.add(bytes),
    remove: (subject) => store.remove(subject),
  };
}

/**
 * Binds the gate's subject source to an evidence repository's artifact store, which is the
 * repository contract's one purely digest-addressed read.
 *
 * `getRecord` is deliberately not consulted: it is keyed by `(family, digest)` and a subject
 * is any digest-addressed content, so there is no family to supply. A holder selling sealed
 * records serves them from wherever they keep them by writing their own five-line
 * `SubjectSource`; the interface is the extension point and this is one binding of it.
 */
export function createRepositorySubjectSource(
  repository: EvidenceRepository,
): SubjectSource {
  return {
    async read(subject, options) {
      return repository.getArtifact(
        { digest: subject },
        options.signal === undefined ? {} : { signal: options.signal },
      );
    },
  };
}

/** 32 bytes of Web Crypto randomness as lowercase hex. */
function webCryptoNonce(): string {
  const source = globalThis.crypto;
  if (typeof source?.getRandomValues !== "function") {
    throw new GateConfigurationError(
      "no Web Crypto getRandomValues is available for challenge nonces; supply "
        + "createInMemoryChallengeStore({ nonce }) with a cryptographically random source",
    );
  }
  const bytes = new Uint8Array(32);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface InMemoryChallengeStoreOptions {
  /** How long an unanswered challenge stays askable. Default five minutes. */
  readonly ttlMs?: number;
  /** How many may be outstanding at once. Default 1024. */
  readonly maxOutstanding?: number;
  /**
   * Where nonces and challenge ids come from. Both are drawn independently. The default is
   * Web Crypto; override it only to make a test deterministic.
   */
  readonly nonce?: () => string;
}

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTSTANDING_CHALLENGES = 1024;

/**
 * Challenges held in one process's memory.
 *
 * Bounded on purpose: issuing a challenge is unauthenticated, so an unbounded map is a
 * memory-exhaustion surface any stranger can reach. When the bound is hit, expired entries
 * go first and then the soonest-to-expire, which does mean a flood can evict a legitimate
 * pending challenge. That is the right trade here because the cost of eviction is one
 * re-request: a challenge carries no payment and no delivery, only a question.
 *
 * A holder running more than one gate process needs a shared store instead; this one is a
 * `ChallengeStore` like any other, and that is the seam.
 */
export function createInMemoryChallengeStore(
  options: InMemoryChallengeStoreOptions = {},
): ChallengeStore {
  const ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  const maxOutstanding = options.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING_CHALLENGES;
  const nonce = options.nonce ?? webCryptoNonce;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new GateConfigurationError("challenge ttlMs must be a positive finite number");
  }
  if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1) {
    throw new GateConfigurationError("challenge maxOutstanding must be a positive integer");
  }

  const outstanding = new Map<string, GateChallenge>();

  const expiryMs = (challenge: GateChallenge): number =>
    Date.parse(challenge.expiresAt);

  const dropExpired = (nowMs: number): void => {
    for (const [id, challenge] of outstanding) {
      if (expiryMs(challenge) <= nowMs) outstanding.delete(id);
    }
  };

  return {
    async issue(input, callOptions) {
      callOptions.signal?.throwIfAborted();
      const nowMs = Date.parse(input.now);
      if (Number.isNaN(nowMs)) {
        throw new GateConfigurationError(
          `the gate clock produced an unparseable instant: ${JSON.stringify(input.now)}`,
        );
      }
      dropExpired(nowMs);
      while (outstanding.size >= maxOutstanding) {
        let soonest: string | undefined;
        let soonestMs = Number.POSITIVE_INFINITY;
        for (const [id, challenge] of outstanding) {
          const at = expiryMs(challenge);
          if (at < soonestMs) {
            soonestMs = at;
            soonest = id;
          }
        }
        if (soonest === undefined) break;
        outstanding.delete(soonest);
      }
      const challenge: GateChallenge = {
        id: nonce(),
        nonce: nonce(),
        offerDigest: input.offerDigest,
        rail: input.rail,
        paymentReference: input.paymentReference,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      outstanding.set(challenge.id, challenge);
      return challenge;
    },

    async consume(challengeId, now, callOptions) {
      callOptions.signal?.throwIfAborted();
      const nowMs = Date.parse(now);
      const challenge = outstanding.get(challengeId);
      if (challenge === undefined) return undefined;
      outstanding.delete(challengeId);
      if (Number.isNaN(nowMs) || expiryMs(challenge) <= nowMs) return undefined;
      return challenge;
    },
  };
}
