// SPDX-License-Identifier: Apache-2.0

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createEoaTestSigner } from "@jinn-network/trust-testing";
import {
  dssePreAuthEncoding,
  recoverEip191Address,
  type DsseSigner,
} from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import { EnvironmentVerificationPredicateSchema } from "./predicate.js";
import { describeEnvironmentVerificationConformance } from "./testing.js";

// Real, reproducible secp256k1/EIP-191 signatures over the DSSE
// pre-authentication encoding -- design §5.5 ("the kit exercises DSSE
// verification against trust/core test keys").
const eoa = createEoaTestSigner("environment-verification-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(
    request.preAuthEncoding
      ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes),
  ),
}];

describeEnvironmentVerificationConformance({
  signer,
  // The verification leg design §5.5 asks for: recover the signing address from
  // the kit's re-derived pre-authentication encoding and compare it against the
  // keyid the sealed envelope claims.
  verifySignature: ({ preAuthEncoding, signature, keyid }) =>
    recoverEip191Address(preAuthEncoding, signature) === keyid,
});

describe("predicate fixture corpus", () => {
  const root = fileURLToPath(new URL("../fixtures/predicate-v1/", import.meta.url));

  it("accepts the golden predicate", async () => {
    const golden = JSON.parse(await readFile(`${root}stable.json`, "utf8")) as unknown;
    expect(EnvironmentVerificationPredicateSchema.safeParse(golden).success).toBe(true);
  });

  it("rejects every adversarial predicate", async () => {
    const names = (await readdir(root)).filter((name) => name.startsWith("invalid-"));
    expect(names.length).toBe(4);
    for (const name of names) {
      const fixture = JSON.parse(await readFile(`${root}${name}`, "utf8")) as unknown;
      expect(
        EnvironmentVerificationPredicateSchema.safeParse(fixture).success,
        `${name} must be rejected`,
      ).toBe(false);
    }
  });
});
