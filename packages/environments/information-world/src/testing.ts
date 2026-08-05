import { afterEach, describe, expect, test } from "vitest";

import {
  fixtureArtifactReader,
  loadAdversarialManifest,
  loadCorpusBody,
  loadEquivalenceExpectedDigest,
  loadEquivalenceInput,
  loadGoldenBytes,
  loadGoldenDigest,
  loadGoldenJson,
  loadRequestKeyVectors,
  readAdversarialJson,
  type GoldenName,
} from "./fixtures.js";
import { bareHexDigest, informationWorldRecordDigest } from "./hashing.js";
import { INFORMATION_WORLD_KIND, INFORMATION_WORLD_MEDIA_TYPE } from "./identifiers.js";
import {
  InvalidRequestError,
  canonicalRequestKey,
  canonicalRequestKeyFromParts,
} from "./request-key.js";
import { buildReplayIndex, CorpusIntegrityError } from "./replay.js";
import { InvalidDocumentError } from "./sealing.js";
import {
  InformationWorldRecordSchema,
  parseInformationWorldRecord,
  sealInformationWorldRecord,
  type InformationWorldRecord,
} from "./schema.js";
import { createReplayService, type ReplayService, type ReplayServiceOptions } from "./service.js";

const GOLDEN: readonly GoldenName[] = ["synthetic", "captured", "extension"];

/** Field names a sealed record must not carry: status is derived, never stored. */
const ABSENT_MUTABLE_STATUS_KEYS = ["status", "health", "ver" + "ified", "expiresAt"];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export type ReplayServiceFactory = (
  world: InformationWorldRecord,
  options: ReplayServiceOptions,
) => Promise<ReplayService>;

/**
 * Record conformance for the information-world kind: identifier pinning, schema validation,
 * producer-side re-seal, consumer-side digest checking without re-canonicalization, extension
 * round-tripping, the digest-confusion boundary, and the adversarial corpus.
 *
 * It asserts what the record is. It asserts nothing about whether any corpus corresponds to
 * any source — that is a declaration the record carries and this kit reads as a label.
 */
