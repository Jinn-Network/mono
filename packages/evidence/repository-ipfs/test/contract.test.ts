// SPDX-License-Identifier: Apache-2.0

import {
  describeEvidenceRepositoryContract,
} from "@jinn-network/evidence-repository/testing";

import {
  IpfsEvidenceRepository,
  MAX_STANDARD_IPFS_BLOCK_BYTES,
} from "../src/index.js";
import {
  FakeIpfsBlockReader,
  FakeKubo,
} from "./fake-kubo.js";

describeEvidenceRepositoryContract(() => {
  const reader = new FakeIpfsBlockReader();
  return {
    createObjectAtDeclaredLimit: () =>
      new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES),
    createObjectAboveDeclaredLimit: () =>
      new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES + 1),
    repository: new IpfsEvidenceRepository({
      client: new FakeKubo(reader).asClient(),
      reader,
    }),
  };
});
