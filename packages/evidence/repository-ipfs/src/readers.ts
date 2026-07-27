// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isUint8Array } from "node:util/types";

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
  let reader: ReadableStreamDefaultReader<Uint8Array>;
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
    reader = Reflect.apply(getReader, body, []) as
      ReadableStreamDefaultReader<Uint8Array>;
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
      const item = await readNextChunk(reader, options);
      assertRepositoryOperationActive(options);
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
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: RepositoryOperationOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  assertRepositoryOperationActive(options);
  const signal = options.signal;
  if (signal === undefined) return reader.read();

  let rejectAbort!: (error: EvidenceRepositoryError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
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
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    const cancel = reader.cancel;
    if (typeof cancel !== "function") return;
    void Promise.resolve(Reflect.apply(cancel, reader, [])).catch(() => {
      // The primary limit, cancellation, or transport failure remains authoritative.
    });
  } catch {
    // The primary limit, cancellation, or transport failure remains authoritative.
  }
}

function releaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    const releaseLock = reader.releaseLock;
    if (typeof releaseLock !== "function") return;
    Reflect.apply(releaseLock, reader, []);
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
