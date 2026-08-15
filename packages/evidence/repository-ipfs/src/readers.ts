// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  isPromise,
  isProxy,
  isUint8Array,
} from "node:util/types";

import {
  EvidenceRepositoryError,
  assertRepositoryOperationActive,
  parseSha256Digest,
  type EvidenceRepositoryErrorCode,
  type RepositoryOperationOptions,
} from "@jinn-network/evidence-repository";
import { CID } from "kubo-rpc-client";

import {
  MAX_STANDARD_IPFS_BLOCK_BYTES,
  normalizeRawCid,
  rawCidToDigest,
} from "./cid.js";
import {
  intrinsicUint8ArrayByteLength,
  setIntrinsicUint8Array,
} from "./byte-intrinsics.js";
import {
  ipfsDependencyError,
  ipfsRepositoryError,
  isIpfsRepositoryError,
  mapIpfsDependencyError,
} from "./errors.js";

const MAX_KUBO_ERROR_BODY_BYTES = 64 * 1024;
const RAW_BLOCK_ACCEPT = "application/vnd.ipld.raw";
const MAX_READER_PROTOTYPE_DEPTH = 32;
const intrinsicApply = Reflect.apply;
const intrinsicCreate = Object.create;
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicFreeze = Object.freeze;
const intrinsicGetOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const NativePromise = Promise;
const nativePromisePrototype = NativePromise.prototype;
const nativePromiseThen = intrinsicGetOwnPropertyDescriptor(
  nativePromisePrototype,
  "then",
)!.value as (
  onFulfilled?: (value: unknown) => unknown,
  onRejected?: (reason: unknown) => unknown,
) => Promise<unknown>;
const nativePromiseConstructorDescriptor =
  intrinsicGetOwnPropertyDescriptor(
    nativePromisePrototype,
    "constructor",
  )!;
const nativePromiseSpeciesDescriptor =
  intrinsicGetOwnPropertyDescriptor(
    NativePromise,
    Symbol.species,
  )!;
const nativeResponseBodyGetter =
  intrinsicGetOwnPropertyDescriptor(
    Response.prototype,
    "body",
  )!.get as (this: Response) => ReadableStream<Uint8Array> | null;

interface ResponseBodyReader {
  readonly cancel?: (...arguments_: readonly unknown[]) => unknown;
  readonly read: (...arguments_: readonly unknown[]) => unknown;
  readonly releaseLock?: (
    ...arguments_: readonly unknown[]
  ) => unknown;
  readonly source: object;
}

type ResponseReadResult =
  | { readonly done: true }
  | { readonly done: false; readonly value: unknown };

interface NativePromiseFulfilled<T> {
  readonly status: "fulfilled";
  readonly value: T;
}

interface NativePromiseRejected {
  readonly status: "rejected";
}

interface FetchAborted {
  readonly status: "aborted";
}

type NativePromiseSettlement<T> =
  | NativePromiseFulfilled<T>
  | NativePromiseRejected;

const NATIVE_PROMISE_REJECTED =
  createInertStatusRecord<NativePromiseRejected>("rejected");
const FETCH_ABORTED =
  createInertStatusRecord<FetchAborted>("aborted");

function createInertStatusRecord<
  T extends NativePromiseRejected | FetchAborted,
>(status: T["status"]): T {
  const record = intrinsicCreate(null) as T;
  intrinsicDefineProperty(record, "status", {
    configurable: false,
    enumerable: true,
    value: status,
    writable: false,
  });
  return intrinsicFreeze(record);
}

