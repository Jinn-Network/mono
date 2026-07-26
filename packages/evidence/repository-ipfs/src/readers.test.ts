// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "vitest";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  createGatewayBlockReader,
  createKuboBlockReader,
} from "./index.js";

const EMPTY_RAW_CID =
  "f01551220e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_RAW_CID =
  "f01551220ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ZERO_RAW_CID =
  "f015512200000000000000000000000000000000000000000000000000000000000000000";

describe("bounded IPFS block readers", () => {
  test("constructs exact Kubo and gateway raw-block requests", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ input, init });
      return new Response(new Uint8Array(), { status: 200 });
    };

    const kubo = createKuboBlockReader({
      endpoint: "http://127.0.0.1:5001",
      fetch,
    });
    const gateway = createGatewayBlockReader({
      endpoint: "https://gateway.example.test/content",
      fetch,
    });

    await kubo.getBlock(EMPTY_RAW_CID, { maxBytes: 0 });
    await gateway.getBlock(EMPTY_RAW_CID, { maxBytes: 0 });

    assert.equal(
      String(requests[0]!.input),
      `http://127.0.0.1:5001/api/v0/block/get?arg=${EMPTY_RAW_CID}`,
    );
    assert.equal(requests[0]!.init?.method, "POST");
    assert.equal(
      String(requests[1]!.input),
      `https://gateway.example.test/content/ipfs/${EMPTY_RAW_CID}?format=raw`,
    );
    assert.equal(requests[1]!.init?.method, "GET");
    assert.equal(
      new Headers(requests[1]!.init?.headers).get("accept"),
      "application/vnd.ipld.raw",
    );
  });

  test("accepts the inclusive delivered-byte limit without trusting Content-Length", async () => {
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(streamBytes([[0x61], [0x62, 0x63]]), {
          headers: { "content-length": "1" },
        }),
    });

    assert.deepEqual(
      await reader.getBlock(ABC_RAW_CID, { maxBytes: 3 }),
      new Uint8Array([0x61, 0x62, 0x63]),
    );
  });

  test("cancels before retaining a chunk that crosses the inclusive limit", async () => {
    let canceled = false;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x61, 0x62]));
              controller.enqueue(new Uint8Array([0x63, 0x64]));
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
    });

    await assert.rejects(
      reader.getBlock(ABC_RAW_CID, { maxBytes: 3 }),
      hasCode("CONTENT_TOO_LARGE"),
    );
    assert.equal(canceled, true);
  });

  test("rejects oversized Content-Length before pulling the response body", async () => {
    let readerAcquired = false;
    let canceled = false;
    const body = {
      async cancel() {
        canceled = true;
      },
      getReader() {
        readerAcquired = true;
        throw new Error("the body reader must not be acquired");
      },
    } as unknown as ReadableStream<Uint8Array>;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        ({
          body,
          headers: new Headers({ "content-length": "4" }),
          ok: true,
          status: 200,
        }) as Response,
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 3 }),
      hasCode("CONTENT_TOO_LARGE"),
    );
    assert.equal(readerAcquired, false);
    assert.equal(canceled, true);
  });

  test("never raises its accumulation ceiling above the fixed 2 MiB profile", async () => {
    let readerAcquired = false;
    let canceled = false;
    const body = {
      async cancel() {
        canceled = true;
      },
      getReader() {
        readerAcquired = true;
        throw new Error("the body reader must not be acquired");
      },
    } as unknown as ReadableStream<Uint8Array>;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        ({
          body,
          headers: new Headers({
            "content-length": String(MAX_STANDARD_IPFS_BLOCK_BYTES + 1),
          }),
          ok: true,
          status: 200,
        }) as Response,
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, {
        maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES + 1,
      }),
      hasCode("CONTENT_TOO_LARGE"),
    );
    assert.equal(readerAcquired, false);
    assert.equal(canceled, true);
  });

  test("distinguishes authoritative absence from outages and corruption", async () => {
    const gatewayMissing = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => new Response(null, { status: 404 }),
    });
    assert.equal(
      await gatewayMissing.getBlock(EMPTY_RAW_CID, { maxBytes: 1 }),
      null,
    );

    for (const status of [429, 500, 503]) {
      const unavailable = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => new Response("unavailable", { status }),
      });
      await assert.rejects(
        unavailable.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        hasCode("DEPENDENCY_UNAVAILABLE"),
      );
    }

    const corrupt = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => new Response(new Uint8Array([1])),
    });
    await assert.rejects(
      corrupt.getBlock(EMPTY_RAW_CID, { maxBytes: 1 }),
      hasCode("CONTENT_CORRUPT"),
    );
  });

  test("recognizes only exact pinned-version Kubo not-found envelopes", async () => {
    const fixtures = await Promise.all(
      ["0.32.1", "0.40.0", "0.42.0"].map(async (version) => ({
        body: await readFile(
          new URL(
            `../test/fixtures/kubo-v${version}-not-found.json`,
            import.meta.url,
          ),
          "utf8",
        ),
        version,
      })),
    );
    for (const fixture of fixtures) {
      const exact = createKuboBlockReader({
        endpoint: "http://127.0.0.1:5001",
        fetch: async () => new Response(fixture.body, { status: 500 }),
      });
      assert.equal(
        await exact.getBlock(ZERO_RAW_CID, { maxBytes: 1 }),
        null,
        fixture.version,
      );
    }

    const exactBody = fixtures[0]!.body;
    for (const body of [
      exactBody.replace(
        "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bafkreif2pall7dybz7vecqka3znoeir3aazbuglblf6jzmcd7zq7eak22m",
      ),
      exactBody.replace(',"Type":"error"', ',"Extra":true,"Type":"error"'),
      exactBody.replace(
        '"Message":',
        `"Message":"duplicate","Message":`,
      ),
      exactBody.replace('"Code":0', '"Code":"0"'),
      exactBody.replace('"Type":"error"', '"Type":"ERROR"'),
      exactBody.replace(
        '"Message":"block',
        '"Code":0,"Message":"block',
      ),
      '{"Message":"block was not found locally","Code":0,"Type":"error"}\n',
      "{malformed",
    ]) {
      const reader = createKuboBlockReader({
        endpoint: "http://127.0.0.1:5001",
        fetch: async () => new Response(body, { status: 500 }),
      });
      await assert.rejects(
        reader.getBlock(ZERO_RAW_CID, { maxBytes: 1 }),
        hasCode("DEPENDENCY_UNAVAILABLE"),
        body,
      );
    }
  });

  test("bounds Kubo error bodies independently", async () => {
    let canceled = false;
    const reader = createKuboBlockReader({
      endpoint: "http://127.0.0.1:5001",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
              controller.enqueue(new Uint8Array([0]));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 500 },
        ),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 1 }),
      hasCode("DEPENDENCY_UNAVAILABLE"),
    );
    assert.equal(canceled, true);
  });

  test("maps denial and caller cancellation without accepting credential options", async () => {
    for (const status of [401, 403]) {
      const denied = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => new Response("denied", { status }),
      });
      await assert.rejects(
        denied.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        hasCode("ACCESS_DENIED"),
      );
    }

    const controller = new AbortController();
    controller.abort();
    const aborted = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => {
        throw new Error("fetch must not run");
      },
    });
    await assert.rejects(
      aborted.getBlock(EMPTY_RAW_CID, {
        maxBytes: 1,
        signal: controller.signal,
      }),
      hasCode("OPERATION_ABORTED"),
    );
  });

  test("rejects unsafe endpoints and raw-profile-invalid CIDs before fetch", async () => {
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      return new Response(new Uint8Array());
    };

    for (const endpoint of [
      "https://user:password@example.test",
      "https://example.test?token=secret",
      "https://example.test/#fragment",
      "ftp://example.test",
    ]) {
      assert.throws(
        () => createKuboBlockReader({ endpoint, fetch }),
        hasCode("INVALID_REFERENCE"),
      );
    }

    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch,
    });
    await assert.rejects(
      reader.getBlock(
        "QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n",
        { maxBytes: 64 },
      ),
      hasCode("INVALID_REFERENCE"),
    );
    assert.equal(calls, 0);
  });
});

function streamBytes(
  chunks: readonly (readonly number[])[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(Uint8Array.from(chunk));
      }
      controller.close();
    },
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
