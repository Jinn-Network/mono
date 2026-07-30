import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { DsseSigner } from "./dsse.js";
import {
  AuthorizationStatementSchema,
  checkAttenuation,
  sealAuthorization,
  validateAuthorization,
} from "./authorization.js";

const fixedSigner: DsseSigner = async () => [
  { signature: new Uint8Array([7, 8, 9]), keyid: "did:key:z6MkfriendlyWorkingKey" },
];

const SUBJECT_DIGEST = "c".repeat(64);

const VALID_STATEMENT = {
  _type: "https://in-toto.io/Statement/v1" as const,
  subject: [{ name: "input-digest", digest: { sha256: SUBJECT_DIGEST } }],
  predicateType: "https://jinn.network/trust/authorization/v1" as const,
  predicate: {
    issuer: "urn:uuid:11111111-1111-4111-8111-111111111111",
    capabilities: ["deliveries:submit", "verdicts:read"],
    expiry: "2026-08-01T00:00:00Z",
    nonce: "n-1",
  },
};

function withCapabilities(capabilities: readonly string[]) {
  return {
    ...VALID_STATEMENT,
    predicate: { ...VALID_STATEMENT.predicate, capabilities: [...capabilities] },
  };
}

describe("AuthorizationStatementSchema / validateAuthorization", () => {
  test("a valid statement round-trips through sealAuthorization/validateAuthorization", async () => {
    const sealed = await sealAuthorization(VALID_STATEMENT, fixedSigner);
    const report = validateAuthorization(sealed.envelopeBytes);
    expect(report.conforms).toBe(true);
    expect(report.value?.predicate.issuer).toBe(VALID_STATEMENT.predicate.issuer);
  });

  test("a qualification-array-shaped capability fails schema (deliberate simplification of ReCap's att structure)", () => {
    const withArrayCapability = withCapabilities(["deliveries:submit"]);
    (withArrayCapability.predicate.capabilities as unknown[]).push(["qualified", "array"]);
    expect(AuthorizationStatementSchema.safeParse(withArrayCapability).success).toBe(false);
  });

  test("empty capabilities array fails schema", () => {
    expect(AuthorizationStatementSchema.safeParse(withCapabilities([])).success).toBe(false);
  });
});

describe("checkAttenuation", () => {
  test("a subset child attenuates validly", () => {
    const parent = withCapabilities(["deliveries:submit", "verdicts:read"]);
    const child = withCapabilities(["deliveries:submit"]);
    expect(checkAttenuation(child, parent)).toEqual({ valid: true });
  });

  test("a child adding a capability the parent lacks is invalid (widening)", () => {
    const parent = withCapabilities(["deliveries:submit"]);
    const child = withCapabilities(["deliveries:submit", "authorizations:grant"]);
    const result = checkAttenuation(child, parent);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("authorizations:grant");
  });

  test("a bare \"*\" capability is a literal string, not a wildcard -- fails subset unless the parent literally holds \"*\"", () => {
    const parent = withCapabilities(["deliveries:submit"]);
    const child = withCapabilities(["*"]);
    expect(checkAttenuation(child, parent).valid).toBe(false);

    const parentWithStar = withCapabilities(["*"]);
    expect(checkAttenuation(child, parentWithStar).valid).toBe(true);
  });
});

describe("sealAuthorization pinned-digest golden", () => {
  const goldenPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/authorization.json", import.meta.url),
  );
  const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf8"));

  const expectedDigestsPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/expected-digests.json", import.meta.url),
  );
  const expectedDigests: Record<string, string> = JSON.parse(
    readFileSync(expectedDigestsPath, "utf8"),
  );

  test("sealAuthorization produces bytes whose recordDigest matches the pinned golden digest", async () => {
    const sealed = await sealAuthorization(golden as never, fixedSigner);
    const expected = expectedDigests["authorization-golden"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "authorization-golden" yet -- actual digest: ${sealed.recordDigest}\n`
          + "Paste this into fixtures/sealing-v1/expected-digests.json and re-run.",
      );
    }
    expect(sealed.recordDigest).toBe(expected);
  });
});
