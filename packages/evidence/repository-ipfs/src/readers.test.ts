// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, test } from "vitest";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  createGatewayBlockReader,
  createKuboBlockReader,
  digestToRawCid,
} from "./index.js";
import { ipfsDependencyError } from "./errors.js";
import {
  AUTHORITY_MARKER_TEXT,
  assertNoAuthorityMarkers,
  assertSanitizedDependencyError,
  createAuthorityBearingError,
} from "../test/authority-markers.js";

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

  test("counts branded stream chunks without consulting ordinary metadata or iterators", async () => {
    const chunk = new Uint8Array([0x61, 0x62, 0x63]);
    let hostileAccesses = 0;
    for (const key of ["byteLength", "length"] as const) {
      Object.defineProperty(chunk, key, {
        configurable: true,
        get() {
          hostileAccesses += 1;
          throw new Error(`ordinary ${key} access is forbidden`);
        },
      });
    }
    Object.defineProperty(chunk, Symbol.iterator, {
      configurable: true,
      get() {
        hostileAccesses += 1;
        throw new Error("ordinary iterator access is forbidden");
      },
    });
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => new Response(streamBytes([chunk])),
    });

    assert.deepEqual(
      await reader.getBlock(ABC_RAW_CID, { maxBytes: 3 }),
      new Uint8Array([0x61, 0x62, 0x63]),
    );
    assert.equal(hostileAccesses, 0);
  });

  test("rejects an intrinsically oversized branded chunk before copying it", async () => {
    const chunk = new Uint8Array([0x61, 0x62, 0x63, 0x64]);
    let hostileAccesses = 0;
    Object.defineProperty(chunk, "byteLength", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(chunk, Symbol.iterator, {
      configurable: true,
      get() {
        hostileAccesses += 1;
        throw new Error("ordinary iterator access is forbidden");
      },
    });
    let canceled = false;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
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
    assert.equal(hostileAccesses, 0);
    assert.equal(canceled, true);
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

  test("enforces the exact streamed 2 MiB boundary without Content-Length", async () => {
    const exactBytes = new Uint8Array(MAX_STANDARD_IPFS_BLOCK_BYTES);
    const exactCid = digestToRawCid(
      `sha256:${createHash("sha256").update(exactBytes).digest("hex")}`,
    );
    const exact = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(streamBytes([exactBytes]), { status: 200 }),
    });
    const accepted = await exact.getBlock(exactCid, {
      maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
    });
    assert.equal(accepted?.byteLength, MAX_STANDARD_IPFS_BLOCK_BYTES);

    let canceled = false;
    const oversized = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(exactBytes);
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200 },
        ),
    });
    await assert.rejects(
      oversized.getBlock(exactCid, {
        maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
      }),
      hasCode("CONTENT_TOO_LARGE"),
    );
    assert.equal(canceled, true);
  });

  test("rejects an oversized first chunk before copying or pulling again", async () => {
    let canceled = false;
    let reads = 0;
    const body = {
      getReader() {
        return {
          cancel() {
            canceled = true;
          },
          read() {
            reads += 1;
            if (reads > 1) {
              throw new Error("the reader must not pull a second chunk");
            }
            return Promise.resolve({
              done: false as const,
              value: new Uint8Array(
                MAX_STANDARD_IPFS_BLOCK_BYTES + 1,
              ),
            });
          },
          releaseLock() {},
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        ({
          body,
          headers: new Headers(),
          ok: true,
          status: 200,
        }) as Response,
    });

    await assert.rejects(
      Promise.race([
        reader.getBlock(EMPTY_RAW_CID, {
          maxBytes: MAX_STANDARD_IPFS_BLOCK_BYTES,
        }),
        rejectAfter(100, "oversized first chunk cancellation hung"),
      ]),
      hasCode("CONTENT_TOO_LARGE"),
    );
    assert.equal(canceled, true);
    assert.equal(reads, 1);
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

    for (const status of [408, 429, 500, 503]) {
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

  test("gives post-fetch cancellation precedence over every HTTP status", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      for (const status of [404, 500, 200]) {
        const controller = new AbortController();
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: async () => {
            controller.abort();
            return new Response(
              status === 200 ? new Uint8Array() : "response",
              { status },
            );
          },
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);

        await assert.rejects(
          reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 64,
            signal: controller.signal,
          }),
          hasCode("OPERATION_ABORTED"),
          `${kind} ${status}`,
        );
      }
    }
  });

  test("cancels post-fetch response bodies without displacing abort errors", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      for (const cancelFails of [false, true]) {
        const controller = new AbortController();
        let canceled = false;
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: async () => {
            controller.abort();
            return new Response(
              new ReadableStream({
                start(streamController) {
                  streamController.enqueue(new Uint8Array([0]));
                },
                cancel() {
                  canceled = true;
                  if (cancelFails) {
                    throw new Error("cancel failed");
                  }
                },
              }),
            );
          },
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);

        await assert.rejects(
          reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 64,
            signal: controller.signal,
          }),
          hasCode("OPERATION_ABORTED"),
          `${kind} cancelFails=${cancelFails}`,
        );
        assert.equal(canceled, true, `${kind} cancelFails=${cancelFails}`);
      }
    }
  });

  test("does not await never-settling post-fetch cancellation", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const controller = new AbortController();
      let canceled = false;
      const options = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: async () => {
          controller.abort();
          return new Response(
            new ReadableStream({
              start(streamController) {
                streamController.enqueue(new Uint8Array([0]));
              },
              cancel() {
                canceled = true;
                return new Promise<void>(() => {});
              },
            }),
          );
        },
      };
      const reader =
        kind === "Kubo"
          ? createKuboBlockReader(options)
          : createGatewayBlockReader(options);

      await assert.rejects(
        Promise.race([
          reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 64,
            signal: controller.signal,
          }),
          rejectAfter(100, `${kind} post-fetch cancellation hung`),
        ]),
        hasCode("OPERATION_ABORTED"),
        kind,
      );
      assert.equal(canceled, true, kind);
    }
  });

  test("cancels mid-stream caller aborts without displacing abort errors", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      for (const cancelFails of [false, true]) {
        const controller = new AbortController();
        let canceled = false;
        let pulls = 0;
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(streamController) {
                  pulls += 1;
                  if (pulls === 1) {
                    streamController.enqueue(new Uint8Array([1]));
                    return;
                  }
                  controller.abort();
                },
                cancel() {
                  canceled = true;
                  if (cancelFails) {
                    throw new Error("cancel failed");
                  }
                },
              }),
            ),
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);

        await assert.rejects(
          reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 64,
            signal: controller.signal,
          }),
          hasCode("OPERATION_ABORTED"),
          `${kind} cancelFails=${cancelFails}`,
        );
        assert.ok(pulls >= 2, kind);
        assert.equal(canceled, true, `${kind} cancelFails=${cancelFails}`);
      }
    }
  });

  test("races never-settling reads and cancellation against caller abort", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const controller = new AbortController();
      let canceled = false;
      let resolvePullStarted!: () => void;
      const pullStarted = new Promise<void>((resolve) => {
        resolvePullStarted = resolve;
      });
      const options = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                resolvePullStarted();
                return new Promise<void>(() => {});
              },
              cancel() {
                canceled = true;
                return new Promise<void>(() => {});
              },
            }),
          ),
      };
      const reader =
        kind === "Kubo"
          ? createKuboBlockReader(options)
          : createGatewayBlockReader(options);
      const pending = reader.getBlock(EMPTY_RAW_CID, {
        maxBytes: 64,
        signal: controller.signal,
      });
      await pullStarted;
      controller.abort();

      await assert.rejects(
        Promise.race([
          pending,
          rejectAfter(100, `${kind} pending read abort hung`),
        ]),
        hasCode("OPERATION_ABORTED"),
        kind,
      );
      assert.equal(canceled, true, kind);
    }
  });

  test("promptly aborts ignored fetches and observes their later rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const kind of ["Kubo", "gateway"] as const) {
        const controller = new AbortController();
        const tracked = trackAbortListeners(controller.signal);
        let rejectFetch!: (error: unknown) => void;
        let resolveFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => {
          resolveFetchStarted = resolve;
        });
        const ignoredFetch = new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        });
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: async () => {
            resolveFetchStarted();
            return ignoredFetch;
          },
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);
        const pending = reader.getBlock(EMPTY_RAW_CID, {
          maxBytes: 64,
          signal: tracked.signal,
        });
        await fetchStarted;
        controller.abort(createAuthorityBearingError("abort reason"));

        await assert.rejects(
          Promise.race([
            pending,
            rejectAfter(100, `${kind} ignored fetch abort hung`),
          ]),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              (error as Error & { code?: unknown }).code,
              "OPERATION_ABORTED",
            );
            assert.equal(error.cause, undefined);
            assertNoAuthorityMarkers(error);
            return true;
          },
          kind,
        );
        assert.equal(tracked.activeCount(), 0, kind);

        rejectFetch(createAuthorityBearingError("late fetch rejection"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, [], kind);
      }
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("cancels responses that fulfill after caller abort without awaiting cleanup", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const kind of ["Kubo", "gateway"] as const) {
        for (const cancelMode of ["reject", "never"] as const) {
          const controller = new AbortController();
          let resolveFetch!: (response: Response) => void;
          let resolveFetchStarted!: () => void;
          let resolveCancelStarted!: () => void;
          const fetchStarted = new Promise<void>((resolve) => {
            resolveFetchStarted = resolve;
          });
          const cancelStarted = new Promise<void>((resolve) => {
            resolveCancelStarted = resolve;
          });
          const ignoredFetch = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          });
          const options = {
            endpoint:
              kind === "Kubo"
                ? "http://127.0.0.1:5001"
                : "https://gateway.example.test",
            fetch: async () => {
              resolveFetchStarted();
              return ignoredFetch;
            },
          };
          const reader =
            kind === "Kubo"
              ? createKuboBlockReader(options)
              : createGatewayBlockReader(options);
          const pending = reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 64,
            signal: controller.signal,
          });
          await fetchStarted;
          controller.abort(createAuthorityBearingError("abort reason"));

          await assert.rejects(
            Promise.race([
              pending,
              rejectAfter(
                100,
                `${kind} ${cancelMode} primary abort hung`,
              ),
            ]),
            hasCode("OPERATION_ABORTED"),
            `${kind} ${cancelMode}`,
          );

          let cancelSawAbortedSignal = false;
          resolveFetch(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelSawAbortedSignal = controller.signal.aborted;
                  resolveCancelStarted();
                  return cancelMode === "reject"
                    ? Promise.reject(
                        createAuthorityBearingError(
                          "late response cancellation",
                        ),
                      )
                    : new Promise<void>(() => {});
                },
              }),
            ),
          );
          await Promise.race([
            cancelStarted,
            rejectAfter(
              100,
              `${kind} ${cancelMode} late response was not canceled`,
            ),
          ]);
          assert.equal(
            cancelSawAbortedSignal,
            true,
            `${kind} ${cancelMode}`,
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.deepEqual(unhandled, [], `${kind} ${cancelMode}`);
        }
      }
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("distinguishes dependency AbortError from an actual caller abort", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const dependencyAbort = new Error("transport timeout");
      dependencyAbort.name = "AbortError";
      const dependencyOptions = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: async () => {
          throw dependencyAbort;
        },
      };
      const dependencyReader =
        kind === "Kubo"
          ? createKuboBlockReader(dependencyOptions)
          : createGatewayBlockReader(dependencyOptions);
      await assert.rejects(
        dependencyReader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        hasCode("DEPENDENCY_UNAVAILABLE"),
        kind,
      );

      const controller = new AbortController();
      const callerReader =
        kind === "Kubo"
          ? createKuboBlockReader({
              ...dependencyOptions,
              fetch: async () => {
                controller.abort();
                throw dependencyAbort;
              },
            })
          : createGatewayBlockReader({
              ...dependencyOptions,
              fetch: async () => {
                controller.abort();
                throw dependencyAbort;
              },
            });
      await assert.rejects(
        callerReader.getBlock(EMPTY_RAW_CID, {
          maxBytes: 64,
          signal: controller.signal,
        }),
        hasCode("OPERATION_ABORTED"),
        kind,
      );
    }
  });

  test("sanitizes injected fetch failures without exposing request authority", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const injected = createAuthorityBearingError();
      const encodedMarker = encodeURIComponent(AUTHORITY_MARKER_TEXT);
      const endpoint =
        kind === "Kubo"
          ? `http://127.0.0.1:5001/${encodedMarker}`
          : `https://gateway.example.test/${encodedMarker}`;
      const reader =
        kind === "Kubo"
          ? createKuboBlockReader({
              endpoint,
              fetch: async () => {
                throw injected;
              },
            })
          : createGatewayBlockReader({
              endpoint,
              fetch: async () => {
                throw injected;
              },
            });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        (error: unknown) =>
          assertSanitizedDependencyError(
            error,
            "DEPENDENCY_UNAVAILABLE",
            "block-read",
            "unavailable",
          ),
        kind,
      );
    }
  });

  test("sanitizes injected response-stream failures", async () => {
    const injected = createAuthorityBearingError("stream failed");
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(injected);
            },
          }),
        ),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      (error: unknown) =>
        assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "block-read",
          "unavailable",
      ),
    );
  });

  test("reconstructs a stale package error rethrown by a response stream", async () => {
    const staleError = ipfsDependencyError(
      "DEPENDENCY_UNAVAILABLE",
      "An earlier IPFS block write was unavailable.",
      "block-write",
      "unavailable",
    );
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(staleError);
            },
          }),
        ),
    });
    let reconstructedError: unknown;
    try {
      await reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 });
    } catch (error) {
      reconstructedError = error;
    }

    assert.notEqual(reconstructedError, staleError);
    assertSanitizedDependencyError(
      reconstructedError,
      "DEPENDENCY_UNAVAILABLE",
      "block-read",
      "unavailable",
    );
  });

  test("sanitizes hostile response metadata, body, and reader surfaces", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly response: () => Response;
    }> = [
      {
        label: "status",
        response: () =>
          hostileResponse({
            status: hostileGetter("response status"),
          }),
      },
      {
        label: "ok",
        response: () =>
          hostileResponse({
            ok: hostileGetter("response ok"),
          }),
      },
      {
        label: "headers",
        response: () =>
          hostileResponse({
            headers: hostileGetter("response headers"),
          }),
      },
      {
        label: "headers.get",
        response: () =>
          hostileResponse({
            headers: hostileObjectProperty(
              "get",
              "headers get",
            ),
          }),
      },
      {
        label: "body",
        response: () =>
          hostileResponse({
            body: hostileGetter("response body"),
          }),
      },
      {
        label: "body.getReader",
        response: () =>
          hostileResponse({
            body: hostileObjectProperty(
              "getReader",
              "body getReader",
            ),
          }),
      },
      {
        label: "body.getReader()",
        response: () =>
          hostileResponse({
            body: {
              getReader() {
                throw createHostilePrototypeTrap("body reader call");
              },
            },
          }),
      },
    ];

    for (const item of cases) {
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => item.response(),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        (error: unknown) => {
          assert.equal(
            (error as { readonly code?: unknown }).code,
            "IO_FAILURE",
            item.label,
          );
          return assertSanitizedDependencyError(
            error,
            "IO_FAILURE",
            "block-read",
            "protocol-failure",
          );
        },
        item.label,
      );
    }
  });

  test("sanitizes hostile stream result and chunk inspection", async () => {
    for (const field of ["done", "value"] as const) {
      const result = new Proxy(
        {
          done: false,
          value: new Uint8Array(),
        },
        {
          get(target, key, receiver) {
            if (key === field) {
              throw createHostilePrototypeTrap(`stream ${field}`);
            }
            return Reflect.get(target, key, receiver);
          },
        },
      );
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () =>
          hostileResponse({
            body: {
              getReader() {
                return {
                  async cancel() {},
                  async read() {
                    return result;
                  },
                  releaseLock() {},
                };
              },
            },
          }),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        (error: unknown) =>
          assertSanitizedDependencyError(
            error,
            "DEPENDENCY_UNAVAILABLE",
            "block-read",
            "unavailable",
          ),
        field,
      );
    }
  });

  test("keeps cancellation authoritative when response cleanup is hostile", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const controller = new AbortController();
      const options = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: async () => {
          controller.abort(
            createAuthorityBearingError("hostile abort reason"),
          );
          return hostileResponse({
            body: hostileGetter("cancellation body"),
          });
        },
      };
      const reader =
        kind === "Kubo"
          ? createKuboBlockReader(options)
          : createGatewayBlockReader(options);

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, {
          maxBytes: 64,
          signal: controller.signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(
            (error as Error & { code?: unknown }).code,
            "OPERATION_ABORTED",
          );
          assert.equal(error.cause, undefined);
          assertNoAuthorityMarkers(error);
          return true;
        },
        kind,
      );
    }
  });

  test("does not expose injected errors or abort reasons on caller cancellation", async () => {
    const controller = new AbortController();
    const injected = createAuthorityBearingError("canceled fetch");
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => {
        controller.abort(createAuthorityBearingError("abort reason"));
        throw injected;
      },
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, {
        maxBytes: 64,
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: unknown }).code,
          "OPERATION_ABORTED",
        );
        assert.equal(error.cause, undefined);
        assertNoAuthorityMarkers(error);
        return true;
      },
    );
  });

  test("does not expose invalid endpoint text in validation errors", () => {
    let error: unknown;
    try {
      createGatewayBlockReader({
        endpoint: `not-a-url:${AUTHORITY_MARKER_TEXT}`,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(
      (error as Error & { code?: unknown }).code,
      "INVALID_REFERENCE",
    );
    assert.equal(error.cause, undefined);
    assertNoAuthorityMarkers(error);
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
  chunks: readonly (readonly number[] | Uint8Array)[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk),
        );
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

function rejectAfter(delayMs: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), delayMs);
  });
}