function createInertFulfilledRecord<T>(
  value: T,
): NativePromiseFulfilled<T> {
  const record = intrinsicCreate(null) as NativePromiseFulfilled<T>;
  intrinsicDefineProperty(record, "status", {
    configurable: false,
    enumerable: true,
    value: "fulfilled",
    writable: false,
  });
  intrinsicDefineProperty(record, "value", {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
  return intrinsicFreeze(record);
}

export interface IpfsBlockReader {
  getBlock(
    cid: string,
    options: RepositoryOperationOptions & { readonly maxBytes: number },
  ): Promise<Uint8Array | null>;
}

export interface KuboBlockReaderOptions {
  readonly endpoint: string | URL;
  readonly fetch?: typeof globalThis.fetch;
}

export interface GatewayBlockReaderOptions {
  readonly endpoint: string | URL;
  readonly fetch?: typeof globalThis.fetch;
}

export function createKuboBlockReader(
  options: KuboBlockReaderOptions,
): IpfsBlockReader {
  const endpoint = parseEndpoint(options.endpoint, "Kubo");
  const fetchCapability = options.fetch ?? globalThis.fetch;

  return {
    async getBlock(cid, operationOptions) {
      const canonicalCid = normalizeRawCid(cid);
      const maxBytes = parseMaxBytes(operationOptions.maxBytes);
      assertRepositoryOperationActive(operationOptions);

      const url = kuboBlockGetUrl(endpoint, canonicalCid);
      const responseResult = await performFetch(
        fetchCapability,
        url,
        {
          method: "POST",
          signal: operationOptions.signal,
        },
        operationOptions,
      );
      const response = responseResult.value;
      if (operationOptions.signal?.aborted === true) {
        cancelResponse(response);
      }
      assertRepositoryOperationActive(operationOptions);

      const status = readResponseStatus(response, operationOptions);
      if (status === 401 || status === 403) {
        cancelResponse(response);
        throw repositoryError(
          "ACCESS_DENIED",
          `Kubo block read was denied with HTTP ${status}.`,
          "block-read",
          "access-denied",
        );
      }
      if (status === 500) {
        const errorBytes = await readBoundedResponse(
          response,
          MAX_KUBO_ERROR_BODY_BYTES,
          operationOptions,
          "DEPENDENCY_UNAVAILABLE",
          "Kubo error response exceeded the pinned envelope limit.",
          {
            failureKind: "protocol-failure",
            operation: "block-read",
          },
        );
        if (isPinnedKuboNotFound(errorBytes, canonicalCid)) {
          return null;
        }
        throw repositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "Kubo returned an unrecognized command error envelope.",
          "block-read",
          "protocol-failure",
        );
      }
      if (!readResponseOk(response, operationOptions)) {
        cancelResponse(response);
        throw mapHttpFailure("Kubo", status);
      }

      return verifyBlock(
        await readBoundedResponse(
          response,
          maxBytes,
          operationOptions,
          "CONTENT_TOO_LARGE",
          "Kubo block exceeded the requested byte limit.",
        ),
        canonicalCid,
      );
    },
  };
}

export function createGatewayBlockReader(
  options: GatewayBlockReaderOptions,
): IpfsBlockReader {
  const endpoint = parseEndpoint(options.endpoint, "gateway");
  const fetchCapability = options.fetch ?? globalThis.fetch;

  return {
    async getBlock(cid, operationOptions) {
      const canonicalCid = normalizeRawCid(cid);
      const maxBytes = parseMaxBytes(operationOptions.maxBytes);
      assertRepositoryOperationActive(operationOptions);

      const responseResult = await performFetch(
        fetchCapability,
        gatewayBlockUrl(endpoint, canonicalCid),
        {
          method: "GET",
          headers: { accept: RAW_BLOCK_ACCEPT },
          signal: operationOptions.signal,
        },
        operationOptions,
      );
      const response = responseResult.value;
      if (operationOptions.signal?.aborted === true) {
        cancelResponse(response);
      }
      assertRepositoryOperationActive(operationOptions);

      const status = readResponseStatus(response, operationOptions);
      if (status === 404) {
        cancelResponse(response);
        return null;
      }
      if (status === 401 || status === 403) {
        cancelResponse(response);
        throw repositoryError(
          "ACCESS_DENIED",
          `Gateway block read was denied with HTTP ${status}.`,
          "block-read",
          "access-denied",
        );
      }
      if (!readResponseOk(response, operationOptions)) {
        cancelResponse(response);
        throw mapHttpFailure("Gateway", status);
      }

      return verifyBlock(
        await readBoundedResponse(
          response,
          maxBytes,
          operationOptions,
          "CONTENT_TOO_LARGE",
          "Gateway block exceeded the requested byte limit.",
        ),
        canonicalCid,
      );
    },
  };
}

function parseEndpoint(value: string | URL, label: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw ipfsRepositoryError(
      "INVALID_REFERENCE",
      `${label} endpoint must be an absolute HTTP(S) URL.`,
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw ipfsRepositoryError(
      "INVALID_REFERENCE",
      `${label} endpoint must be an HTTP(S) URL without userinfo, query, or fragment.`,
    );
  }
  return endpoint;
}

function parseMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw ipfsRepositoryError(
      "INVALID_REFERENCE",
      "maxBytes must be a non-negative safe integer.",
    );
  }
  return Math.min(value, MAX_STANDARD_IPFS_BLOCK_BYTES);
}

