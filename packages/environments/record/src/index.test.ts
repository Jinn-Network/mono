import { describe, expect, test } from "vitest";

import * as api from "./index.js";

/** The program plan §4 pinned interface. Renaming any of these is a program-plan amendment. */
const PINNED = [
  "ENVIRONMENT_RECORD_KIND",
  "ENVIRONMENT_RECORD_MEDIA_TYPE",
  "CommandSpecSchema",
  "sealEnvironmentRecord",
  "parseEnvironmentRecord",
  "environmentRecordDigest",
] as const;

describe("public surface", () => {
  test("exports every pinned name from the program plan", () => {
    for (const name of PINNED) expect(api).toHaveProperty(name);
  });

  test("exports the schema, sealing primitives, and digest-conversion helper", () => {
    for (const name of [
      "ENVIRONMENT_RECORD_SCHEMA_ID",
      "EnvironmentRecordSchema",
      "EnvironmentSourceSchema",
      "EnvironmentImageSchema",
      "EnvironmentInvocationsSchema",
      "EnvironmentParserSchema",
      "EnvironmentBuildSchema",
      "EnvironmentRightsSchema",
      "EnvironmentLineageSchema",
      "REPRODUCIBILITY_TIERS",
      "SHELL_INTERPRETERS",
      "SHELL_METACHARACTERS",
      "InvalidDocumentError",
      "serializeCanonicalJson",
      "compareCodeUnitStrings",
      "sha256Hex",
      "bareHexDigest",
      "isNamespacedExtensionKey",
      "topLevelRecordSchema",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("sealEnvironmentRecord returns bytes, matching the pinned signature", () => {
    const sealed = api.sealEnvironmentRecord({
      kind: api.ENVIRONMENT_RECORD_KIND,
      source: { repo: "o/n", repoUrl: "https://github.com/o/n", commit: "0".repeat(40) },
      image: { manifestDigest: `sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
      workspace: "/testbed",
      invocations: { test: [{ bin: "make", args: ["test"] }] },
      parser: { id: "p", version: "1", digest: `sha256:${"c".repeat(64)}` },
      build: { reproducibilityTier: 0 },
      rights: { sourceLicense: "MIT" },
    });
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(api.environmentRecordDigest(sealed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("does not leak the testing kit or the fixture loaders through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeEnvironmentRecordConformance");
    expect(api).not.toHaveProperty("loadGoldenBytes");
  });
});
