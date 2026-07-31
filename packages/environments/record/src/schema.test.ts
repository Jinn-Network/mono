import { describe, expect, test } from "vitest";

import { ENVIRONMENT_RECORD_KIND } from "./identifiers.js";
import { InvalidDocumentError } from "./sealing.js";
import { environmentRecordDigest } from "./hashing.js";
import {
  EnvironmentRecordSchema,
  parseEnvironmentRecord,
  sealEnvironmentRecord,
} from "./schema.js";

const MANIFEST = `sha256:${"a".repeat(64)}`;
const INDEX = `sha256:${"b".repeat(64)}`;
const PARSER = `sha256:${"c".repeat(64)}`;

const record = () => ({
  kind: ENVIRONMENT_RECORD_KIND,
  source: {
    repo: "owner/name",
    repoUrl: "https://github.com/owner/name",
    commit: "0".repeat(40),
  },
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `registry.test/owner/name@${MANIFEST}`,
    indexDigest: INDEX,
  },
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-q"] }],
  },
  parser: {
    id: "pytest-text",
    version: "1.0.0",
    digest: PARSER,
    uri: "https://example.test/parsers/pytest-text-1.0.0.tar.gz",
  },
  build: { reproducibilityTier: 0, provider: { id: "swe-rebench", version: "2" } },
  rights: { sourceLicense: "Apache-2.0", basis: "upstream-permissive-filter" },
  lineage: {
    upstream: { dataset: "nebius/SWE-rebench", revision: "main", keys: ["owner__name-1234"] },
  },
});

describe("environment record schema", () => {
  test("accepts a well-formed imported record", () => {
    expect(EnvironmentRecordSchema.safeParse(record()).success).toBe(true);
  });

  test("accepts a minimal record: no reference, no indexDigest, no lineage, no install", () => {
    const minimal = {
      kind: ENVIRONMENT_RECORD_KIND,
      source: record().source,
      image: { manifestDigest: MANIFEST, platform: "linux/amd64" },
      workspace: "/testbed",
      invocations: { test: [{ bin: "make", args: ["test"] }] },
      parser: { id: "pytest-text", version: "1.0.0", digest: PARSER },
      build: { reproducibilityTier: 0 },
      rights: { sourceLicense: "MIT" },
    };
    expect(EnvironmentRecordSchema.safeParse(minimal).success).toBe(true);
  });

  test("rejects an unknown kind literal", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), kind: "https://example.test/x/1.0" })
        .success,
    ).toBe(false);
  });

  test("rejects bare-hex digests in the record body", () => {
    const bare = record();
    bare.image.manifestDigest = "a".repeat(64);
    const result = EnvironmentRecordSchema.safeParse(bare);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("sha256:");
  });

  test("rejects an uppercase-hex or short digest", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, manifestDigest: `sha256:${"A".repeat(64)}` },
      }).success,
    ).toBe(false);
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, manifestDigest: "sha256:abcd" },
      }).success,
    ).toBe(false);
  });

  test("rejects a reference that does not end with @manifestDigest", () => {
    const drifted = record();
    drifted.image.reference = `registry.test/owner/name@${INDEX}`;
    const result = EnvironmentRecordSchema.safeParse(drifted);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("reference");
  });

  test("rejects a tag-only reference", () => {
    const tagged = record();
    tagged.image.reference = "registry.test/owner/name:latest";
    expect(EnvironmentRecordSchema.safeParse(tagged).success).toBe(false);
  });

  test("rejects an indexDigest equal to the manifestDigest", () => {
    const confused = record();
    confused.image.indexDigest = MANIFEST;
    const result = EnvironmentRecordSchema.safeParse(confused);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("indexDigest");
  });

  test("rejects an empty test invocation list — the declared scope cannot be empty", () => {
    const scopeless = record();
    scopeless.invocations.test = [];
    expect(EnvironmentRecordSchema.safeParse(scopeless).success).toBe(false);
  });

  test("rejects a shell-bearing invocation", () => {
    const shelly = record();
    shelly.invocations.test = [{ bin: "bash", args: ["-c", "pytest -q"] }];
    expect(EnvironmentRecordSchema.safeParse(shelly).success).toBe(false);
  });

  test("rejects a relative workspace", () => {
    expect(EnvironmentRecordSchema.safeParse({ ...record(), workspace: "testbed" }).success)
      .toBe(false);
  });

  test("rejects a platform that is not os/arch", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        image: { ...record().image, platform: "amd64" },
      }).success,
    ).toBe(false);
  });

  test("rejects a non-40-hex commit", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        source: { ...record().source, commit: "abc" },
      }).success,
    ).toBe(false);
  });

  test("requires build.recipe and build.dependencyPinning at reproducibility tier >= 1", () => {
    const tierOne = { ...record(), build: { reproducibilityTier: 1 } };
    const result = EnvironmentRecordSchema.safeParse(tierOne);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("recipe");

    const complete = {
      ...record(),
      build: {
        reproducibilityTier: 1,
        recipe: { name: "Dockerfile", digest: { sha256: "d".repeat(64) } },
        dependencyPinning: { mechanism: "pip-by-date", asOf: "2026-01-01T00:00:00Z" },
      },
    };
    expect(EnvironmentRecordSchema.safeParse(complete).success).toBe(true);
  });

  test("rejects a reproducibility tier outside 0..2", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), build: { reproducibilityTier: 3 } })
        .success,
    ).toBe(false);
  });

  test("rejects a parser without a digest, and accepts one without a uri", () => {
    const { uri: _uri, ...withoutUri } = record().parser;
    expect(EnvironmentRecordSchema.safeParse({ ...record(), parser: withoutUri }).success)
      .toBe(true);
    const { digest: _digest, ...withoutDigest } = record().parser;
    expect(EnvironmentRecordSchema.safeParse({ ...record(), parser: withoutDigest }).success)
      .toBe(false);
  });

  test("rejects inline parser source — a parser commits by digest, never by code", () => {
    expect(
      EnvironmentRecordSchema.safeParse({
        ...record(),
        parser: { ...record().parser, code: "print('hi')" },
      }).success,
    ).toBe(false);
  });

  test("accepts rights without basis and rejects an empty sourceLicense", () => {
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), rights: { sourceLicense: "MIT" } })
        .success,
    ).toBe(true);
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), rights: { sourceLicense: "" } }).success,
    ).toBe(false);
  });

  test("rejects a bare extension key and accepts a namespaced one", () => {
    expect(EnvironmentRecordSchema.safeParse({ ...record(), note: 1 }).success).toBe(false);
    expect(
      EnvironmentRecordSchema.safeParse({ ...record(), "network.jinn.note": "kept" }).success,
    ).toBe(true);
  });

  test("there is no status, health, or expiry field to set", () => {
    for (const key of ["status", "health", "expiresAt", "verified"]) {
      expect(
        EnvironmentRecordSchema.safeParse({ ...record(), [key]: "x" }).success,
        `${key} must not be accepted as a core field`,
      ).toBe(false);
    }
  });
});

