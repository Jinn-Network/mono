import { describe, expect, test } from "vitest";

import {
  type ChainGoldenName,
  type CompositeGoldenName,
  loadAdversarialManifest,
  loadChainGoldenBytes,
  loadChainGoldenDigest,
  loadChainGoldenJson,
  loadCompositeGoldenBytes,
  loadCompositeGoldenDigest,
  loadCompositeGoldenJson,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { anchorAuthenticityBoundOf } from "./anchor.js";
import { ChainEnvironmentRecordSchema, parseChainEnvironmentRecord, sealChainEnvironmentRecord } from "./chain-record.js";
import { CryptoEnvironmentRecordSchema, parseCryptoEnvironmentRecord, sealCryptoEnvironmentRecord } from "./composite.js";
import { isWellKnownDevAddress } from "./dev-addresses.js";
import {
  bareHexDigest,
  chainEnvironmentRecordDigest,
  cryptoEnvironmentRecordDigest,
  prefixedDigest,
} from "./hashing.js";
import {
  CHAIN_ENVIRONMENT_KIND,
  CHAIN_ENVIRONMENT_MEDIA_TYPE,
  CRYPTO_ENVIRONMENT_KIND,
  CRYPTO_ENVIRONMENT_MEDIA_TYPE,
} from "./identifiers.js";
import { DURABLE_SUPPLY_CLOSURE_CLASS } from "./state.js";

const CHAIN_GOLDEN: readonly ChainGoldenName[] = ["closed-anchored-subset", "closed-local", "archive-dependent"];
const COMPOSITE_GOLDEN: readonly CompositeGoldenName[] = ["chain-only", "composed", "extension"];

/** Field names a sealed record must not carry: assurance is derived, never stored (§4.5). */
const ABSENT_MUTABLE_STATUS_KEYS = ["status", "health", "expiresAt", "verified", "outcome"];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Record conformance for the chain-environment and crypto-environment kinds: identifier
 * pinning, schema validation, producer-side re-seal, consumer-side digest checking without
 * re-canonicalization, extension round-tripping, the two-axis assurance surface, the E5 anchor
 * bound, the E13 coverage arithmetic, the composite's routing rules, the digest-confusion
 * boundary in both directions, the fresh-key rule, and the adversarial corpus.
 *
 * Any implementation that produces or consumes these records runs this driver to prove it
 * reproduces the frozen record surface. It asserts what the records ARE; it asserts nothing
 * about whether any world boots or reproduces — those claims live in separately published
 * verification attestations and are bounded there.
 */
export function describeChainEnvironmentRecordConformance(): void {
  describe("Chain environment record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(CHAIN_ENVIRONMENT_KIND).toBe("https://jinn.network/records/chain-environment/1.0");
      expect(CHAIN_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.chain-environment.v1+json");
      expect(CRYPTO_ENVIRONMENT_KIND).toBe("https://jinn.network/records/crypto-environment/1.0");
      expect(CRYPTO_ENVIRONMENT_MEDIA_TYPE).toBe("application/vnd.jinn.crypto-environment.v1+json");
    });

    describe.each(CHAIN_GOLDEN)("chain golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(ChainEnvironmentRecordSchema.safeParse(await loadChainGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const resealed = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
        expect(decode(resealed)).toBe(decode(await loadChainGoldenBytes(name)));
        expect(chainEnvironmentRecordDigest(resealed)).toBe(await loadChainGoldenDigest(name));
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes(name)))
          .toBe(await loadChainGoldenDigest(name));
      });

      test("sealing is idempotent through a parse", async () => {
        const once = sealChainEnvironmentRecord(await loadChainGoldenJson(name));
        const twice = sealChainEnvironmentRecord(parseChainEnvironmentRecord(once));
        expect(chainEnvironmentRecordDigest(twice)).toBe(chainEnvironmentRecordDigest(once));
      });

      test("the record declares both assurance axes and carries no mutable status", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        expect(["closed-state", "archive-dependent"]).toContain(record.stateMaterialization.closureClass);
        expect(["local", "anchored-subset", "full-state"]).toContain(record.stateMaterialization.fidelityClass);
        for (const key of ABSENT_MUTABLE_STATUS_KEYS) {
          expect(Object.hasOwn(record, key), `${key} must not exist on a sealed record`).toBe(false);
        }
      });

      test("every determinism knob is fixed, and time advancement is bounded", async () => {
        const { determinismControls } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        expect(determinismControls.miningMode).not.toBe("interval");
        expect(determinismControls.timeWarp.maxAggregateSeconds).toBeGreaterThanOrEqual(0);
        expect(Object.hasOwn(determinismControls, "prevrandao")).toBe(true);
        expect(Object.hasOwn(determinismControls, "coinbase")).toBe(true);
      });

      test("the capability envelope carries roles and ceilings, never credentials", async () => {
        const { capabilityEnvelope, fixtures } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const fixtureAddresses = new Set(fixtures.accounts.map((account) => account.address));
        for (const signer of capabilityEnvelope.signerRoles) {
          expect(Object.hasOwn(signer, "privateKey")).toBe(false);
          for (const account of signer.accounts) expect(fixtureAddresses.has(account)).toBe(true);
        }
        for (const account of fixtures.accounts) {
          expect(Object.hasOwn(account, "privateKey")).toBe(false);
          expect(Object.hasOwn(account, "mnemonic")).toBe(false);
        }
      });

      // Program §4 contract 8: an address someone might fund turns published scripts live.
      test("no fixture account is a well-known development-mnemonic address", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        for (const account of record.fixtures.accounts) {
          expect(isWellKnownDevAddress(account.address), account.address).toBe(false);
        }
      });

      test("the anchor bound is computable from the record alone (E5)", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const bound = anchorAuthenticityBoundOf(record.sourceAnchor);
        if (record.stateMaterialization.fidelityClass === "local") {
          expect(bound).toBe("not-anchored");
        } else {
          expect(["declared", "header-proven"]).toContain(bound);
        }
      });

      test("a durable-supply record is closed-state and requires the closure check", async () => {
        const record = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        if (record.stateMaterialization.closureClass !== DURABLE_SUPPLY_CLOSURE_CLASS) return;
        expect(record.verificationContract.closureCheckRequired).toBe(true);
        expect(record.verificationContract.resetRequirements.minimumRuns).toBeGreaterThanOrEqual(5);
        expect(record.determinismControls.resetMechanism).toBe("fresh-process");
        expect(record.stateMaterialization.stateArtifact).toBeDefined();
      });

      // E13, restated as an assertion a third party can run over any record they are handed.
      test("every artifact entry is proof-covered or fixture-declared", async () => {
        const { stateMaterialization } = parseChainEnvironmentRecord(await loadChainGoldenBytes(name));
        const artifact = stateMaterialization.stateArtifact;
        if (artifact === undefined || stateMaterialization.fidelityClass === "local") return;
        const proofs = stateMaterialization.sourceProofManifest;
        const fixtures = stateMaterialization.fixtureCoverage;
        expect(proofs).toBeDefined();
        expect(fixtures).toBeDefined();
        for (const category of ["accounts", "storageSlots", "codeEntries"] as const) {
          expect(proofs!.coverage[category] + fixtures!.declared[category])
            .toBe(artifact.entryCounts[category]);
        }
      });
    });

    describe.each(COMPOSITE_GOLDEN)("composite golden fixture: %s", (name) => {
      test("parses under the composite schema", async () => {
        expect(CryptoEnvironmentRecordSchema.safeParse(await loadCompositeGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const resealed = sealCryptoEnvironmentRecord(await loadCompositeGoldenJson(name));
        expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes(name)));
        expect(cryptoEnvironmentRecordDigest(resealed)).toBe(await loadCompositeGoldenDigest(name));
      });

      test("references its chain world by digest and inlines no world content (E11)", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        expect(record.chainWorld.kind).toBe(CHAIN_ENVIRONMENT_KIND);
        expect(record.chainWorld.record.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
        for (const world of record.informationWorlds) {
          expect(world.record.digest?.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      });

      test("no origin is claimed by two worlds without declared precedence", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        const byOrigin = new Map<string, Set<number>>();
        for (const route of record.composition.originRouting) {
          const seen = byOrigin.get(route.origin) ?? new Set<number>();
          expect(seen.has(route.precedence), `${route.origin} precedence ${route.precedence}`).toBe(false);
          seen.add(route.precedence);
          byOrigin.set(route.origin, seen);
        }
      });

      test("a miss returns the declared response; there is no live-fetch mode", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        expect(record.composition.missPolicy.mode).toBe("declared-response");
      });

      test("retrieval is bounded, and a chain-only composite has no information plane", async () => {
        const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes(name));
        if (record.informationWorlds.length === 0) {
          expect(record.composition.requestBudget.maxRequests).toBe(0);
          expect(record.composition.originRouting).toEqual([]);
        } else {
          expect(record.composition.requestBudget.maxRequests).toBeGreaterThan(0);
        }
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      for (const variant of ["a", "b"] as const) {
        expect(chainEnvironmentRecordDigest(sealChainEnvironmentRecord(await loadEquivalenceInput(variant))))
          .toBe(expected);
      }
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const pretty = new TextEncoder().encode(
        JSON.stringify(await loadChainGoldenJson("closed-anchored-subset"), null, 2),
      );
      expect(() => parseChainEnvironmentRecord(pretty)).toThrow();
    });

    test("namespaced extension keys survive sealing and re-parsing", async () => {
      const record = parseCryptoEnvironmentRecord(await loadCompositeGoldenBytes("extension"));
      expect((record as Record<string, unknown>)["network.jinn.note"]).toBeDefined();
      const resealed = sealCryptoEnvironmentRecord(record);
      expect(decode(resealed)).toBe(decode(await loadCompositeGoldenBytes("extension")));
    });

    // Digest confusion, both directions (program §4 contract 6). Record-body digests are
    // `sha256:`-prefixed; in-toto DigestSet subject values are bare hex. Mixing them is the
    // single most likely wiring error at the record/attestation boundary.
    describe("digest confusion", () => {
      test("the record identity is sha256:-prefixed", async () => {
        expect(chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-anchored-subset")))
          .toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      test("bareHexDigest yields the DigestSet spelling and prefixedDigest inverts it", async () => {
        const digest = chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-anchored-subset"));
        const bare = bareHexDigest(digest);
        expect(bare).toMatch(/^[0-9a-f]{64}$/);
        expect(bare.startsWith("sha256:")).toBe(false);
        expect(prefixedDigest(bare)).toBe(digest);
      });

      test("each conversion refuses input already in its output spelling", async () => {
        const digest = chainEnvironmentRecordDigest(await loadChainGoldenBytes("closed-local"));
        expect(() => bareHexDigest(bareHexDigest(digest) as never)).toThrow();
        expect(() => prefixedDigest(digest)).toThrow();
      });

      test("a bare-hex digest in a record-body position is refused", async () => {
        expect(ChainEnvironmentRecordSchema.safeParse(await readAdversarialJson("digest-confusion-bare-hex")).success)
          .toBe(false);
      });
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(9);
      for (const entry of manifest.fixtures) {
        if (entry.expectedDisposition === "invalid-bytes") {
          const bytes = await readAdversarialBytes(entry.id);
          expect(() => parseChainEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
          continue;
        }
        const schema = entry.recordKind === "crypto-environment"
          ? CryptoEnvironmentRecordSchema
          : ChainEnvironmentRecordSchema;
        const accepted = schema.safeParse(await readAdversarialJson(entry.id)).success;
        expect(accepted, `${entry.id}: ${entry.description}`)
          .toBe(entry.expectedDisposition === "accepted");
      }
    });
  });
}
