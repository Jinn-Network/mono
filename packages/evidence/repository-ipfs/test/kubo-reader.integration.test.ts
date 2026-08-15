// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { create as createKuboRPCClient } from "kubo-rpc-client";
import { describe, test } from "vitest";

import {
  createKuboBlockReader,
  digestToRawCid,
} from "../src/index.js";

const endpoint = process.env.JINN_KUBO_API_URL;
const expectedVersion = process.env.JINN_KUBO_EXPECTED_VERSION;
const ZERO_RAW_CID =
  "f015512200000000000000000000000000000000000000000000000000000000000000000";

describe.skipIf(endpoint === undefined || expectedVersion === undefined)(
  "real Kubo bounded-reader compatibility",
  () => {
    test("matches the pinned envelope and reads an exact raw block", async () => {
      const configuredEndpoint = endpoint!;
      const client = createKuboRPCClient({
        url: new URL("/api/v0", configuredEndpoint),
      });
      assert.equal((await client.version()).version, expectedVersion);

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

      const bytes = new TextEncoder().encode(
        `reader compatibility ${expectedVersion}`,
      );
      const cid = await client.block.put(bytes, {
        allowBigBlock: false,
        format: "raw",
        mhtype: "sha2-256",
        pin: false,
        version: 1,
      });
      const canonicalCid = digestToRawCid(
        `sha256:${Buffer.from(cid.multihash.digest).toString("hex")}`,
      );
      assert.deepEqual(
        await createKuboBlockReader({
          endpoint: configuredEndpoint,
        }).getBlock(canonicalCid, { maxBytes: bytes.byteLength }),
        bytes,
      );
    });
  },
);