export function describeInformationWorldRecordConformance(): void {
  describe("Information world record conformance", () => {
    test("the pinned identifiers are exactly the design's strings", () => {
      expect(INFORMATION_WORLD_KIND).toBe("https://spec.jinn.network/records/information-world/v1");
      expect(INFORMATION_WORLD_MEDIA_TYPE)
        .toBe("application/vnd.jinn.information-world.v1+json");
    });

    describe.each(GOLDEN)("golden fixture: %s", (name) => {
      test("the schema accepts the sealed fixture document", async () => {
        expect(InformationWorldRecordSchema.safeParse(await loadGoldenJson(name)).success).toBe(true);
      });

      test("producer-side re-seal reproduces the pinned bytes and digest", async () => {
        const resealed = sealInformationWorldRecord(await loadGoldenJson(name));
        expect(decode(resealed)).toBe(decode(await loadGoldenBytes(name)));
        expect(informationWorldRecordDigest(resealed)).toBe(await loadGoldenDigest(name));
      });

      test("consumer-side digest over stored bytes matches without re-canonicalization", async () => {
        expect(informationWorldRecordDigest(await loadGoldenBytes(name)))
          .toBe(await loadGoldenDigest(name));
      });

      test("sealing is idempotent through a parse", async () => {
        const once = sealInformationWorldRecord(await loadGoldenJson(name));
        const twice = sealInformationWorldRecord(parseInformationWorldRecord(once));
        expect(decode(twice)).toBe(decode(once));
      });

      test("the record declares a miss policy, a key policy, and no mutable status", async () => {
        const record = parseInformationWorldRecord(await loadGoldenBytes(name));
        expect(record.missPolicy.status).toBeGreaterThan(0);
        expect(record.requestKeyPolicy.version).toBe("irk1");
        for (const key of ABSENT_MUTABLE_STATUS_KEYS) {
          expect(Object.hasOwn(record, key), `${key} must not exist on a sealed record`)
            .toBe(false);
        }
      });

      test("fidelity is declared, and provenance never claims more than a declaration", async () => {
        const record = parseInformationWorldRecord(await loadGoldenBytes(name));
        expect(["synthetic", "captured-snapshot"]).toContain(record.capture.fidelity);
        expect(record.capture.provenanceClass).toBe("declared");
        if (record.capture.fidelity === "synthetic") {
          expect(record.capture.capturer).toBeUndefined();
          expect(record.capture.sources).toBeUndefined();
        } else {
          expect(record.capture.capturer?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect((record.capture.sources ?? []).length).toBeGreaterThan(0);
        }
      });

      test("every stored request key re-derives from canonical request parts", async () => {
        const record = parseInformationWorldRecord(await loadGoldenBytes(name));
        for (const entry of record.corpus.entries) {
          expect(entry.requestKey).toBe(canonicalRequestKeyFromParts(
            entry.request,
            record.requestKeyPolicy,
          ));
        }
      });

      test("every corpus body matches its digest and declared size", async () => {
        const record = parseInformationWorldRecord(await loadGoldenBytes(name));
        const index = await buildReplayIndex(record, { artifacts: fixtureArtifactReader() });
        for (const entry of record.corpus.entries) {
          const expected = await loadCorpusBody(entry.response.body.digest);
          expect(expected.byteLength).toBe(entry.response.body.sizeBytes);
          expect(index.bodyOf(entry.requestKey)).toEqual(expected);
        }
      });
    });

    test("key-permuted inputs seal to one pinned digest", async () => {
      const expected = await loadEquivalenceExpectedDigest();
      for (const which of ["a", "b"] as const) {
        expect(informationWorldRecordDigest(
          sealInformationWorldRecord(await loadEquivalenceInput(which)),
        )).toBe(expected);
      }
    });

    test("non-canonical bytes are rejected rather than silently re-canonicalized", async () => {
      const pretty = new TextEncoder().encode(
        JSON.stringify(await loadGoldenJson("synthetic"), null, 2),
      );
      expect(() => parseInformationWorldRecord(pretty)).toThrow(InvalidDocumentError);
    });

    test("namespaced extension keys survive sealing and re-parsing", async () => {
      const record = parseInformationWorldRecord(await loadGoldenBytes("extension"));
      expect((record as Record<string, unknown>)["network.jinn.note"]).toBeDefined();
      expect(decode(sealInformationWorldRecord(record)))
        .toBe(decode(await loadGoldenBytes("extension")));
    });

    describe("digest confusion", () => {
      test("the record identity is sha256:-prefixed", async () => {
        expect(informationWorldRecordDigest(await loadGoldenBytes("synthetic")))
          .toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      test("bareHexDigest yields the DigestSet spelling: bare hex, no prefix", async () => {
        const digest = informationWorldRecordDigest(await loadGoldenBytes("synthetic"));
        expect(bareHexDigest(digest)).toMatch(/^[0-9a-f]{64}$/);
        expect(bareHexDigest(digest).startsWith("sha256:")).toBe(false);
      });

      test("a bare-hex value is refused where a prefixed one belongs", () => {
        expect(() => bareHexDigest("a".repeat(64) as never)).toThrow(InvalidDocumentError);
      });
    });

    describe("adversarial corpus", () => {
      test("seal-stage cases are refused at seal time", async () => {
        const manifest = await loadAdversarialManifest();
        const cases = manifest.cases.filter((entry) => entry.stage === "seal");
        expect(cases.length).toBeGreaterThanOrEqual(7);
        for (const item of cases) {
          const document = await readAdversarialJson(item.name);
          expect(() => sealInformationWorldRecord(document), `${item.name}: ${item.reason}`)
            .toThrow(InvalidDocumentError);
        }
      });

      test("every service-stage case seals but fails to materialize", async () => {
        const manifest = await loadAdversarialManifest();
        const cases = manifest.cases.filter((entry) => entry.stage === "service");
        expect(cases.length).toBeGreaterThan(0);
        for (const item of cases) {
          const bytes = sealInformationWorldRecord(await readAdversarialJson(item.name));
          await expect(
            buildReplayIndex(parseInformationWorldRecord(bytes), {
              artifacts: fixtureArtifactReader(),
            }),
            `${item.name}: ${item.reason}`,
          ).rejects.toBeInstanceOf(CorpusIntegrityError);
        }
      });

      test("none-stage cases seal and materialize as corpus data", async () => {
        const manifest = await loadAdversarialManifest();
        const cases = manifest.cases.filter((entry) => entry.stage === "none");
        expect(cases.length).toBeGreaterThanOrEqual(2);
        for (const item of cases) {
          const record = parseInformationWorldRecord(sealInformationWorldRecord(
            await readAdversarialJson(item.name),
          ));
          await expect(buildReplayIndex(record, { artifacts: fixtureArtifactReader() }), item.name)
            .resolves.toBeDefined();
        }
      });

      test("the unprovable-provenance case seals, and is labelled a declaration", async () => {
        const record = parseInformationWorldRecord(sealInformationWorldRecord(
          await readAdversarialJson("captured-provenance-unprovable"),
        ));
        expect(record.capture.fidelity).toBe("captured-snapshot");
        expect(record.capture.provenanceClass).toBe("declared");
      });
    });
  });
}

/** The determinism probe §5.1 step 6 names: equivalence under permutation. */
export function describeRequestKeyConformance(): void {
  describe("Canonical request key conformance", () => {
    test("every vector group produces its reviewed exact key without collisions", async () => {
      const vectors = await loadRequestKeyVectors();
      const groupKeys = new Map<string, string>();
      for (const group of vectors.groups) {
        const keys = new Set(group.requests.map((request) => canonicalRequestKey({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body === undefined
            ? undefined
            : new TextEncoder().encode(request.body),
        }, group.policy)));
        expect(keys.size, `${group.name} produced ${keys.size} keys`).toBe(1);
        const only = [...keys][0] as string;
        expect(only, `${group.name} diverged from its reviewed expected key`).toBe(group.expectedKey);
        expect(groupKeys.has(only), `${group.name} collides with ${groupKeys.get(only)}`)
          .toBe(false);
        groupKeys.set(only, group.name);
      }
    });

    test("every refusal vector is rejected before URL normalization can reinterpret it", async () => {
      const vectors = await loadRequestKeyVectors();
      for (const vector of vectors.refusals) {
        expect(() => canonicalRequestKey({
          method: vector.request.method,
          url: vector.request.url,
          headers: vector.request.headers,
          body: vector.request.body === undefined
            ? undefined
            : new TextEncoder().encode(vector.request.body),
        }, vector.policy), vector.name).toThrow(InvalidRequestError);
      }
    });
  });
}

/**
 * Replay conformance, driven through an injected factory so any implementation of the service
 * can be held to the same probes: byte-identical retrieval, the fail-closed miss, the
 * unreachable non-allowlisted origin, the bounded budget, and verbatim serving of corpus
 * content that carries instruction text.
 */
export function describeReplayServiceConformance(factory: ReplayServiceFactory): void {
  describe("Replay service conformance", () => {
    let service: ReplayService | undefined;
    afterEach(async () => {
      await service?.close();
      service = undefined;
    });

    const open = async (
      overrides: Partial<ReplayServiceOptions> = {},
    ): Promise<{ service: ReplayService; record: InformationWorldRecord }> => {
      const record = parseInformationWorldRecord(await loadGoldenBytes("synthetic"));
      const built = await factory(record, {
        artifacts: fixtureArtifactReader(),
        listen: { host: "127.0.0.1", port: 0 },
        ...overrides,
      });
      service = built;
      return { service: built, record };
    };

    const fetchOverLoopback = async (
      base: string,
      target: string,
      host: string,
      headers: Readonly<Record<string, readonly string[]>> = {},
    ): Promise<{ status: number; header: string | undefined; body: Uint8Array }> => {
      const { request } = await import("node:http");
      const url = new URL(base);
      const requestHeaders: Record<string, string | string[]> = { host };
      for (const [name, values] of Object.entries(headers)) requestHeaders[name] = [...values];
      return await new Promise((resolve, reject) => {
        const call = request({
          hostname: url.hostname,
          port: url.port,
          path: target,
          method: "GET",
          headers: requestHeaders,
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            header: response.headers["x-jinn-replay"] as string | undefined,
            body: new Uint8Array(Buffer.concat(chunks)),
          }));
        });
        call.once("error", reject);
        call.end();
      });
    };

    test("binds loopback and reports an assigned port", async () => {
      const { service: built } = await open();
      expect(built.address.host).toBe("127.0.0.1");
      expect(built.address.port).toBeGreaterThan(0);
    });

    test("every corpus entry is retrievable and byte-identical to its artifact", async () => {
      const { service: built, record } = await open();
      for (const entry of record.corpus.entries) {
        const target = `${entry.request.path}${entry.request.query.length === 0 ? "" : `?${
          entry.request.query.map((pair) =>
            (pair.length === 2 ? `${pair[0]}=${pair[1]}` : pair[0])).join("&")}`}`;
        const host = new URL(entry.request.origin).host;
        const response = await fetchOverLoopback(built.url, target, host, entry.request.headers);
        expect(response.status, `${entry.request.origin}${target}`)
          .toBe(entry.response.status);
        expect(response.body).toEqual(await loadCorpusBody(entry.response.body.digest));
      }
    });

    test("an uncaptured request yields the declared miss response, never a live fetch", async () => {
      const { service: built, record } = await open();
      const response = await fetchOverLoopback(built.url, "/definitely-not-captured", "api.example.test");
      expect(response.status).toBe(record.missPolicy.status);
      expect(response.header).toBe("miss");
      expect(new TextDecoder().decode(response.body)).toBe(record.missPolicy.body.inlineUtf8);
    });

    test("a non-allowlisted origin is unreachable", async () => {
      const { service: built } = await open({ allowlist: ["https://api.example.test"] });
      const response = await fetchOverLoopback(built.url, "/guide", "docs.example.test");
      expect(response.status).toBe(403);
      expect(response.header).toBe("off-allowlist");
      expect(built.stats().misses).toBe(0);
    });

    test("the request budget enforces", async () => {
      const { service: built } = await open({
        budget: { maxRequests: 1, maxResponseBytes: 10_000_000 },
      });
      const protocolHeaders = { accept: ["application/json"] };
      expect((await fetchOverLoopback(
        built.url,
        "/protocols",
        "api.example.test",
        protocolHeaders,
      )).status)
        .toBe(200);
      const second = await fetchOverLoopback(
        built.url,
        "/protocols",
        "api.example.test",
        protocolHeaders,
      );
      expect(second.status).toBe(429);
      expect(second.header).toBe("budget-exhausted");
    });

    test("corpus content carrying instruction text is served verbatim", async () => {
      const record = parseInformationWorldRecord(sealInformationWorldRecord(
        await readAdversarialJson("corpus-injected-instruction"),
      ));
      const built = await factory(record, {
        artifacts: fixtureArtifactReader(),
        listen: { host: "127.0.0.1", port: 0 },
      });
      service = built;
      const entry = record.corpus.entries[0] as InformationWorldRecord["corpus"]["entries"][number];
      const response = await fetchOverLoopback(
        built.url,
        entry.request.path,
        new URL(entry.request.origin).host,
        entry.request.headers,
      );
      expect(response.body).toEqual(await loadCorpusBody(entry.response.body.digest));
      expect(new TextDecoder().decode(response.body)).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    });
  });
}

/** The whole kit. Pass a factory to hold a substitute replay implementation to these probes. */
export function describeInformationWorldConformance(
  factory: ReplayServiceFactory = createReplayService,
): void {
  describeInformationWorldRecordConformance();
  describeRequestKeyConformance();
  describeReplayServiceConformance(factory);
}
