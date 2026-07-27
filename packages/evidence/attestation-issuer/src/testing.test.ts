// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";

import {
  commitPreparedAttestation,
  prepareExecutionVerification,
  prepareResultEvaluation,
  type DsseSigner,
} from "./index.js";
import {
  describeAttestationIssuerIntegrationContract,
  type AttestationIssuerContractDriver,
} from "./testing.js";

const privateKey = createPrivateKey({
  key: Buffer.from(
    "MC4CAQAwBQYDK2VwBCIEIMdjss3q8ubQ//2idL/NwFmgYXUbIIOCadUMhRtPQEwJ",
    "base64",
  ),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);
const signer: DsseSigner = async ({ preAuthEncoding }) => [{
  keyid: "contract-test-ed25519",
  signature: sign(null, preAuthEncoding, privateKey),
}];
const signatureVerifier = ({ preAuthEncoding, signature }: {
  preAuthEncoding: Uint8Array;
  signature: Uint8Array;
}) => verify(null, preAuthEncoding, publicKey, signature);

const driver: AttestationIssuerContractDriver = {
  async issueResultEvaluation(input) {
    const repository = new InMemoryEvidenceRepository();
    const prepared = await prepareResultEvaluation(input, signer);
    const receipt = await commitPreparedAttestation(prepared, repository);
    return { prepared, receipt, repository, signatureVerifier };
  },
  async issueExecutionVerification(input) {
    const repository = new InMemoryEvidenceRepository();
    const prepared = await prepareExecutionVerification(input, signer);
    const receipt = await commitPreparedAttestation(prepared, repository);
    return { prepared, receipt, repository, signatureVerifier };
  },
};

describeAttestationIssuerIntegrationContract(() => driver);