function kuboBlockGetUrl(endpoint: URL, cid: string): URL {
  const url = new URL(endpoint);
  const basePath = trimTrailingSlashes(url.pathname);
  url.pathname = basePath.endsWith("/api/v0")
    ? `${basePath}/block/get`
    : `${basePath}/api/v0/block/get`;
  url.searchParams.set("arg", cid);
  return url;
}

function gatewayBlockUrl(endpoint: URL, cid: string): URL {
  const url = new URL(endpoint);
  url.pathname = `${trimTrailingSlashes(url.pathname)}/ipfs/${cid}`;
  url.searchParams.set("format", "raw");
  return url;
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.replace(/\/+$/u, "");
  return trimmed === "" ? "" : trimmed;
}

async function performFetch(
  fetchCapability: typeof globalThis.fetch,
  input: URL,
  init: RequestInit,
  options: RepositoryOperationOptions,
): Promise<NativePromiseFulfilled<Response>> {
  assertRepositoryOperationActive(options);
  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  let abortResult: Promise<FetchAborted> | undefined;
  if (signal !== undefined) {
    let resolveAbort!: (result: FetchAborted) => void;
    abortResult = new NativePromise((resolve) => {
      resolveAbort = resolve;
    });
    const abortListener = () => resolveAbort(FETCH_ABORTED);
    onAbort = abortListener;
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  }

  try {
    if (isSignalAborted(signal)) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }

    let fetchResult: Promise<NativePromiseSettlement<Response>>;
    try {
      fetchResult = observeNativePromise<Response>(
        intrinsicApply(fetchCapability, undefined, [input, init]),
        (response) => {
          if (isSignalAborted(signal)) cancelResponse(response);
        },
      );
    } catch {
      if (isSignalAborted(signal)) {
        throw ipfsRepositoryError(
          "OPERATION_ABORTED",
          "The IPFS block read was aborted.",
        );
      }
      throw responseProtocolFailure();
    }

    const result =
      abortResult === undefined
        ? await fetchResult
        : await raceNativePromises(fetchResult, abortResult);
    if (isSignalAborted(signal)) {
      if (result.status === "fulfilled") {
        cancelResponse(result.value);
      }
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }
    if (result.status === "aborted") {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }
    if (result.status === "rejected") {
      throw ipfsDependencyError(
        "DEPENDENCY_UNAVAILABLE",
        "The configured IPFS block endpoint was unavailable.",
        "block-read",
        "unavailable",
      );
    }
    return result;
  } finally {
    if (signal !== undefined && onAbort !== undefined) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // Listener cleanup cannot displace the primary operation result.
      }
    }
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  options: RepositoryOperationOptions,
  tooLargeCode: EvidenceRepositoryErrorCode,
  tooLargeMessage: string,
  dependencyFailure?: {
    readonly failureKind: "protocol-failure" | "unavailable";
    readonly operation: "block-read";
  },
): Promise<Uint8Array> {
  let reader: ResponseBodyReader;
  let directSetupError: EvidenceRepositoryError | undefined;
  try {
    const headers = response.headers;
    const getHeader = headers.get;
    if (typeof getHeader !== "function") {
      throw new TypeError("Response headers do not expose get().");
    }
    const declaredLength = Reflect.apply(
      getHeader,
      headers,
      ["content-length"],
    ) as unknown;
    if (
      declaredLength !== null &&
      typeof declaredLength !== "string"
    ) {
      throw new TypeError("Response Content-Length was not text.");
    }
    if (
      declaredLength !== null &&
      /^[0-9]+$/u.test(declaredLength)
    ) {
      const parsedLength = Number(declaredLength);
      if (
        Number.isSafeInteger(parsedLength) &&
        parsedLength > maxBytes
      ) {
        cancelResponse(response);
        directSetupError = responseLimitError(
          tooLargeCode,
          tooLargeMessage,
          dependencyFailure,
        );
        throw directSetupError;
      }
    }

    const body = response.body;
    if (body === null) return new Uint8Array();
    const getReader = body.getReader;
    if (typeof getReader !== "function") {
      throw new TypeError("Response body does not expose getReader().");
    }
    reader = parseResponseBodyReader(
      Reflect.apply(getReader, body, []),
    );
  } catch (error) {
    cancelResponse(response);
    if (options.signal?.aborted === true) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS response stream was aborted.",
      );
    }
    if (error === directSetupError) throw error;
    throw responseProtocolFailure();
  }

  const output = new Uint8Array(maxBytes);
  let offset = 0;
  let directStreamError: EvidenceRepositoryError | undefined;
  try {
    while (true) {
      assertRepositoryOperationActive(options);
      const readSettlement = await readNextChunk(reader, options);
      assertRepositoryOperationActive(options);
      let item: ResponseReadResult;
      try {
        item = parseResponseReadResult(readSettlement.value);
      } catch {
        directStreamError = responseProtocolFailure();
        throw directStreamError;
      }
      if (item.done) break;
      const chunk = item.value;
      if (!isUint8Array(chunk)) {
        directStreamError = responseProtocolFailure();
        throw directStreamError;
      }
      let chunkByteLength: number;
      try {
        chunkByteLength = intrinsicUint8ArrayByteLength(chunk);
      } catch {
        directStreamError = responseProtocolFailure();
        throw directStreamError;
      }
      if (chunkByteLength > maxBytes - offset) {
        directStreamError = responseLimitError(
          tooLargeCode,
          tooLargeMessage,
          dependencyFailure,
        );
        throw directStreamError;
      }
      try {
        setIntrinsicUint8Array(output, chunk, offset);
      } catch {
        directStreamError = responseProtocolFailure();
        throw directStreamError;
      }
      offset += chunkByteLength;
    }
  } catch (error) {
    cancelReader(reader);
    if (options.signal?.aborted === true) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS response stream was aborted.",
      );
    }
    if (error === directStreamError) throw error;
    if (isIpfsRepositoryError(error)) {
      throw mapIpfsDependencyError(
        error,
        "The IPFS response stream failed.",
        "block-read",
        options.signal,
        true,
      );
    }
    throw ipfsDependencyError(
      "DEPENDENCY_UNAVAILABLE",
      "The IPFS response stream failed.",
      "block-read",
      "unavailable",
    );
  } finally {
    releaseReader(reader);
  }
  return output.subarray(0, offset);
}

