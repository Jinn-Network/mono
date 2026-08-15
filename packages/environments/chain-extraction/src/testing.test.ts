// SPDX-License-Identifier: Apache-2.0

import { dssePreAuthEncoding, type DsseSigner } from "@jinn-network/trust-core";
import { createEoaTestSigner } from "@jinn-network/trust-testing";

import { describeChainExtractionConformance } from "./testing.js";

// Real deterministic secp256k1/EIP-191 signatures: the loop's converged result carries
// CE3's real sealed attestation, not a stub.
const eoa = createEoaTestSigner("chain-extraction-conformance");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(
    request.preAuthEncoding ?? dssePreAuthEncoding(request.payloadType, request.payloadBytes),
  ),
}];

describeChainExtractionConformance({ signer });
