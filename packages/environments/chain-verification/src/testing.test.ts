// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recoverEip191Address } from "@jinn-network/trust-core";
import type { DsseSigner } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { ChainEnvironmentVerificationPredicateSchema } from "./predicate.js";
import { describeChainVerificationConformance } from "./testing.js";

// Real, fixed secp256k1/EIP-191 signatures over the DSSE pre-authentication encoding.
// The kit holds no key material of its own; the host supplies both the signer and the
// verifier for its key type.
const eoa = createEoaTestSigner("chain-environment-verification-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

describeChainVerificationConformance({
  signer,
  verifySignature: ({ preAuthEncoding, signature, keyid }) =>
    recoverEip191Address(preAuthEncoding, signature).toLowerCase() === keyid?.toLowerCase(),
});

describe("predicate fixture corpus", () => {
  const root = fileURLToPath(new URL("../fixtures/predicate-v1/", import.meta.url));

  it("accepts the golden predicates", async () => {
    const closed = JSON.parse(await readFile(`${root}closed-reproducible.json`, "utf8")) as unknown;
    const archive = JSON.parse(await readFile(`${root}archive-observed.json`, "utf8")) as unknown;
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(closed).success).toBe(true);
    expect(ChainEnvironmentVerificationPredicateSchema.safeParse(archive).success).toBe(true);
  });

  it("rejects every adversarial predicate", async () => {
    const names = (await readdir(root)).filter((name) => name.startsWith("invalid-"));
    expect(names.length).toBe(7);
    for (const name of names) {
      const fixture = JSON.parse(await readFile(`${root}${name}`, "utf8")) as unknown;
      expect(
        ChainEnvironmentVerificationPredicateSchema.safeParse(fixture).success,
        `${name} must be rejected`,
      ).toBe(false);
    }
  });
});
