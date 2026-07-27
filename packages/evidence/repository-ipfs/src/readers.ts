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
const FETCH_ABORTED = Symbol("FETCH_ABORTED");
const MAX_READER_PROTOTYPE_DEPTH = 32;
const intrinsicApply = Reflect.apply;
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

type NativePromiseSettlement =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected" };

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
      const response = await performFetch(
        fetchCapability,
        url,
        {
          method: "POST",
          signal: operationOptions.signal,
        },
        operationOptions,
      );
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

      const response = await performFetch(
        fetchCapability,
        gatewayBlockUrl(endpoint, canonicalCid),
        {
          method: "GET",
          headers: { accept: RAW_BLOCK_ACCEPT },
          signal: operationOptions.signal,
        },
        operationOptions,
      );
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
): Promise<Response> {
  assertRepositoryOperationActive(options);
  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  let abortResult: Promise<typeof FETCH_ABORTED> | undefined;
  if (signal !== undefined) {
    let resolveAbort!: (result: typeof FETCH_ABORTED) => void;
    abortResult = new Promise((resolve) => {
      resolveAbort = resolve;
    });
    const abortListener = () => resolveAbort(FETCH_ABORTED);
    onAbort = abortListener;
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  }

  try {
    if (signal?.aborted === true) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }

    const fetchResult = Promise.resolve(
      fetchCapability(input, init),
    );
    void fetchResult
      .then(
        (response) => {
          if (signal?.aborted === true) cancelResponse(response);
        },
        () => {
          // Keep a losing injected fetch rejection observed.
        },
      )
      .catch(() => {
        // Detached late-response cleanup cannot escape publicly.
      });
    const result =
      abortResult === undefined
        ? await fetchResult
        : await Promise.race([fetchResult, abortResult]);
    if (result === FETCH_ABORTED) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }
    return result;
  } catch (error) {
    if (signal?.aborted === true) {
      throw ipfsRepositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
      );
    }
    throw ipfsDependencyError(
      "DEPENDENCY_UNAVAILABLE",
      "The configured IPFS block endpoint was unavailable.",
      "block-read",
      "unavailable",
    );
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
): Promise<{
  readonly status: "fulfilled";
  readonly value: unknown;
}> {
  assertRepositoryOperationActive(options);
  let pendingRead: Promise<NativePromiseSettlement>;
  try {
    pendingRead = observeReadPromise(
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

function raceNativePromises<T>(
  first: Promise<T>,
  second: Promise<never>,
): Promise<T> {
  if (!nativePromiseInfrastructureIsIntact()) {
    throw responseProtocolFailure();
  }
  return new NativePromise<T>((resolve, reject) => {
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

function observeReadPromise(
  value: unknown,
): Promise<NativePromiseSettlement> {
  if (!isSafelyObservableNativePromise(value)) {
    throw new TypeError(
      "Response body read() must return an exact native Promise.",
    );
  }

  let settle!: (value: NativePromiseSettlement) => void;
  const settlement = new NativePromise<NativePromiseSettlement>(
    (resolve) => {
      settle = resolve;
    },
  );
  intrinsicApply(nativePromiseThen, value, [
    (result: unknown) => {
      settle({ status: "fulfilled", value: result });
    },
    () => {
      settle({ status: "rejected" });
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

function cancelResponse(response: Response): void {
  try {
    const body = response.body;
    if (body === null) return;
    const cancel = body.cancel;
    if (typeof cancel !== "function") return;
    void Promise.resolve(Reflect.apply(cancel, body, [])).catch(() => {
      // The primary HTTP classification remains authoritative.
    });
  } catch {
    // The primary HTTP classification remains authoritative.
  }
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
