// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, test } from "vitest";

import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";

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

  test("adopts only exact native fetch Promises without consulting hostile surfaces", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      let nativeThenAccesses = 0;
      const nativeResult = Promise.resolve(
        new Response(new Uint8Array()),
      );
      Object.defineProperty(nativeResult, "then", {
        configurable: true,
        get() {
          nativeThenAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} native fetch own then`,
          );
        },
      });
      const acceptedOptions = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: (() => nativeResult) as typeof globalThis.fetch,
      };
      const accepted =
        kind === "Kubo"
          ? createKuboBlockReader(acceptedOptions)
          : createGatewayBlockReader(acceptedOptions);
      assert.deepEqual(
        await accepted.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
        new Uint8Array(),
        kind,
      );
      assert.equal(nativeThenAccesses, 0, kind);

      let thenableAccesses = 0;
      const thenable = Object.defineProperty({}, "then", {
        configurable: true,
        get() {
          thenableAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} fetch thenable`,
          );
        },
      });
      let proxyAccesses = 0;
      const promiseProxy = new Proxy(
        Promise.resolve(new Response(new Uint8Array())),
        {
          get() {
            proxyAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} fetch Promise Proxy`,
            );
          },
        },
      );
      let foreignThenAccesses = 0;
      const foreignPromise = runInNewContext(
        "Promise.resolve(null)",
      ) as object;
      Object.defineProperty(foreignPromise, "then", {
        configurable: true,
        get() {
          foreignThenAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} foreign fetch Promise`,
          );
        },
      });
      let subclassThenAccesses = 0;
      class FetchPromiseSubclass<T> extends Promise<T> {}
      Object.defineProperty(FetchPromiseSubclass.prototype, "then", {
        configurable: true,
        get() {
          subclassThenAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} fetch Promise subclass`,
          );
        },
      });
      const subclassPromise = new FetchPromiseSubclass<Response>(
        (resolve) => resolve(new Response(new Uint8Array())),
      );
      let constructorAccesses = 0;
      const mutableConstructorPromise = Promise.resolve(
        new Response(new Uint8Array()),
      );
      Object.defineProperty(mutableConstructorPromise, "constructor", {
        configurable: true,
        get() {
          constructorAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} fetch Promise constructor`,
          );
        },
      });
      const malformed: ReadonlyArray<{
        readonly label: string;
        readonly value: unknown;
      }> = [
        {
          label: `${kind} synchronous fetch result`,
          value: new Response(new Uint8Array()),
        },
        { label: `${kind} fetch thenable`, value: thenable },
        { label: `${kind} fetch Promise Proxy`, value: promiseProxy },
        { label: `${kind} foreign fetch Promise`, value: foreignPromise },
        {
          label: `${kind} fetch Promise subclass`,
          value: subclassPromise,
        },
        {
          label: `${kind} fetch Promise constructor`,
          value: mutableConstructorPromise,
        },
      ];
      for (const item of malformed) {
        const malformedOptions = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: (() => item.value) as typeof globalThis.fetch,
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(malformedOptions)
            : createGatewayBlockReader(malformedOptions);
        await assert.rejects(
          reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
          assertFrozenProtocolFailure,
          item.label,
        );
      }
      const synchronousThrowOptions = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: (() => {
          throw createAuthorityBearingError(
            `${kind} synchronous fetch throw`,
          );
        }) as typeof globalThis.fetch,
      };
      const synchronousThrowReader =
        kind === "Kubo"
          ? createKuboBlockReader(synchronousThrowOptions)
          : createGatewayBlockReader(synchronousThrowOptions);
      await assert.rejects(
        synchronousThrowReader.getBlock(EMPTY_RAW_CID, {
          maxBytes: 0,
        }),
        assertFrozenProtocolFailure,
        `${kind} synchronous fetch throw`,
      );
      assert.equal(thenableAccesses, 0, kind);
      assert.equal(proxyAccesses, 0, kind);
      assert.equal(foreignThenAccesses, 0, kind);
      assert.equal(subclassThenAccesses, 0, kind);
      assert.equal(constructorAccesses, 0, kind);
    }
  });

  test("keeps settled fetch and read values nested in inert records across async hops", async () => {
    for (const withSignal of [false, true]) {
      let thenCalls = 0;
      let restorePrototypeThen = () => {};
      const settledRead = Promise.resolve({ done: true as const });
      const response = responseWithReader({
        read() {
          return settledRead;
        },
        releaseLock() {
          restorePrototypeThen();
        },
      });
      const settledFetch = Promise.resolve(response);
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: (() => settledFetch) as typeof globalThis.fetch,
      });
      const previousThen = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "then",
      );
      restorePrototypeThen = () => {
        if (previousThen === undefined) {
          delete (Object.prototype as { then?: unknown }).then;
        } else {
          Object.defineProperty(Object.prototype, "then", previousThen);
        }
      };
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        value(
          _resolve: (value: unknown) => void,
          reject: (error: unknown) => void,
        ) {
          thenCalls += 1;
          reject("late Object.prototype.then adoption");
        },
      });
      try {
        assert.deepEqual(
          await reader.getBlock(EMPTY_RAW_CID, {
            maxBytes: 0,
            ...(withSignal
              ? { signal: new AbortController().signal }
              : {}),
          }),
          new Uint8Array(),
          `withSignal=${withSignal}`,
        );
        assert.equal(thenCalls, 0, `withSignal=${withSignal}`);
      } finally {
        restorePrototypeThen();
      }
    }
  });

  test("does not re-assimilate settled response objects with hostile then surfaces", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      for (const placement of ["own", "prototype"] as const) {
        let thenAccesses = 0;
        const response = hostileResponse({
          status: kind === "Kubo" ? 401 : 404,
        });
        const fetchResult = Promise.resolve(response);
        const hostileThen = {
          configurable: true,
          get() {
            thenAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} response ${placement} then`,
            );
          },
        };
        if (placement === "own") {
          Object.defineProperty(response, "then", hostileThen);
        } else {
          Object.setPrototypeOf(
            response,
            Object.defineProperty({}, "then", hostileThen),
          );
        }
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: (() => fetchResult) as typeof globalThis.fetch,
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);
        if (kind === "Kubo") {
          await assert.rejects(
            reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
            hasCode("ACCESS_DENIED"),
            placement,
          );
        } else {
          assert.equal(
            await reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
            null,
            placement,
          );
        }
        assert.equal(thenAccesses, 0, `${kind} ${placement}`);
      }
    }
  });

  test("snapshots response cancellation without invoking overrideable cleanup surfaces", async () => {
    let nativeBodyAccesses = 0;
    let nativeCanceled = false;
    const nativeResponse = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          nativeCanceled = true;
        },
      }),
      { status: 404 },
    );
    Object.defineProperty(nativeResponse, "body", {
      configurable: true,
      get() {
        nativeBodyAccesses += 1;
        throw createAuthorityBearingError(
          "native Response own body override",
        );
      },
    });
    const nativeReader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: (() =>
        Promise.resolve(nativeResponse)) as typeof globalThis.fetch,
    });
    assert.equal(
      await nativeReader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
      null,
    );
    assert.equal(nativeBodyAccesses, 0);
    assert.equal(nativeCanceled, true);

    for (const kind of ["Kubo", "gateway"] as const) {
      let responseBodyAccessorCalls = 0;
      let bodyProxyAccesses = 0;
      let cancelAccessorCalls = 0;
      let cancelProxyCalls = 0;
      let arbitraryThenAccesses = 0;
      const cleanupBodies: ReadonlyArray<{
        readonly body: unknown | PropertyDescriptor;
        readonly label: string;
      }> = [
        {
          label: "response body accessor",
          body: {
            configurable: true,
            get() {
              responseBodyAccessorCalls += 1;
              throw createAuthorityBearingError(
                "structural response body accessor",
              );
            },
          },
        },
        {
          label: "body Proxy",
          body: new Proxy(
            {},
            {
              get() {
                bodyProxyAccesses += 1;
                throw createAuthorityBearingError("response body Proxy");
              },
            },
          ),
        },
        {
          label: "cancel accessor",
          body: Object.defineProperty({}, "cancel", {
            configurable: true,
            get() {
              cancelAccessorCalls += 1;
              throw createAuthorityBearingError(
                "response body cancel accessor",
              );
            },
          }),
        },
        {
          label: "cancel method Proxy",
          body: {
            cancel: new Proxy(
              () => undefined,
              {
                apply() {
                  cancelProxyCalls += 1;
                  throw createAuthorityBearingError(
                    "response cancel method Proxy",
                  );
                },
              },
            ),
          },
        },
        {
          label: "arbitrary cancel result",
          body: {
            cancel() {
              return Object.defineProperty({}, "then", {
                configurable: true,
                get() {
                  arbitraryThenAccesses += 1;
                  throw createAuthorityBearingError(
                    "arbitrary cancel result",
                  );
                },
              });
            },
          },
        },
      ];
      for (const item of cleanupBodies) {
        const response = hostileResponse({
          body: item.body,
          status: kind === "Kubo" ? 401 : 404,
        });
        const options = {
          endpoint:
            kind === "Kubo"
              ? "http://127.0.0.1:5001"
              : "https://gateway.example.test",
          fetch: (() =>
            Promise.resolve(response)) as typeof globalThis.fetch,
        };
        const reader =
          kind === "Kubo"
            ? createKuboBlockReader(options)
            : createGatewayBlockReader(options);
        if (kind === "Kubo") {
          await assert.rejects(
            reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
            hasCode("ACCESS_DENIED"),
            item.label,
          );
        } else {
          assert.equal(
            await reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
            null,
            item.label,
          );
        }
      }
      assert.equal(responseBodyAccessorCalls, 0, kind);
      assert.equal(bodyProxyAccesses, 0, kind);
      assert.equal(cancelAccessorCalls, 0, kind);
      assert.equal(cancelProxyCalls, 0, kind);
      assert.equal(arbitraryThenAccesses, 0, kind);
    }
  });

  test("observes only exact native structural cancellation results without awaiting cleanup", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const kind of ["Kubo", "gateway"] as const) {
        let nativeThenAccesses = 0;
        const nativeRejection = Promise.reject(
          createAuthorityBearingError(
            `${kind} structural cancel rejection`,
          ),
        );
        Object.defineProperty(nativeRejection, "then", {
          configurable: true,
          get() {
            nativeThenAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} native cancel own then`,
            );
          },
        });
        let thenableAccesses = 0;
        const thenable = Object.defineProperty({}, "then", {
          configurable: true,
          get() {
            thenableAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} arbitrary cancel thenable`,
            );
          },
        });
        let proxyAccesses = 0;
        const promiseProxy = new Proxy(Promise.resolve(), {
          get() {
            proxyAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} cancel Promise Proxy`,
            );
          },
        });
        let foreignThenAccesses = 0;
        const foreignPromise = runInNewContext(
          "Promise.resolve()",
        ) as object;
        Object.defineProperty(foreignPromise, "then", {
          configurable: true,
          get() {
            foreignThenAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} foreign cancel Promise`,
            );
          },
        });
        let subclassThenAccesses = 0;
        class CancelPromiseSubclass<T> extends Promise<T> {}
        Object.defineProperty(CancelPromiseSubclass.prototype, "then", {
          configurable: true,
          get() {
            subclassThenAccesses += 1;
            throw createAuthorityBearingError(
              `${kind} cancel Promise subclass`,
            );
          },
        });
        const subclassPromise = new CancelPromiseSubclass<void>(
          (resolve) => resolve(),
        );
        const cleanupResults: ReadonlyArray<{
          readonly label: string;
          readonly result: unknown;
        }> = [
          { label: "native rejection", result: nativeRejection },
          {
            label: "native never",
            result: new Promise<void>(() => {}),
          },
          { label: "arbitrary thenable", result: thenable },
          { label: "Promise Proxy", result: promiseProxy },
          { label: "foreign Promise", result: foreignPromise },
          { label: "Promise subclass", result: subclassPromise },
        ];
        for (const item of cleanupResults) {
          const response = hostileResponse({
            body: {
              cancel() {
                return item.result;
              },
            },
            status: kind === "Kubo" ? 401 : 404,
          });
          const options = {
            endpoint:
              kind === "Kubo"
                ? "http://127.0.0.1:5001"
                : "https://gateway.example.test",
            fetch: (() =>
              Promise.resolve(response)) as typeof globalThis.fetch,
          };
          const reader =
            kind === "Kubo"
              ? createKuboBlockReader(options)
              : createGatewayBlockReader(options);
          if (kind === "Kubo") {
            await assert.rejects(
              Promise.race([
                reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
                rejectAfter(100, `${kind} ${item.label} cleanup hung`),
              ]),
              hasCode("ACCESS_DENIED"),
              item.label,
            );
          } else {
            assert.equal(
              await Promise.race([
                reader.getBlock(EMPTY_RAW_CID, { maxBytes: 0 }),
                rejectAfter(100, `${kind} ${item.label} cleanup hung`),
              ]),
              null,
              item.label,
            );
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(nativeThenAccesses, 0, kind);
        assert.equal(thenableAccesses, 0, kind);
        assert.equal(proxyAccesses, 0, kind);
        assert.equal(foreignThenAccesses, 0, kind);
        assert.equal(subclassThenAccesses, 0, kind);
        assert.deepEqual(unhandled, [], kind);
      }
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("rejects late-abort response Proxies without entering their traps", async () => {
    for (const kind of ["Kubo", "gateway"] as const) {
      const controller = new AbortController();
      let responseProxyAccesses = 0;
      let resolveFetch!: (response: Response) => void;
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      const fetchResult = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const options = {
        endpoint:
          kind === "Kubo"
            ? "http://127.0.0.1:5001"
            : "https://gateway.example.test",
        fetch: (() => {
          markFetchStarted();
          return fetchResult;
        }) as typeof globalThis.fetch,
      };
      const reader =
        kind === "Kubo"
          ? createKuboBlockReader(options)
          : createGatewayBlockReader(options);
      const pending = reader.getBlock(EMPTY_RAW_CID, {
        maxBytes: 0,
        signal: controller.signal,
      });
      await fetchStarted;
      controller.abort();
      await assert.rejects(pending, hasCode("OPERATION_ABORTED"), kind);

      const responseProxy = new Proxy(hostileResponse({}), {
        get(target, key, receiver) {
          if (key === "then") return undefined;
          responseProxyAccesses += 1;
          throw createAuthorityBearingError(
            `${kind} late response Proxy`,
          );
        },
      });
      resolveFetch(responseProxy);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(responseProxyAccesses, 0, kind);
    }
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

  test("classifies a fulfilled non-byte chunk as a frozen protocol failure", async () => {
    const injected = createAuthorityBearingError("non-byte chunk");
    let canceled = false;
    let released = false;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        hostileResponse({
          body: {
            getReader() {
              return {
                cancel() {
                  canceled = true;
                },
                read() {
                  return Promise.resolve({
                    done: false as const,
                    value: injected,
                  });
                },
                releaseLock() {
                  released = true;
                },
              };
            },
          },
        }),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRepositoryError);
        assert.equal(Object.isFrozen(error), true);
        return assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "block-read",
          "protocol-failure",
        );
      },
    );
    assert.equal(canceled, true);
    assert.equal(released, true);
  });

  test("classifies a fulfilled detached byte chunk as a frozen protocol failure", async () => {
    const detached = Uint8Array.of(0x61);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    Object.defineProperty(detached, "authority", {
      configurable: true,
      value: AUTHORITY_MARKER_TEXT,
    });
    let canceled = false;
    let released = false;
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        hostileResponse({
          body: {
            getReader() {
              return {
                cancel() {
                  canceled = true;
                },
                read() {
                  return Promise.resolve({
                    done: false as const,
                    value: detached,
                  });
                },
                releaseLock() {
                  released = true;
                },
              };
            },
          },
        }),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRepositoryError);
        assert.equal(Object.isFrozen(error), true);
        return assertSanitizedDependencyError(
          error,
          "IO_FAILURE",
          "block-read",
          "protocol-failure",
        );
      },
    );
    assert.equal(canceled, true);
    assert.equal(released, true);
  });

  test("classifies malformed reader surfaces as frozen protocol failures without invoking traps", async () => {
    let accessorReadAccesses = 0;
    const accessorReader = Object.defineProperty({}, "read", {
      configurable: true,
      get() {
        accessorReadAccesses += 1;
        throw createAuthorityBearingError("reader read accessor");
      },
    });
    let proxyReaderTraps = 0;
    const proxyReader = new Proxy(
      {
        read() {
          return Promise.resolve({ done: true as const });
        },
      },
      {
        get() {
          proxyReaderTraps += 1;
          throw createAuthorityBearingError("reader proxy get");
        },
        getOwnPropertyDescriptor() {
          proxyReaderTraps += 1;
          throw createAuthorityBearingError(
            "reader proxy descriptor",
          );
        },
        getPrototypeOf() {
          proxyReaderTraps += 1;
          throw createAuthorityBearingError(
            "reader proxy prototype",
          );
        },
      },
    );
    const malformedReaders: ReadonlyArray<{
      readonly label: string;
      readonly value: unknown;
    }> = [
      { label: "null", value: null },
      { label: "undefined", value: undefined },
      { label: "number", value: 1 },
      { label: "string", value: "reader" },
      { label: "function", value: () => undefined },
      { label: "missing read", value: {} },
      { label: "non-function read", value: { read: 1 } },
      { label: "accessor read", value: accessorReader },
      { label: "Proxy reader", value: proxyReader },
      {
        label: "synchronous read call failure",
        value: {
          read() {
            throw createAuthorityBearingError(
              "synchronous read call",
            );
          },
        },
      },
    ];

    for (const item of malformedReaders) {
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => responseWithReader(item.value),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        (error: unknown) =>
          assertFrozenProtocolFailure(error),
        item.label,
      );
    }

    assert.equal(accessorReadAccesses, 0);
    assert.equal(proxyReaderTraps, 0);
  });

  test("snapshots own and inherited cleanup methods before read mutates their surfaces", async () => {
    for (const placement of ["own", "inherited"] as const) {
      let cancelCalls = 0;
      let releaseCalls = 0;
      let mutatedSurfaceTraps = 0;
      let cancelThenTraps = 0;
      let releaseThenTraps = 0;
      const cleanup = {
        cancel() {
          cancelCalls += 1;
          const result = Promise.resolve();
          Object.defineProperty(result, "then", {
            configurable: true,
            get() {
              cancelThenTraps += 1;
              throw createAuthorityBearingError(
                "cancel promise then",
              );
            },
          });
          return result;
        },
        releaseLock() {
          releaseCalls += 1;
          return Object.defineProperty({}, "then", {
            configurable: true,
            get() {
              releaseThenTraps += 1;
              throw createAuthorityBearingError(
                "release thenable",
              );
            },
          });
        },
      };
      const source: Record<string, unknown> =
        placement === "own"
          ? { ...cleanup }
          : Object.create(cleanup) as Record<string, unknown>;
      Object.defineProperty(source, "read", {
        configurable: true,
        value() {
          for (const key of ["cancel", "releaseLock"] as const) {
            Object.defineProperty(source, key, {
              configurable: true,
              get() {
                mutatedSurfaceTraps += 1;
                throw createAuthorityBearingError(
                  `mutated ${key} surface`,
                );
              },
            });
          }
          return Promise.resolve({ done: false });
        },
      });
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => responseWithReader(source),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        assertFrozenProtocolFailure,
        placement,
      );
      assert.equal(cancelCalls, 1, placement);
      assert.equal(releaseCalls, 1, placement);
      assert.equal(mutatedSurfaceTraps, 0, placement);
      assert.equal(cancelThenTraps, 0, placement);
      assert.equal(releaseThenTraps, 0, placement);
    }
  });

  test("rejects hostile optional cleanup method descriptors without invoking them", async () => {
    let accessorCalls = 0;
    let methodProxyCalls = 0;
    const methodProxy = new Proxy(
      () => undefined,
      {
        apply() {
          methodProxyCalls += 1;
          throw createAuthorityBearingError(
            "cleanup method Proxy apply",
          );
        },
      },
    );
    for (const name of [
      "cancel",
      "read",
      "releaseLock",
    ] as const) {
      for (const surface of [
        "accessor",
        "non-function",
        "Proxy",
      ] as const) {
        const source: Record<string, unknown> = {
          read() {
            return Promise.resolve({ done: true });
          },
        };
        if (surface === "accessor") {
          Object.defineProperty(source, name, {
            configurable: true,
            get() {
              accessorCalls += 1;
              throw createAuthorityBearingError(
                `${name} accessor`,
              );
            },
          });
        } else {
          source[name] = surface === "Proxy" ? methodProxy : 1;
        }
        const reader = createGatewayBlockReader({
          endpoint: "https://gateway.example.test",
          fetch: async () => responseWithReader(source),
        });
        await assert.rejects(
          reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
          assertFrozenProtocolFailure,
          `${name} ${surface}`,
        );
      }
    }
    assert.equal(accessorCalls, 0);
    assert.equal(methodProxyCalls, 0);
  });

  test("rejects a Proxy anywhere in the traversed reader prototype chain", async () => {
    for (let proxyDepth = 1; proxyDepth <= 31; proxyDepth += 1) {
      let proxyTraps = 0;
      const proxy = new Proxy(Object.create(null) as object, {
        getOwnPropertyDescriptor() {
          proxyTraps += 1;
          throw createAuthorityBearingError(
            "reader prototype descriptor",
          );
        },
        getPrototypeOf() {
          proxyTraps += 1;
          throw createAuthorityBearingError(
            "reader prototype traversal",
          );
        },
      });
      let prototype: object | null = proxy;
      for (let depth = 1; depth < proxyDepth; depth += 1) {
        prototype = Object.create(prototype) as object;
      }
      const source = Object.create(prototype) as {
        read?: () => Promise<{ readonly done: true }>;
      };
      Object.defineProperty(source, "read", {
        value() {
          return Promise.resolve({ done: true as const });
        },
      });
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => responseWithReader(source),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        assertFrozenProtocolFailure,
        `Proxy at depth ${proxyDepth}`,
      );
      assert.equal(proxyTraps, 0);
    }
  });

  test("bounds full reader prototype traversal at depth 31", async () => {
    const accepted = createReaderAtPrototypeDepth(31);
    const acceptedReader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => responseWithReader(accepted),
    });
    assert.deepEqual(
      await acceptedReader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      new Uint8Array(),
    );

    const rejected = createReaderAtPrototypeDepth(32);
    const rejectedReader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => responseWithReader(rejected),
    });
    await assert.rejects(
      rejectedReader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      assertFrozenProtocolFailure,
    );
  });

  test("classifies malformed fulfilled read results as frozen protocol failures without invoking traps", async () => {
    let proxyResultTraps = 0;
    let proxyThenAccesses = 0;
    const proxyResult = new Proxy(
      {
        done: true,
      },
      {
        get(target, key, receiver) {
          if (key === "then") {
            proxyThenAccesses += 1;
            if (proxyThenAccesses > 1) {
              proxyResultTraps += 1;
              throw createAuthorityBearingError(
                "result Proxy then replay",
              );
            }
            return Reflect.get(target, key, receiver);
          }
          proxyResultTraps += 1;
          throw createAuthorityBearingError("result proxy get");
        },
        getOwnPropertyDescriptor() {
          proxyResultTraps += 1;
          throw createAuthorityBearingError(
            "result proxy descriptor",
          );
        },
      },
    );
    let doneAccessorCalls = 0;
    const accessorDoneResult = Object.defineProperty(
      {},
      "done",
      {
        configurable: true,
        get() {
          doneAccessorCalls += 1;
          throw createAuthorityBearingError("result done accessor");
        },
      },
    );
    let valueAccessorCalls = 0;
    const accessorValueResult = Object.defineProperties(
      {},
      {
        done: {
          configurable: true,
          value: false,
        },
        value: {
          configurable: true,
          get() {
            valueAccessorCalls += 1;
            throw createAuthorityBearingError(
              "result value accessor",
            );
          },
        },
      },
    );
    const malformedResults: ReadonlyArray<{
      readonly label: string;
      readonly value: unknown;
    }> = [
      { label: "null", value: null },
      { label: "undefined", value: undefined },
      { label: "number", value: 0 },
      { label: "string", value: "result" },
      { label: "boolean", value: true },
      { label: "missing done", value: {} },
      {
        label: "inherited done",
        value: Object.create({ done: true }) as object,
      },
      { label: "numeric done", value: { done: 0 } },
      { label: "text done", value: { done: "false" } },
      { label: "null done", value: { done: null } },
      { label: "false without value", value: { done: false } },
      {
        label: "false with inherited value",
        value: Object.assign(
          Object.create({ value: new Uint8Array() }) as object,
          { done: false },
        ),
      },
      {
        label: "false with non-byte value",
        value: {
          done: false,
          value: createAuthorityBearingError(
            "fulfilled non-byte result",
          ),
        },
      },
      { label: "Proxy result", value: proxyResult },
      { label: "accessor done", value: accessorDoneResult },
      { label: "accessor value", value: accessorValueResult },
    ];

    for (const item of malformedResults) {
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () =>
          responseWithReader({
            read() {
              return Promise.resolve(item.value);
            },
          }),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        (error: unknown) =>
          assertFrozenProtocolFailure(error),
        item.label,
      );
    }

    assert.equal(proxyResultTraps, 0);
    assert.equal(proxyThenAccesses, 1);
    assert.equal(doneAccessorCalls, 0);
    assert.equal(valueAccessorCalls, 0);
  });

  test("accepts a done result without inspecting its hostile value", async () => {
    let valueAccessorCalls = 0;
    const done = Object.defineProperties(
      {},
      {
        done: {
          configurable: true,
          value: true,
        },
        value: {
          configurable: true,
          get() {
            valueAccessorCalls += 1;
            throw createAuthorityBearingError(
              "completed result value",
            );
          },
        },
      },
    );
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            return Promise.resolve(done);
          },
        }),
    });

    assert.deepEqual(
      await reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      new Uint8Array(),
    );
    assert.equal(valueAccessorCalls, 0);
  });

  test("keeps a genuine returned read promise rejection classified as unavailable", async () => {
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            return Promise.reject(
              createAuthorityBearingError(
                "returned read promise rejection",
              ),
            );
          },
        }),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRepositoryError);
        assert.equal(Object.isFrozen(error), true);
        return assertSanitizedDependencyError(
          error,
          "DEPENDENCY_UNAVAILABLE",
          "block-read",
          "unavailable",
        );
      },
    );
  });

  test("adopts an exact native Promise without consulting its hostile own then", async () => {
    let thenAccesses = 0;
    const result = Promise.resolve({ done: true as const });
    Object.defineProperty(result, "then", {
      configurable: true,
      get() {
        thenAccesses += 1;
        throw createAuthorityBearingError(
          "native promise own then",
        );
      },
    });
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            return result;
          },
        }),
    });

    assert.deepEqual(
      await reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      new Uint8Array(),
    );
    assert.equal(thenAccesses, 0);
  });

  test("rejects sync results, thenables, Promise Proxies, foreign Promises, and subclasses without traps", async () => {
    let thenableTraps = 0;
    const thenable = Object.defineProperty({}, "then", {
      configurable: true,
      get() {
        thenableTraps += 1;
        throw createAuthorityBearingError("arbitrary thenable");
      },
    });
    let promiseProxyTraps = 0;
    const promiseProxy = new Proxy(
      Promise.resolve({ done: true as const }),
      {
        get() {
          promiseProxyTraps += 1;
          throw createAuthorityBearingError("Promise Proxy");
        },
      },
    );
    let subclassThenTraps = 0;
    class ThenSubclass<T> extends Promise<T> {}
    Object.defineProperty(ThenSubclass.prototype, "then", {
      configurable: true,
      get() {
        subclassThenTraps += 1;
        throw createAuthorityBearingError(
          "Promise subclass then",
        );
      },
    });
    const thenSubclass = new ThenSubclass<{
      readonly done: true;
    }>((resolve) => resolve({ done: true }));
    let subclassSpeciesTraps = 0;
    class SpeciesSubclass<T> extends Promise<T> {}
    Object.defineProperty(SpeciesSubclass, Symbol.species, {
      configurable: true,
      get() {
        subclassSpeciesTraps += 1;
        throw createAuthorityBearingError(
          "Promise subclass species",
        );
      },
    });
    const speciesSubclass = new SpeciesSubclass<{
      readonly done: true;
    }>((resolve) => resolve({ done: true }));
    const foreignPromise = runInNewContext(
      "Promise.resolve({ done: true })",
    ) as object;
    let foreignThenTraps = 0;
    Object.defineProperty(foreignPromise, "then", {
      configurable: true,
      get() {
        foreignThenTraps += 1;
        throw createAuthorityBearingError(
          "cross-realm Promise then",
        );
      },
    });
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly value: unknown;
    }> = [
      { label: "sync result object", value: { done: true } },
      { label: "arbitrary thenable", value: thenable },
      { label: "Promise Proxy", value: promiseProxy },
      { label: "cross-realm Promise", value: foreignPromise },
      { label: "Promise subclass then", value: thenSubclass },
      {
        label: "Promise subclass species",
        value: speciesSubclass,
      },
    ];

    for (const item of cases) {
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () =>
          responseWithReader({
            read() {
              return item.value;
            },
          }),
      });
      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        assertFrozenProtocolFailure,
        item.label,
      );
    }
    assert.equal(thenableTraps, 0);
    assert.equal(promiseProxyTraps, 0);
    assert.equal(foreignThenTraps, 0);
    assert.equal(subclassThenTraps, 0);
    assert.equal(subclassSpeciesTraps, 0);
  });

  test("rejects an exact native Promise with a mutable constructor surface without invoking it", async () => {
    let constructorAccesses = 0;
    const result = Promise.resolve({ done: true as const });
    Object.defineProperty(result, "constructor", {
      configurable: true,
      get() {
        constructorAccesses += 1;
        throw createAuthorityBearingError(
          "Promise constructor accessor",
        );
      },
    });
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            return result;
          },
        }),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
      assertFrozenProtocolFailure,
    );
    assert.equal(constructorAccesses, 0);
  });

  test("observes late native Promise rejection and removes abort listeners after cancellation", async () => {
    const controller = new AbortController();
    const tracked = trackAbortListeners(controller.signal);
    let rejectRead!: (error: unknown) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectRead = reject;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            markReadStarted();
            return pending;
          },
        }),
    });
    const operation = reader.getBlock(EMPTY_RAW_CID, {
      maxBytes: 64,
      signal: tracked.signal,
    });
    await readStarted;
    controller.abort(
      createAuthorityBearingError("late rejection abort"),
    );

    await assert.rejects(operation, hasCode("OPERATION_ABORTED"));
    assert.equal(tracked.activeCount(), 0);
    rejectRead(createAuthorityBearingError("late read rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  test("observes native cancel rejection without awaiting cancel or release results", async () => {
    let rejectCancel!: (error: unknown) => void;
    const cancelResult = new Promise<never>((_resolve, reject) => {
      rejectCancel = reject;
    });
    let releaseThenAccesses = 0;
    const source = {
      cancel() {
        return cancelResult;
      },
      read() {
        return Promise.resolve({ done: false });
      },
      releaseLock() {
        return Object.defineProperty({}, "then", {
          configurable: true,
          get() {
            releaseThenAccesses += 1;
            throw createAuthorityBearingError(
              "release result then",
            );
          },
        });
      },
    };
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () => responseWithReader(source),
    });

    await assert.rejects(
      Promise.race([
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        rejectAfter(100, "reader cleanup was awaited"),
      ]),
      assertFrozenProtocolFailure,
    );
    rejectCancel(createAuthorityBearingError("cancel rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releaseThenAccesses, 0);
  });

  test("does not assimilate arbitrary cancel or release thenables and tolerates release throws", async () => {
    for (const releaseMode of ["thenable", "throw"] as const) {
      let cancelThenAccesses = 0;
      let releaseThenAccesses = 0;
      const source = {
        cancel() {
          return Object.defineProperty({}, "then", {
            configurable: true,
            get() {
              cancelThenAccesses += 1;
              throw createAuthorityBearingError(
                "cancel arbitrary thenable",
              );
            },
          });
        },
        read() {
          return Promise.resolve({ done: false });
        },
        releaseLock() {
          if (releaseMode === "throw") {
            throw createAuthorityBearingError("release throw");
          }
          return Object.defineProperty({}, "then", {
            configurable: true,
            get() {
              releaseThenAccesses += 1;
              throw createAuthorityBearingError(
                "release arbitrary thenable",
              );
            },
          });
        },
      };
      const reader = createGatewayBlockReader({
        endpoint: "https://gateway.example.test",
        fetch: async () => responseWithReader(source),
      });

      await assert.rejects(
        reader.getBlock(EMPTY_RAW_CID, { maxBytes: 64 }),
        assertFrozenProtocolFailure,
      );
      assert.equal(cancelThenAccesses, 0, releaseMode);
      assert.equal(releaseThenAccesses, 0, releaseMode);
    }
  });

  test("keeps caller abort authoritative over synchronous reader failure", async () => {
    const controller = new AbortController();
    const reader = createGatewayBlockReader({
      endpoint: "https://gateway.example.test",
      fetch: async () =>
        responseWithReader({
          read() {
            controller.abort(
              createAuthorityBearingError("reader abort reason"),
            );
            throw createAuthorityBearingError(
              "reader failure after abort",
            );
          },
        }),
    });

    await assert.rejects(
      reader.getBlock(EMPTY_RAW_CID, {
        maxBytes: 64,
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvidenceRepositoryError);
        assert.equal(Object.isFrozen(error), true);
        assert.equal(error.code, "OPERATION_ABORTED");
        assert.equal(error.cause, undefined);
        assertNoAuthorityMarkers(error);
        return true;
      },
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
            "IO_FAILURE",
            "block-read",
            "protocol-failure",
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

function responseWithReader(reader: unknown): Response {
  return hostileResponse({
    body: {
      getReader() {
        return reader;
      },
    },
  });
}

function createReaderAtPrototypeDepth(depth: number): object {
  let prototype: object | null = null;
  for (let current = 0; current < depth; current += 1) {
    prototype = Object.create(prototype) as object;
  }
  const source = Object.create(prototype) as object;
  Object.defineProperty(source, "read", {
    value() {
      return Promise.resolve({ done: true as const });
    },
  });
  return source;
}

function assertFrozenProtocolFailure(error: unknown): boolean {
  assert.ok(error instanceof EvidenceRepositoryError);
  assert.equal(Object.isFrozen(error), true);
  return assertSanitizedDependencyError(
    error,
    "IO_FAILURE",
    "block-read",
    "protocol-failure",
  );
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