describe("seal and parse", () => {
  test("sealEnvironmentRecord returns bytes; identity comes from environmentRecordDigest", () => {
    const bytes = sealEnvironmentRecord(record());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(environmentRecordDigest(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("sealing is deterministic and key-order independent", () => {
    const forward = sealEnvironmentRecord(record());
    const reversed = Object.fromEntries(Object.entries(record()).reverse());
    expect(environmentRecordDigest(sealEnvironmentRecord(reversed))).toBe(
      environmentRecordDigest(forward),
    );
  });

  test("parseEnvironmentRecord round-trips sealed bytes and preserves namespaced extras", () => {
    const bytes = sealEnvironmentRecord({ ...record(), "network.jinn.note": "kept" });
    const parsed = parseEnvironmentRecord(bytes);
    expect(parsed.kind).toBe(ENVIRONMENT_RECORD_KIND);
    expect((parsed as Record<string, unknown>)["network.jinn.note"]).toBe("kept");
  });

  test("parseEnvironmentRecord refuses re-canonicalized bytes", () => {
    const pretty = new TextEncoder().encode(JSON.stringify(record(), null, 2));
    expect(() => parseEnvironmentRecord(pretty)).toThrow(InvalidDocumentError);
  });

  test("sealing an invalid record throws InvalidDocumentError", () => {
    expect(() => sealEnvironmentRecord({ ...record(), kind: "nope" })).toThrow(
      InvalidDocumentError,
    );
  });

  test("sealing is idempotent through a parse", () => {
    const once = sealEnvironmentRecord(record());
    const twice = sealEnvironmentRecord(parseEnvironmentRecord(once));
    expect(environmentRecordDigest(twice)).toBe(environmentRecordDigest(once));
  });
});
