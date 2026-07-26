// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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

const MAX_KUBO_ERROR_BODY_BYTES = 64 * 1024;
const RAW_BLOCK_ACCEPT = "application/vnd.ipld.raw";

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

      if (response.status === 401 || response.status === 403) {
        await cancelResponse(response);
        throw repositoryError(
          "ACCESS_DENIED",
          `Kubo block read was denied with HTTP ${response.status}.`,
        );
      }
      if (response.status === 500) {
        const errorBytes = await readBoundedResponse(
          response,
          MAX_KUBO_ERROR_BODY_BYTES,
          operationOptions,
          "DEPENDENCY_UNAVAILABLE",
          "Kubo error response exceeded the pinned envelope limit.",
        );
        if (isPinnedKuboNotFound(errorBytes, canonicalCid)) {
          return null;
        }
        throw repositoryError(
          "DEPENDENCY_UNAVAILABLE",
          "Kubo returned an unrecognized command error envelope.",
        );
      }
      if (!response.ok) {
        await cancelResponse(response);
        throw mapHttpFailure("Kubo", response.status);
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

      if (response.status === 404) {
        await cancelResponse(response);
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        await cancelResponse(response);
        throw repositoryError(
          "ACCESS_DENIED",
          `Gateway block read was denied with HTTP ${response.status}.`,
        );
      }
      if (!response.ok) {
        await cancelResponse(response);
        throw mapHttpFailure("Gateway", response.status);
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
  } catch (error) {
    throw repositoryError(
      "INVALID_REFERENCE",
      `${label} endpoint must be an absolute HTTP(S) URL.`,
      error,
    );
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw repositoryError(
      "INVALID_REFERENCE",
      `${label} endpoint must be an HTTP(S) URL without userinfo, query, or fragment.`,
    );
  }
  return endpoint;
}

function parseMaxBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError(
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
  try {
    return await fetchCapability(input, init);
  } catch (error) {
    if (
      options.signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw repositoryError(
        "OPERATION_ABORTED",
        "The IPFS block read was aborted.",
        error,
      );
    }
    throw repositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "The configured IPFS block endpoint was unavailable.",
      error,
    );
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  options: RepositoryOperationOptions,
  tooLargeCode: EvidenceRepositoryErrorCode,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^[0-9]+$/u.test(declaredLength)) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maxBytes) {
      await cancelResponse(response);
      throw repositoryError(tooLargeCode, tooLargeMessage);
    }
  }

  if (response.body === null) return new Uint8Array();

  const output = new Uint8Array(maxBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      assertRepositoryOperationActive(options);
      const item = await reader.read();
      assertRepositoryOperationActive(options);
      if (item.done) break;
      const chunk = item.value;
      if (chunk.byteLength > maxBytes - offset) {
        await cancelReader(reader);
        throw repositoryError(tooLargeCode, tooLargeMessage);
      }
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof EvidenceRepositoryError) throw error;
    await cancelReader(reader);
    if (
      options.signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw repositoryError(
        "OPERATION_ABORTED",
        "The IPFS response stream was aborted.",
        error,
      );
    }
    throw repositoryError(
      "DEPENDENCY_UNAVAILABLE",
      "The IPFS response stream failed.",
      error,
    );
  } finally {
    reader.releaseLock();
  }
  return output.subarray(0, offset);
}

function verifyBlock(bytes: Uint8Array, cid: string): Uint8Array {
  const expectedDigest = rawCidToDigest(cid);
  const actualDigest = parseSha256Digest(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  if (actualDigest !== expectedDigest) {
    throw repositoryError(
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
  if (status === 429 || status >= 500) {
    return repositoryError(
      "DEPENDENCY_UNAVAILABLE",
      `${dependency} block read failed with HTTP ${status}.`,
    );
  }
  return repositoryError(
    "IO_FAILURE",
    `${dependency} block read failed with HTTP ${status}.`,
  );
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // The primary HTTP classification remains authoritative.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The primary limit, cancellation, or transport failure remains authoritative.
  }
}

function repositoryError(
  code: EvidenceRepositoryErrorCode,
  message: string,
  cause?: unknown,
): EvidenceRepositoryError {
  return new EvidenceRepositoryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
