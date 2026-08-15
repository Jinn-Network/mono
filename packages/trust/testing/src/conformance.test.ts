// SPDX-License-Identifier: Apache-2.0

import { describeTrustVerificationContract } from "./conformance.js";
import { createFakeResolvers } from "./fakes.js";
import type { TrustVerificationContractContext } from "./conformance.js";

describeTrustVerificationContract((): TrustVerificationContractContext => {
  const fakes = createFakeResolvers();
  return {
    bindingResolver: fakes.bindingResolver,
    witnessVerifier: fakes.witnessVerifier,
    dsseVerifier: fakes.dsseVerifier,
    seedBinding: fakes.registerBinding,
    seedWitnessResult: fakes.registerWitnessResult,
  };
});