function verifyBlock(bytes: Uint8Array, cid: string): Uint8Array {
  const expectedDigest = rawCidToDigest(cid);
  const actualDigest = parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  if (actualDigest !== expectedDigest) {
    throw ipfsRepositoryError(
      "CONTENT_CORRUPT",
      "IPFS block bytes do not match the requested CID.",
    );
  }
  return bytes;
}

function isPinnedKuboNotFound(bytes: Uint8Array, cid: string): boolean {
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const kuboRenderedCid = CID.decode(
    Buffer.from(normalizeRawCid(cid).slice(1), "hex"),
  ).toString();
  const expected =
    `{"Message":"block was not found locally (offline): ipld: could not find ${kuboRenderedCid}",` +
    `"Code":0,"Type":"error"}\n`;
  return body === expected;
}

function mapHttpFailure(
  dependency: string,
  status: number,
): EvidenceRepositoryError {
  if (status === 408 || status === 429 || status >= 500) {
    return ipfsDependencyError(
      "DEPENDENCY_UNAVAILABLE",
      `${dependency} block read failed with HTTP ${status}.`,
      "block-read",
      "unavailable",
    );
  }
  return ipfsDependencyError(
    "IO_FAILURE",
    `${dependency} block read failed with HTTP ${status}.`,
    "block-read",
    "protocol-failure",
  );
}

