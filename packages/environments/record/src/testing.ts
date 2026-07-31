import { describe, expect, test } from "vitest";

import {
  type GoldenName,
  loadAdversarialManifest,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  readAdversarialBytes,
  readAdversarialJson,
} from "./fixtures.js";
import { bareHexDigest, environmentRecordDigest } from "./hashing.js";
import { ENVIRONMENT_RECORD_KIND, ENVIRONMENT_RECORD_MEDIA_TYPE } from "./identifiers.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const GOLDEN: readonly GoldenName[] = ["imported", "tier-1", "extension"];
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Record conformance for the environment kind: identifier pinning, schema validation,
 * producer-side re-seal, consumer-side digest checking without re-canonicalization,
 * extension round-tripping, the digest-confusion boundary, and the adversarial corpus.
 *
 * Any implementation that produces or consumes environment records runs this driver to
 * prove it reproduces the frozen record surface. It asserts what the record *is*; it
 * asserts nothing about whether any environment works — that claim lives in separately
 * published verification attestations and is bounded there.
 */
export function describeEnvironmentRecordConformance(): void {
  describe("Environment record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(ENVIRONMENT_RECORD_KIND).toBe("https://jinn.network/records/environment/1.0");
      expect(ENVIRONMENT_RECORD_MEDIA_TYPE).toBe("application/vnd.jinn.environment.v1+json");
    });

    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("parses under the record schema", async () => {
        expect(EnvironmentRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const pinnedBytes = await loadGoldenBytes(name);
        const pinnedDigest = await loadGoldenDigest(name);
        const resealed = sealEnvironmentRecord(await loadGoldenJson(name));
        expect(decode(resealed)).toBe(decode(pinnedBytes));
        expect(environmentRecordDigest(resealed)).toBe(pinnedDigest);
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(environmentRecordDigest(await loadGoldenBytes(name))).toBe(
          await loadGoldenDigest(name),
        );
      });

      test("sealing is idempotent through a parse", async () => {
        const once = sealEnvironmentRecord(await loadGoldenJson(name));
        const twice = sealEnvironmentRecord(parseEnvironmentRecord(once));
        expect(environmentRecordDigest(twice)).toBe(environmentRecordDigest(once));
      });

      test("the record declares a test scope and no mutable status", async () => {
        const record = parseEnvironmentRecord(await loadGoldenBytes(name));
        expect(record.invocations.test.length).toBeGreaterThan(0);
        for (const key of ["status", "health", "expiresAt", "verified"]) {
          expect(Object.hasOwn(record, key), `${key} must not exist on a sealed record`).toBe(false);
        }
      });

      test("every command in the record is shell-free", async () => {
        const record = parseEnvironmentRecord(await loadGoldenBytes(name));
        for (const command of [...(record.invocations.install ?? []), ...record.invocations.test]) {
          expect(Object.hasOwn(command, "shell")).toBe(false);
          expect(command.bin).not.toMatch(/^(\/.*\/)?(ba|z|da|k|c|tc|fi)?sh$/);
          expect(command.args.some((arg) => arg === "-c")).toBe(false);
        }
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("a")))).toBe(expected);
      expect(environmentRecordDigest(sealEnvironmentRecord(await loadEquivalenceInput("b")))).toBe(expected);
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const pretty = new TextEncoder().encode(
        JSON.stringify(await loadGoldenJson("imported"), null, 2),
      );
      expect(() => parseEnvironmentRecord(pretty)).toThrow();
    });

    test("namespaced extension keys survive sealing and re-parsing", async () => {
      const record = parseEnvironmentRecord(await loadGoldenBytes("extension"));
      expect((record as Record<string, unknown>)["network.jinn.note"]).toBeDefined();
      const resealed = sealEnvironmentRecord(record);
      expect(decode(resealed)).toBe(decode(await loadGoldenBytes("extension")));
    });

    // Digest confusion, both directions (program §5 contract 6). Record-body digests are
    // `sha256:`-prefixed; in-toto DigestSet subject values are bare hex. Mixing them is the
    // single most likely wiring error at the record/attestation boundary.
    describe("digest confusion", () => {
      test("the record identity is sha256:-prefixed", async () => {
        expect(environmentRecordDigest(await loadGoldenBytes("imported"))).toMatch(
          /^sha256:[0-9a-f]{64}$/,
        );
      });

      test("bareHexDigest yields the DigestSet spelling: bare hex, no prefix", async () => {
        const digest = environmentRecordDigest(await loadGoldenBytes("imported"));
        const bare = bareHexDigest(digest);
        expect(bare).toMatch(/^[0-9a-f]{64}$/);
        expect(bare.startsWith("sha256:")).toBe(false);
        expect(`sha256:${bare}`).toBe(digest);
      });

      test("bareHexDigest refuses an already-bare value rather than passing it through", async () => {
        const bare = bareHexDigest(environmentRecordDigest(await loadGoldenBytes("imported")));
        expect(() => bareHexDigest(bare as never)).toThrow();
      });

      test("a bare-hex digest inside the record body is refused", async () => {
        expect(
          EnvironmentRecordSchema.safeParse(await readAdversarialJson("bare-hex-manifest-digest"))
            .success,
        ).toBe(false);
      });
    });

    test("the adversarial corpus behaves exactly as its manifest declares", async () => {
      const manifest = await loadAdversarialManifest();
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(7);
      for (const entry of manifest.fixtures) {
        if (entry.expectedDisposition === "invalid-bytes") {
          const bytes = await readAdversarialBytes(entry.id);
          expect(() => parseEnvironmentRecord(bytes), `${entry.id}: ${entry.description}`).toThrow();
          continue;
        }
        const accepted = EnvironmentRecordSchema.safeParse(await readAdversarialJson(entry.id)).success;
        expect(accepted, `${entry.id}: ${entry.description}`).toBe(
          entry.expectedDisposition === "accepted",
        );
      }
    });
  });
}
