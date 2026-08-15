import { describe, expect, test } from "vitest";

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
import { informationWorldRecordDigest } from "./hashing.js";
import {
  InvalidRequestError,
  canonicalRequestKey,
  canonicalRequestKeyFromParts,
} from "./request-key.js";
import { InvalidDocumentError } from "./sealing.js";
import { parseInformationWorldRecord, sealInformationWorldRecord } from "./schema.js";
import { buildReplayIndex, CorpusIntegrityError } from "./replay.js";

const GOLDEN: readonly GoldenName[] = ["synthetic", "captured", "extension"];

describe.each(GOLDEN)("golden fixture: %s", (name) => {
  test("re-seals to the pinned bytes and the pinned digest", async () => {
    const bytes = await loadGoldenBytes(name);
    const resealed = sealInformationWorldRecord(await loadGoldenJson(name));
    expect(resealed).toEqual(bytes);
    expect(informationWorldRecordDigest(resealed)).toBe(await loadGoldenDigest(name));
  });

  test("every entry re-derives its declared key from canonical stored parts", async () => {
    const record = parseInformationWorldRecord(await loadGoldenBytes(name));
    for (const entry of record.corpus.entries) {
      expect(entry.requestKey).toMatch(/^irk1:[0-9a-f]{64}$/);
      expect(canonicalRequestKeyFromParts(entry.request, record.requestKeyPolicy))
        .toBe(entry.requestKey);
    }
  });

  test("every corpus body on disk hashes to its declared digest and size", async () => {
    const record = parseInformationWorldRecord(await loadGoldenBytes(name));
    const index = await buildReplayIndex(record, { artifacts: fixtureArtifactReader() });
    expect(index.world.corpus.entries.length).toBeGreaterThan(0);
    for (const entry of record.corpus.entries) {
      const body = await loadCorpusBody(entry.response.body.digest);
      expect(body.byteLength).toBe(entry.response.body.sizeBytes);
    }
  });
});

describe("equivalence corpus", () => {
  test("key-permuted twins seal to one pinned digest", async () => {
    const expected = await loadEquivalenceExpectedDigest();
    for (const which of ["a", "b"] as const) {
      expect(informationWorldRecordDigest(
        sealInformationWorldRecord(await loadEquivalenceInput(which)),
      )).toBe(expected);
    }
  });
});

describe("request-key vector corpus", () => {
  test("every same-key group collapses to one key, and groups never collide", async () => {
    const vectors = await loadRequestKeyVectors();
    expect(vectors.groups.length).toBeGreaterThanOrEqual(11);
    const groupKeys = new Set<string>();
    for (const group of vectors.groups) {
      const keys = new Set(group.requests.map((request) => canonicalRequestKey({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body === undefined ? undefined : new TextEncoder().encode(request.body),
      }, group.policy)));
      expect(keys.size, `${group.name}: ${[...keys].join(" ")}`).toBe(1);
      const only = [...keys][0] as string;
      expect(group.expectedKey, `${group.name} has no literal expected key`)
        .toMatch(/^irk1:[0-9a-f]{64}$/);
      expect(only, `${group.name} diverged from its reviewed expected key`)
        .toBe(group.expectedKey);
      expect(groupKeys.has(only), `${group.name} collides with another group`).toBe(false);
      groupKeys.add(only);
    }
  });

  test("every refusal vector is rejected before URL normalization can reinterpret it", async () => {
    const vectors = await loadRequestKeyVectors();
    expect(vectors.refusals.length).toBeGreaterThanOrEqual(2);
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

describe("adversarial corpus", () => {
  test("the manifest covers every case directory and names each outcome stage", async () => {
    const manifest = await loadAdversarialManifest();
    expect(manifest.cases.length).toBeGreaterThanOrEqual(11);
    for (const entry of manifest.cases) {
      expect(["seal", "service", "none"]).toContain(entry.stage);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("every seal-stage case is refused at seal time", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.cases) {
      if (entry.stage !== "seal") continue;
      const document = await readAdversarialJson(entry.name);
      expect(() => sealInformationWorldRecord(document), entry.name)
        .toThrow(InvalidDocumentError);
    }
  });

  test("each service-stage case seals but fails replay construction", async () => {
    const manifest = await loadAdversarialManifest();
    for (const entry of manifest.cases) {
      if (entry.stage !== "service") continue;
      const bytes = sealInformationWorldRecord(await readAdversarialJson(entry.name));
      await expect(buildReplayIndex(parseInformationWorldRecord(bytes), {
        artifacts: fixtureArtifactReader(),
      }), entry.name).rejects.toBeInstanceOf(CorpusIntegrityError);
    }
  });

  test("the unprovable-provenance case seals, and labels itself a declaration", async () => {
    const document = await readAdversarialJson("captured-provenance-unprovable");
    const record = parseInformationWorldRecord(sealInformationWorldRecord(document));
    expect(record.capture.fidelity).toBe("captured-snapshot");
    expect(record.capture.provenanceClass).toBe("declared");
  });

  test("the injected-instruction case seals and its body is served byte-for-byte", async () => {
    const document = await readAdversarialJson("corpus-injected-instruction");
    const record = parseInformationWorldRecord(sealInformationWorldRecord(document));
    const index = await buildReplayIndex(record, { artifacts: fixtureArtifactReader() });
    const entry = record.corpus.entries[0];
    expect(entry).toBeDefined();
    const served = index.bodyOf((entry as { requestKey: string }).requestKey);
    expect(served).toEqual(await loadCorpusBody(
      (entry as { response: { body: { digest: string } } }).response.body.digest,
    ));
    expect(new TextDecoder().decode(served)).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
  });
});