function trackAbortListeners(signal: AbortSignal): {
  readonly activeCount: () => number;
  readonly signal: AbortSignal;
} {
  const active = new Set<EventListenerOrEventListenerObject>();
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  Object.defineProperties(signal, {
    addEventListener: {
      configurable: true,
      value(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean,
      ) {
        if (type === "abort") active.add(listener);
        addEventListener(type, listener, options);
      },
    },
    removeEventListener: {
      configurable: true,
      value(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: EventListenerOptions | boolean,
      ) {
        if (type === "abort") active.delete(listener);
        removeEventListener(type, listener, options);
      },
    },
  });
  return {
    activeCount: () => active.size,
    signal,
  };
}

function createHostilePrototypeTrap(label: string): Error {
  return new Proxy(createAuthorityBearingError(label), {
    getPrototypeOf() {
      throw createAuthorityBearingError(`${label} prototype`);
    },
  });
}

function hostileGetter(label: string): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    get() {
      throw createHostilePrototypeTrap(label);
    },
  };
}

function hostileObjectProperty(
  key: string,
  label: string,
): object {
  return Object.defineProperty({}, key, hostileGetter(label));
}

function hostileResponse(
  overrides: Readonly<Record<string, unknown | PropertyDescriptor>>,
): Response {
  const response: Record<string, unknown> = {
    body: null,
    headers: new Headers(),
    ok: true,
    status: 200,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (isPropertyDescriptor(value)) {
      Object.defineProperty(response, key, value);
    } else {
      response[key] = value;
    }
  }
  return response as unknown as Response;
}

function isPropertyDescriptor(
  value: unknown,
): value is PropertyDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const getDescriptor = Object.getOwnPropertyDescriptor(value, "get");
  const setDescriptor = Object.getOwnPropertyDescriptor(value, "set");
  return (
    (getDescriptor !== undefined &&
      "value" in getDescriptor &&
      typeof getDescriptor.value === "function") ||
    (setDescriptor !== undefined &&
      "value" in setDescriptor &&
      typeof setDescriptor.value === "function")
  );
}