async function readNextChunk(
  reader: ResponseBodyReader,
  options: RepositoryOperationOptions,
): Promise<NativePromiseFulfilled<unknown>> {
  assertRepositoryOperationActive(options);
  let pendingRead: Promise<NativePromiseSettlement<unknown>>;
  try {
    pendingRead = observeNativePromise(
      intrinsicApply(reader.read, reader.source, []),
    );
  } catch {
    throw responseProtocolFailure();
  }

  const signal = options.signal;
  if (signal === undefined) {
    const settlement = await pendingRead;
    if (settlement.status === "rejected") {
      throw ipfsDependencyError(
        "DEPENDENCY_UNAVAILABLE",
        "The IPFS response stream failed.",
        "block-read",
        "unavailable",
      );
    }
    return settlement;
  }

  let rejectAbort!: (error: EvidenceRepositoryError) => void;
  const aborted = new NativePromise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(
      ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS response stream was aborted.",
      ),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const settlement = await raceNativePromises(
      pendingRead,
      aborted,
    );
    if (settlement.status === "rejected") {
      throw ipfsDependencyError(
        "DEPENDENCY_UNAVAILABLE",
        "The IPFS response stream failed.",
        "block-read",
        "unavailable",
      );
    }
    return settlement;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function raceNativePromises<T, U>(
  first: Promise<T>,
  second: Promise<U>,
): Promise<T | U> {
  if (!nativePromiseInfrastructureIsIntact()) {
    throw responseProtocolFailure();
  }
  return new NativePromise<T | U>((resolve, reject) => {
    intrinsicApply(nativePromiseThen, first, [resolve, reject]);
    intrinsicApply(nativePromiseThen, second, [resolve, reject]);
  });
}

function parseResponseBodyReader(value: unknown): ResponseBodyReader {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value)
  ) {
    throw new TypeError(
      "Response body getReader() returned an invalid reader.",
    );
  }

  let cancel:
    | ((...arguments_: readonly unknown[]) => unknown)
    | undefined;
  let cancelFound = false;
  let read:
    | ((...arguments_: readonly unknown[]) => unknown)
    | undefined;
  let readFound = false;
  let releaseLock:
    | ((...arguments_: readonly unknown[]) => unknown)
    | undefined;
  let releaseLockFound = false;
  let owner: object | null = value;
  for (
    let depth = 0;
    owner !== null && depth < MAX_READER_PROTOTYPE_DEPTH;
    depth += 1
  ) {
    if (isProxy(owner)) {
      throw new TypeError(
        "Response body reader must not contain a Proxy surface.",
      );
    }
    if (!cancelFound) {
      const descriptor = intrinsicGetOwnPropertyDescriptor(
        owner,
        "cancel",
      );
      if (descriptor !== undefined) {
        cancelFound = true;
        cancel = parseReaderMethod(descriptor, "cancel");
      }
    }
    if (!readFound) {
      const descriptor = intrinsicGetOwnPropertyDescriptor(
        owner,
        "read",
      );
      if (descriptor !== undefined) {
        readFound = true;
        read = parseReaderMethod(descriptor, "read");
      }
    }
    if (!releaseLockFound) {
      const descriptor = intrinsicGetOwnPropertyDescriptor(
        owner,
        "releaseLock",
      );
      if (descriptor !== undefined) {
        releaseLockFound = true;
        releaseLock = parseReaderMethod(
          descriptor,
          "releaseLock",
        );
      }
    }
    owner = intrinsicGetPrototypeOf(owner) as object | null;
  }

  if (owner !== null || read === undefined) {
    throw new TypeError(
      "Response body reader does not expose a bounded read surface.",
    );
  }
  return { cancel, read, releaseLock, source: value };
}

function parseReaderMethod(
  descriptor: PropertyDescriptor,
  name: "cancel" | "read" | "releaseLock",
): (...arguments_: readonly unknown[]) => unknown {
  if (
    !("value" in descriptor) ||
    typeof descriptor.value !== "function" ||
    isProxy(descriptor.value)
  ) {
    throw new TypeError(
      `Response body reader does not expose a stable ${name} method.`,
    );
  }
  return descriptor.value as (
    ...arguments_: readonly unknown[]
  ) => unknown;
}

