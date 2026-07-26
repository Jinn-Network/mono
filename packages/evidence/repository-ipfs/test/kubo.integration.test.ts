// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createArtifactReference } from "@jinn-network/evidence-repository";
import { create as createKuboRPCClient } from "kubo-rpc-client";
import { describe, test } from "vitest";

import {
  IpfsEvidenceRepository,
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  createKuboBlockReader,
  digestToRawCid,
  registrationCidForReference,
} from "../src/index.js";

const endpoint = process.env.JINN_KUBO_API_URL;
const expectedVersion = process.env.JINN_KUBO_EXPECTED_VERSION;
const ZERO_RAW_CID =
  "f015512200000000000000000000000000000000000000000000000000000000000000000";

describe.skipIf(endpoint === undefined || expectedVersion === undefined)(
  "real Kubo repository profile",
  () => {
    test("matches the pinned envelope and inclusive writer boundary", async () => {
      const configuredEndpoint = endpoint!;
      const client = createKuboRPCClient({
        url: new URL("/api/v0", configuredEndpoint),
      });
      let secondaryPinMutations = 0;
      const originalPinAdd = client.pin.add.bind(client.pin);
      client.pin.add = async (...args) => {
        secondaryPinMutations += 1;
        return originalPinAdd(...args);
      };
      const version = await client.version();
      assert.equal(version.version, expectedVersion);

      const missingUrl = new URL("/api/v0/block/get", configuredEndpoint);
      missingUrl.searchParams.set("arg", ZERO_RAW_CID);
      const missing = await fetch(missingUrl, { method: "POST" });
      assert.equal(missing.status, 500);
      assert.deepEqual(
        new Uint8Array(await missing.arrayBuffer()),
        new Uint8Array(
          await readFile(
            new URL(
              `./fixtures/kubo-v${expectedVersion}-not-found.json`,
              import.meta.url,
            ),
          ),
        ),
      );

      const reader = createKuboBlockReader({ endpoint: configuredEndpoint });
      const repository = new IpfsEvidenceRepository({ client, reader });
      const bytes = new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES);
      bytes[0] = Number(expectedVersion!.split(".")[1]);
      bytes[bytes.byteLength - 1] = 0xff;

      const receipt = await repository.putArtifact(bytes);
      assert.equal(receipt.status, "created");
      assert.deepEqual(await repository.getArtifact(receipt.reference), bytes);

      const reference = createArtifactReference(bytes);
      assert.equal(receipt.contentCid, digestToRawCid(reference.digest));
      assert.equal(
        receipt.registrationCid,
        registrationCidForReference(reference),
      );
      for (const cid of [receipt.contentCid, receipt.registrationCid]) {
        const pins = [];
        for await (const pin of client.pin.ls({
          paths: cid,
          type: "all",
        })) {
          pins.push(pin);
        }
        assert.equal(pins.length, 1);
        assert.equal(pins[0]!.type, "recursive");
      }
      assert.equal(secondaryPinMutations, 0);

      for await (const _ of client.repo.gc()) {
        // Exhaust the GC result stream before proving the explicit pins held.
      }
      assert.deepEqual(await repository.getArtifact(receipt.reference), bytes);
      assert.equal(secondaryPinMutations, 0);

      await assert.rejects(
        repository.putArtifact(
          new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES + 1),
        ),
        hasCode("CONTENT_TOO_LARGE"),
      );
    });
  },
);

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
