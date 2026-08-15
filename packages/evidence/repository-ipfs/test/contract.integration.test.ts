// SPDX-License-Identifier: Apache-2.0

import {
  describeEvidenceRepositoryContract,
} from "@jinn-network/evidence-repository/testing";
import { create as createKuboRPCClient } from "kubo-rpc-client";
import { describe, test } from "vitest";

import {
  IpfsEvidenceRepository,
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  createKuboBlockReader,
} from "../src/index.js";

const endpoint = process.env.JINN_KUBO_API_URL;

if (endpoint === undefined) {
  describe.skip("EvidenceRepository contract against real Kubo", () => {
    test("requires JINN_KUBO_API_URL", () => {});
  });
} else {
  describeEvidenceRepositoryContract(() => ({
    createObjectAtDeclaredLimit: () =>
      new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES),
    createObjectAboveDeclaredLimit: () =>
      new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES + 1),
    repository: new IpfsEvidenceRepository({
      client: createKuboRPCClient({
        url: new URL("/api/v0", endpoint),
      }),
      reader: createKuboBlockReader({ endpoint }),
    }),
  }));
}