function parseResponseReadResult(value: unknown): ResponseReadResult {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value)
  ) {
    throw new TypeError(
      "Response body reader returned an invalid result.",
    );
  }

  const doneDescriptor = intrinsicGetOwnPropertyDescriptor(
    value,
    "done",
  );
  if (
    doneDescriptor === undefined ||
    !("value" in doneDescriptor) ||
    typeof doneDescriptor.value !== "boolean"
  ) {
    throw new TypeError(
      "Response body reader result must expose an own boolean done value.",
    );
  }
  if (doneDescriptor.value) return { done: true };

  const valueDescriptor = intrinsicGetOwnPropertyDescriptor(
    value,
    "value",
  );
  if (
    valueDescriptor === undefined ||
    !("value" in valueDescriptor)
  ) {
    throw new TypeError(
      "An incomplete response body reader result must expose an own data value.",
    );
  }
  return { done: false, value: valueDescriptor.value };
}

function observeNativePromise<T>(
  value: unknown,
  onFulfilled?: (value: T) => void,
): Promise<NativePromiseSettlement<T>> {
  if (!isSafelyObservableNativePromise(value)) {
    throw new TypeError(
      "An injected async capability must return an exact native Promise.",
    );
  }

  let settle!: (value: NativePromiseSettlement<T>) => void;
  const settlement = new NativePromise<NativePromiseSettlement<T>>(
    (resolve) => {
      settle = resolve;
    },
  );
  intrinsicApply(nativePromiseThen, value, [
    (result: unknown) => {
      if (onFulfilled !== undefined) {
        try {
          onFulfilled(result as T);
        } catch {
          // Detached cleanup cannot displace source observation.
        }
      }
      settle(createInertFulfilledRecord(result as T));
    },
    () => {
      settle(NATIVE_PROMISE_REJECTED);
    },
  ]);
  return settlement;
}

function observeCleanupPromise(value: unknown): void {
  if (!isSafelyObservableNativePromise(value)) return;
  try {
    intrinsicApply(nativePromiseThen, value, [
      () => undefined,
      () => undefined,
    ]);
  } catch {
    // Cleanup observation cannot displace the primary operation result.
  }
}

function isSafelyObservableNativePromise(
  value: unknown,
): value is Promise<unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !isPromise(value)
  ) {
    return false;
  }
  try {
    if (intrinsicGetPrototypeOf(value) !== nativePromisePrototype) {
      return false;
    }
    if (
      intrinsicGetOwnPropertyDescriptor(value, "constructor") !==
      undefined
    ) {
      return false;
    }
    return nativePromiseInfrastructureIsIntact();
  } catch {
    return false;
  }
}

function nativePromiseInfrastructureIsIntact(): boolean {
  return (
    descriptorsEqual(
      intrinsicGetOwnPropertyDescriptor(
        nativePromisePrototype,
        "constructor",
      ),
      nativePromiseConstructorDescriptor,
    ) &&
    descriptorsEqual(
      intrinsicGetOwnPropertyDescriptor(
        NativePromise,
        Symbol.species,
      ),
      nativePromiseSpeciesDescriptor,
    )
  );
}

function descriptorsEqual(
  actual: PropertyDescriptor | undefined,
  expected: PropertyDescriptor,
): boolean {
  if (actual === undefined) return false;
  return (
    actual.configurable === expected.configurable &&
    actual.enumerable === expected.enumerable &&
    ("value" in actual) === ("value" in expected) &&
    ("value" in actual
      ? actual.value === expected.value &&
        actual.writable === expected.writable
      : actual.get === expected.get && actual.set === expected.set)
  );
}

function cancelResponse(response: unknown): void {
  try {
    const body = snapshotResponseBody(response);
    if (body === undefined || body === null) return;
    const cancellation = snapshotBodyCancellation(body);
    if (cancellation === undefined) return;
    observeCleanupPromise(
      intrinsicApply(cancellation.cancel, cancellation.source, []),
    );
  } catch {
    // The primary HTTP classification remains authoritative.
  }
}

