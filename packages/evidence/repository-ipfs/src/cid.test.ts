// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  IPFS_DAG_PB_CODEC,
  IPFS_RAW_CODEC,
  digestToRawCid,
  normalizeRawCid,
  parseIpfsCid,
  rawCidToDigest,
} from "./cid.js";

const EMPTY_DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_RAW_BASE16 =
  "f01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_RAW_BASE32 =
  "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const EMPTY_DAG_PB_BASE16 =
  "f01701220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_CID_V0 =
  "QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n";

describe("strict IPFS CID parsing", () => {
  test("accepts canonical CIDv0 and CIDv1 raw/DAG-PB SHA2-256 text", () => {
    const cidV0 = parseIpfsCid(EMPTY_CID_V0);
    const raw16 = parseIpfsCid(EMPTY_RAW_BASE16);
    const raw32 = parseIpfsCid(EMPTY_RAW_BASE32);
    const dagPb = parseIpfsCid(EMPTY_DAG_PB_BASE16);

    assert.deepEqual(cidV0, {
      version: 0,
      codec: IPFS_DAG_PB_CODEC,
      sha256Digest: Uint8Array.from(Buffer.from(EMPTY_DIGEST.slice(7), "hex")),
    });
    assert.deepEqual(raw16, {
      version: 1,
      codec: IPFS_RAW_CODEC,
      sha256Digest: Uint8Array.from(Buffer.from(EMPTY_DIGEST.slice(7), "hex")),
    });
    assert.deepEqual(raw32, raw16);
    assert.deepEqual(dagPb, {
      version: 1,
      codec: IPFS_DAG_PB_CODEC,
      sha256Digest: Uint8Array.from(Buffer.from(EMPTY_DIGEST.slice(7), "hex")),
    });

    raw16!.sha256Digest[0] = 0;
    assert.equal(parseIpfsCid(EMPTY_RAW_BASE16)!.sha256Digest[0], 0xe3);
  });

  test("rejects noncanonical aliases, malformed encodings, and varint drift", () => {
    for (const value of [
      EMPTY_RAW_BASE16.toUpperCase(),
      `F${EMPTY_RAW_BASE16.slice(1).toUpperCase()}`,
      `${EMPTY_RAW_BASE32}a`,
      `${EMPTY_RAW_BASE32.slice(0, -1)}v`,
      `f8100551220${EMPTY_DIGEST.slice(7)}`,
      `f01d5001220${EMPTY_DIGEST.slice(7)}`,
      `z${EMPTY_CID_V0}`,
      `${EMPTY_RAW_BASE16}00`,
      "not-a-cid",
      "",
    ]) {
      assert.equal(parseIpfsCid(value), null, value);
    }
  });
});

describe("repository raw CID profile", () => {
  test("maps repository digests reversibly to canonical lowercase base16", () => {
    assert.equal(digestToRawCid(EMPTY_DIGEST), EMPTY_RAW_BASE16);
    assert.equal(rawCidToDigest(EMPTY_RAW_BASE16), EMPTY_DIGEST);
    assert.equal(rawCidToDigest(EMPTY_RAW_BASE32), EMPTY_DIGEST);
    assert.equal(normalizeRawCid(EMPTY_RAW_BASE32), EMPTY_RAW_BASE16);
  });

  test("rejects valid CIDs outside CIDv1 raw SHA2-256", () => {
    for (const value of [EMPTY_CID_V0, EMPTY_DAG_PB_BASE16]) {
      assert.throws(
        () => rawCidToDigest(value),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "INVALID_REFERENCE",
      );
    }
  });

  test("rejects malformed repository digests", () => {
    for (const digest of [
      `sha256:${"a".repeat(63)}`,
      `sha256:${"a".repeat(65)}`,
      `sha256:${"A".repeat(64)}`,
      `${"a".repeat(64)}`,
    ]) {
      assert.throws(
        () => digestToRawCid(digest as `sha256:${string}`),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "INVALID_REFERENCE",
      );
    }
  });
});
