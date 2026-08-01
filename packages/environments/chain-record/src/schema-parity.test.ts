import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import {
  loadChainGoldenJson,
  loadCompositeGoldenJson,
  loadInvalidJson,
  loadPublishedSchema,
} from "./fixtures.js";
import { CHAIN_ENVIRONMENT_SCHEMA_ID, CRYPTO_ENVIRONMENT_SCHEMA_ID } from "./identifiers.js";
import { ChainEnvironmentRecordSchema } from "./chain-record.js";
import { CryptoEnvironmentRecordSchema } from "./composite.js";

const validator = async (name: "chain-environment" | "crypto-environment") =>
  new Ajv2020({ strict: false }).compile(await loadPublishedSchema(name));

describe("published JSON Schemas", () => {
  test("each declares its own kind's schema id", async () => {
    expect((await loadPublishedSchema("chain-environment")).$id).toBe(CHAIN_ENVIRONMENT_SCHEMA_ID);
    expect((await loadPublishedSchema("crypto-environment")).$id).toBe(CRYPTO_ENVIRONMENT_SCHEMA_ID);
  });

  test("accepts every chain golden under a standalone validator", async () => {
    const validate = await validator("chain-environment");
    for (const name of ["closed-anchored-subset", "closed-local", "archive-dependent"] as const) {
      expect(validate(await loadChainGoldenJson(name)), name).toBe(true);
    }
  });

  test("accepts every composite golden under a standalone validator", async () => {
    const validate = await validator("crypto-environment");
    for (const name of ["chain-only", "composed", "extension"] as const) {
      expect(validate(await loadCompositeGoldenJson(name)), name).toBe(true);
    }
  });

  test("rejects the structurally-expressible invalid fixtures on both surfaces", async () => {
    const validate = await validator("chain-environment");
    for (const name of ["bare-extension-key", "digest-confusion-bare-hex", "checksummed-address"]) {
      const document = await loadInvalidJson(name);
      expect(validate(document), `${name}: published schema`).toBe(false);
      expect(ChainEnvironmentRecordSchema.safeParse(document).success, `${name}: runtime`).toBe(false);
    }
  });

  test("a prefixed digest inside a ResourceDescriptor is refused on both surfaces", async () => {
    const document = await loadInvalidJson("digest-confusion-prefixed-descriptor");
    expect((await validator("chain-environment"))(document), "published schema").toBe(false);
    expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
  });

  describe("the top-level extension rule agrees on both surfaces", () => {
    const withKey = async (key: string) => ({
      ...(await loadChainGoldenJson("closed-local")) as Record<string, unknown>,
      [key]: "x",
    });

    test.each(["note", "network.jinn.x y", "http://example.test/ext a"])(
      "refuses the top-level key %j on both surfaces",
      async (key) => {
        const document = await withKey(key);
        expect((await validator("chain-environment"))(document), "published schema").toBe(false);
        expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
      },
    );

    test.each(["network.jinn.note", "http://example.test/ext"])(
      "accepts the top-level key %j on both surfaces",
      async (key) => {
        const document = await withKey(key);
        expect((await validator("chain-environment"))(document), "published schema").toBe(true);
        expect(ChainEnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(true);
      },
    );
  });

  // Where the two surfaces DIVERGE, on purpose, and the schema says so rather than pretending.
  test("documents every runtime-only check it cannot express", async () => {
    const chainComment = String((await loadPublishedSchema("chain-environment")).$comment);
    for (const phrase of [
      "source-coverage-incomplete",
      "initialStateCommitment",
      "sourceAnchor",
      "permittedChainId",
      "fixtureProbeCoverage",
      "well-known",
      "canonical",
    ]) {
      expect(chainComment, phrase).toContain(phrase);
    }
    const compositeComment = String((await loadPublishedSchema("crypto-environment")).$comment);
    for (const phrase of ["precedence", "endpointAllowlist", "requestBudget", "canonical"]) {
      expect(compositeComment, phrase).toContain(phrase);
    }
  });

  test("the cross-field cases the published schema cannot catch are still caught at runtime", async () => {
    for (const name of ["artifact-entry-uncovered", "anchor-root-as-initial-commitment", "well-known-fixture-address"]) {
      const document = await loadInvalidJson(name);
      expect((await validator("chain-environment"))(document), `${name}: structurally valid`).toBe(true);
      expect(ChainEnvironmentRecordSchema.safeParse(document).success, `${name}: runtime`).toBe(false);
    }
    const routing = await loadInvalidJson("origin-precedence-undeclared");
    expect((await validator("crypto-environment"))(routing)).toBe(true);
    expect(CryptoEnvironmentRecordSchema.safeParse(routing).success).toBe(false);
  });
});