function snapshotResponseBody(response: unknown): unknown {
  if (
    typeof response !== "object" ||
    response === null ||
    isProxy(response)
  ) {
    return undefined;
  }
  try {
    return intrinsicApply(nativeResponseBodyGetter, response, []);
  } catch {
    const descriptor = intrinsicGetOwnPropertyDescriptor(
      response,
      "body",
    );
    if (
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      return undefined;
    }
    return descriptor.value;
  }
}

function snapshotBodyCancellation(
  body: unknown,
):
  | {
      readonly cancel: (
        ...arguments_: readonly unknown[]
      ) => unknown;
      readonly source: object;
    }
  | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    isProxy(body)
  ) {
    return undefined;
  }

  let cancel:
    | ((...arguments_: readonly unknown[]) => unknown)
    | undefined;
  let cancelFound = false;
  let owner: object | null = body;
  for (
    let depth = 0;
    owner !== null && depth < MAX_READER_PROTOTYPE_DEPTH;
    depth += 1
  ) {
    if (isProxy(owner)) return undefined;
    if (!cancelFound) {
      const descriptor = intrinsicGetOwnPropertyDescriptor(
        owner,
        "cancel",
      );
      if (descriptor !== undefined) {
        cancelFound = true;
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function" ||
          isProxy(descriptor.value)
        ) {
          return undefined;
        }
        cancel = descriptor.value as (
          ...arguments_: readonly unknown[]
        ) => unknown;
      }
    }
    owner = intrinsicGetPrototypeOf(owner) as object | null;
  }

  if (owner !== null || cancel === undefined) return undefined;
  return { cancel, source: body };
}

function cancelReader(
  reader: ResponseBodyReader,
): void {
  try {
    if (reader.cancel === undefined) return;
    observeCleanupPromise(
      intrinsicApply(reader.cancel, reader.source, []),
    );
  } catch {
    // The primary limit, cancellation, or transport failure remains authoritative.
  }
}

function releaseReader(
  reader: ResponseBodyReader,
): void {
  try {
    if (reader.releaseLock === undefined) return;
    intrinsicApply(reader.releaseLock, reader.source, []);
  } catch {
    // An in-flight injected read must not displace the primary operation result.
  }
}

function readResponseStatus(
  response: Response,
  options: RepositoryOperationOptions,
): number {
  let status: unknown;
  try {
    status = response.status;
  } catch {
    throw responseSurfaceFailure(response, options);
  }
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 0 ||
    status > 599
  ) {
    throw responseSurfaceFailure(response, options);
  }
  return status;
}

function readResponseOk(
  response: Response,
  options: RepositoryOperationOptions,
): boolean {
  let ok: unknown;
  try {
    ok = response.ok;
  } catch {
    throw responseSurfaceFailure(response, options);
  }
  if (typeof ok !== "boolean") {
    throw responseSurfaceFailure(response, options);
  }
  return ok;
}

function responseSurfaceFailure(
  response: Response,
  options: RepositoryOperationOptions,
): EvidenceRepositoryError {
  cancelResponse(response);
  return options.signal?.aborted === true
    ? ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      )
    : responseProtocolFailure();
}

function responseProtocolFailure(): EvidenceRepositoryError {
  return ipfsDependencyError(
    "IO_FAILURE",
    "The configured IPFS block endpoint returned an invalid response.",
    "block-read",
    "protocol-failure",
  );
}

function repositoryError(
  code: EvidenceRepositoryErrorCode,
  message: string,
  operation: "block-read",
  failureKind:
    | "access-denied"
    | "protocol-failure"
    | "unavailable",
): EvidenceRepositoryError {
  return ipfsDependencyError(
    code,
    message,
    operation,
    failureKind,
  );
}

function responseLimitError(
  code: EvidenceRepositoryErrorCode,
  message: string,
  dependencyFailure:
    | {
        readonly failureKind: "protocol-failure" | "unavailable";
        readonly operation: "block-read";
      }
    | undefined,
): EvidenceRepositoryError {
  return dependencyFailure === undefined
    ? ipfsRepositoryError(code, message)
    : ipfsDependencyError(
        code,
        message,
        dependencyFailure.operation,
        dependencyFailure.failureKind,
      );
}
