// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createArtifactReference } from "@jinn-network/evidence-repository";
import { create as createKuboRPCClient } from "kubo-rpc-client";
import { describe, test } from "vitest";

import {
  IpfsEvidenceRepository,
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  buildArtifactRegistrationBytes,
  createKuboBlockReader,
  digestToRawCid,
  registrationCidForReference,
  type IpfsBlockReader,
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

      const countedClient = countCalls(client);
      const countedReader = countReader(
        createKuboBlockReader({ endpoint: configuredEndpoint }),
      );
      const repository = new IpfsEvidenceRepository({
        client: countedClient.value,
        reader: countedReader.value,
      });
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

      assert.ok(countedClient.callCount() > 0);
      assert.ok(countedReader.callCount() > 0);
      countedClient.reset();
      countedReader.reset();
      const oversized = new Uint8Array(
        MAX_STANDARD_IPFS_BLOCK_BYTES + 1,
      );
      await assert.rejects(
        repository.putArtifact(oversized),
        hasCode("CONTENT_TOO_LARGE"),
      );
      await assert.rejects(
        repository.putRecord("execution-evidence", oversized),
        hasCode("CONTENT_TOO_LARGE"),
      );
      assert.deepEqual(
        {
          readerCalls: countedReader.callCount(),
          rpcCalls: countedClient.callCount(),
        },
        { readerCalls: 0, rpcCalls: 0 },
      );
    });

    test("concurrent identical writes converge with explicit pins and exact readback", async () => {
      const configuredEndpoint = endpoint!;
      const client = createKuboRPCClient({
        url: new URL("/api/v0", configuredEndpoint),
      });
      const reader = createKuboBlockReader({ endpoint: configuredEndpoint });
      const repository = new IpfsEvidenceRepository({ client, reader });
      const bytes = new TextEncoder().encode(
        `real Kubo concurrent write ${expectedVersion}`,
      );

      const [left, right] = await Promise.all([
        repository.putArtifact(bytes),
        repository.putArtifact(bytes),
      ]);

      assert.deepEqual(left.reference, right.reference);
      assert.equal(left.contentCid, right.contentCid);
      assert.equal(left.registrationCid, right.registrationCid);
      assert.ok(
        left.status === "created" || right.status === "created",
        "at least one first writer must establish the registered object",
      );
      assert.deepEqual(await repository.getArtifact(left.reference), bytes);
      for (const cid of [left.contentCid, left.registrationCid]) {
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
    });

    test("repairs a pinned registration whose content block is absent", async () => {
      const configuredEndpoint = endpoint!;
      const client = createKuboRPCClient({
        url: new URL("/api/v0", configuredEndpoint),
      });
      const reader = createKuboBlockReader({
        endpoint: configuredEndpoint,
      });
      const repository = new IpfsEvidenceRepository({ client, reader });
      const bytes = new TextEncoder().encode(
        `registration-only recovery ${expectedVersion}`,
      );
      const reference = createArtifactReference(bytes);
      const registrationBytes = buildArtifactRegistrationBytes(reference);
      const expectedRegistrationCid =
        registrationCidForReference(reference);
      const registrationCid = await client.block.put(registrationBytes, {
        allowBigBlock: false,
        format: "raw",
        mhtype: "sha2-256",
        pin: true,
        version: 1,
      });
      assert.equal(
        digestToRawCid(
          `sha256:${Buffer.from(registrationCid.multihash.digest).toString("hex")}`,
        ),
        expectedRegistrationCid,
      );

      await assert.rejects(
        repository.getArtifact(reference),
        hasCode("CONTENT_CORRUPT"),
      );
      const receipt = await repository.putArtifact(bytes);
      assert.equal(receipt.status, "created");
      assert.deepEqual(await repository.getArtifact(reference), bytes);
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

function countCalls<T extends object>(target: T): {
  readonly callCount: () => number;
  readonly reset: () => void;
  readonly value: T;
} {
  let calls = 0;
  const proxies = new WeakMap<object, object>();
  const wrap = (value: object): object => {
    const existing = proxies.get(value);
    if (existing !== undefined) return existing;
    const proxy = new Proxy(value, {
      get(current, key) {
        const property = Reflect.get(current, key, current);
        if (typeof property === "function") {
          return (...args: unknown[]) => {
            calls += 1;
            return Reflect.apply(property, current, args);
          };
        }
        return typeof property === "object" && property !== null
          ? wrap(property)
          : property;
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return {
    callCount: () => calls,
    reset: () => {
      calls = 0;
    },
    value: wrap(target) as T,
  };
}

function countReader(reader: IpfsBlockReader): {
  readonly callCount: () => number;
  readonly reset: () => void;
  readonly value: IpfsBlockReader;
} {
  let calls = 0;
  return {
    callCount: () => calls,
    reset: () => {
      calls = 0;
    },
    value: {
      getBlock(cid, options) {
        calls += 1;
        return reader.getBlock(cid, options);
      },
    },
  };
}
