// SPDX-License-Identifier: Apache-2.0

export { recordDigest } from "@jinn-network/trust-core";
export {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
} from "./did-key.js";
export {
  createDidKeyDsseVerifier,
  verifyDsseSignatures,
  verifyEd25519Signature,
} from "./dsse.js";
export type { DsseVerificationKey, VerifyDsseSignaturesOptions } from "./dsse.js";
