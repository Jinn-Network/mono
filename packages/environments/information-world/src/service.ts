// This is the sole production transport boundary in this package. It binds an injected
// numeric loopback address and serves sealed bytes; it never creates an outbound client.
import { createServer } from "node:http";

import { asciiLowercase } from "./ascii.js";
import {
  buildReplayIndex,
  resolveReplay,
  type ReplayIndexOptions,
  type ReplayOutcome,
} from "./replay.js";
import { InvalidDocumentError } from "./sealing.js";
import type { InformationWorldRecord } from "./schema.js";

export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

export type ReplayEvent =
  | { readonly kind: "hit"; readonly requestKey: string; readonly bytes: number }
  | { readonly kind: "miss"; readonly reason: "uncaptured" | "unkeyable" }
  | { readonly kind: "off-allowlist"; readonly origin: string }
  | { readonly kind: "budget-exhausted"; readonly limit: "requests" | "bytes" };

export interface ReplayServiceOptions extends ReplayIndexOptions {
  readonly listen: ListenAddress;
  readonly defaultScheme?: "http" | "https";
  readonly onEvent?: (event: ReplayEvent) => void;
}

export interface ReplayStats {
  readonly requests: number;
  readonly hits: number;
  readonly misses: number;
  readonly offAllowlist: number;
  readonly budgetExhausted: number;
  readonly bytes: number;
}

export interface ReplayService {
  readonly url: string;
  readonly address: ListenAddress;
  stats(): ReplayStats;
  close(): Promise<void>;
}

const LOOPBACK_VALUES = Object.freeze(["127.0.0.1", "::1", "localhost"] as const);
const NUMERIC_LOOPBACK_HOSTS = new Set<string>(["127.0.0.1", "::1"]);
const TRANSPORT_CONTROL_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-jinn-replay",
  "x-jinn-replay-limit",
  "x-jinn-replay-reason",
]);
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;

/** Legacy declaration surface; binding accepts only the two numeric members. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = Object.freeze(new Set(LOOPBACK_VALUES));

export class NonLoopbackBindError extends InvalidDocumentError {
  constructor(host: string) {
    super([{
      path: "listen.host",
      message: `replay services bind numeric loopback only; "${host}" is not 127.0.0.1 or ::1`,
    }]);
    this.name = "NonLoopbackBindError";
  }
}

type HeaderPair = readonly [string, string];
type BodyResult = { readonly kind: "body"; readonly body: Uint8Array } | { readonly kind: "refused" };

function invalidListen(path: string, message: string): InvalidDocumentError {
  return new InvalidDocumentError([{ path, message }]);
}

function listenAddress(value: ListenAddress): ListenAddress {
  const { host, port } = value;
  if (typeof host !== "string" || !NUMERIC_LOOPBACK_HOSTS.has(host)) {
    throw new NonLoopbackBindError(typeof host === "string" ? host : String(host));
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw invalidListen("listen.port", "must be an integer from 0 through 65535");
  }
  return Object.freeze({ host, port });
}

function scheme(value: ReplayServiceOptions["defaultScheme"]): "http" | "https" {
  if (value === undefined) return "https";
  if (value === "http" || value === "https") return value;
  throw invalidListen("defaultScheme", "must be http or https");
}

function hasSafeHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if ((codeUnit < 0x20 && codeUnit !== 0x09) || codeUnit === 0x7f) return false;
  }
  return true;
}

function responseHeaders(
  sealed: readonly HeaderPair[],
  replay: "hit" | "miss" | "off-allowlist" | "budget-exhausted",
  length: number,
  details: readonly HeaderPair[] = [],
): string[] {
  const headers: string[] = [];
  for (const [name, value] of sealed) {
    if (TRANSPORT_CONTROL_HEADERS.has(asciiLowercase(name)) || !hasSafeHeaderValue(value)) continue;
    headers.push(name, value);
  }
  headers.push("content-length", String(length), "x-jinn-replay", replay);
  for (const [name, value] of details) headers.push(name, value);
  return headers;
}

function headerValue(headers: readonly HeaderPair[], wanted: string): string | undefined {
  let found: string | undefined;
  for (const [name, value] of headers) {
    if (asciiLowercase(name) !== wanted) continue;
    if (found !== undefined) return undefined;
    found = value;
  }
  return found;
}

/** Turn one HTTP target into the absolute URL expected by canonical request keys. */
function targetUrl(
  target: string | undefined,
  headers: readonly HeaderPair[],
  defaultScheme: "http" | "https",
): string | undefined {
  if (target === undefined || target === "") return undefined;
  if (/^https?:\/\//i.test(target)) return target;
  if (!target.startsWith("/")) return undefined;

  const host = headerValue(headers, "host");
  if (host === undefined || host === "") return undefined;
  const forwarded = headerValue(headers, "x-jinn-forwarded-proto");
  const selectedScheme = forwarded === undefined ? defaultScheme : asciiLowercase(forwarded);
  if (selectedScheme !== "http" && selectedScheme !== "https") return undefined;
  return `${selectedScheme}://${host}${target}`;
}

function requestHeaders(rawHeaders: readonly string[]): HeaderPair[] {
  const headers: HeaderPair[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.push([name, value]);
  }
  return headers;
}

async function requestBody(incoming: {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  once(event: "aborted" | "end" | "error", listener: () => void): unknown;
  resume(): unknown;
}): Promise<BodyResult> {
  return await new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let refused = false;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    incoming.on("data", (chunk: unknown) => {
      if (!(chunk instanceof Uint8Array) || refused) return;
      if (chunk.byteLength > MAX_REQUEST_BODY_BYTES - length) {
        refused = true;
        chunks.length = 0;
        return;
      }
      length += chunk.byteLength;
      chunks.push(Uint8Array.from(chunk));
    });
    incoming.once("aborted", () => finish({ kind: "refused" }));
    incoming.once("error", () => finish({ kind: "refused" }));
    incoming.once("end", () => {
      if (refused) {
        finish({ kind: "refused" });
        return;
      }
      const body = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      finish({ kind: "body", body });
    });
    incoming.resume();
  });
}

function sendResponse(
  outgoing: { writeHead(status: number, headers: string[]): unknown; end(body: Uint8Array): unknown; destroy(): unknown },
  status: number,
  headers: string[],
  body: Uint8Array,
): void {
  try {
    outgoing.writeHead(status, headers);
    outgoing.end(body);
  } catch {
    outgoing.destroy();
  }
}

function sendSocketResponse(
  socket: { write(chunk: string): unknown; end(chunk: Uint8Array): unknown; destroy(): unknown },
  status: number,
  headers: string[],
  body: Uint8Array,
): void {
  try {
    socket.write(`HTTP/1.1 ${status} Replay Refusal\r\n`);
    for (let index = 0; index < headers.length; index += 2) {
      socket.write(`${headers[index] as string}: ${headers[index + 1] as string}\r\n`);
    }
    socket.write("\r\n");
    socket.end(body);
  } catch {
    socket.destroy();
  }
}

function serviceUrl(address: ListenAddress): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `http://${host}:${address.port}`;
}

/** Serve a fully materialized sealed information world over plain loopback HTTP. */
export async function createReplayService(
  world: InformationWorldRecord,
  options: ReplayServiceOptions,
): Promise<ReplayService> {
  const listen = listenAddress(options.listen);
  const defaultScheme = scheme(options.defaultScheme);
  const onEvent = options.onEvent;
  const index = await buildReplayIndex(world, options);
  const missPolicy = index.world.missPolicy;
  const missBody = new TextEncoder().encode(missPolicy.body.inlineUtf8);
  const consumed = { requests: 0, bytes: 0 };
  const counts = { requests: 0, hits: 0, misses: 0, offAllowlist: 0, budgetExhausted: 0 };

  const emit = (event: ReplayEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // An observer cannot make a sealed response fail or create a second behavior branch.
    }
  };
  const recordMiss = (
    outgoing: { writeHead(status: number, headers: string[]): unknown; end(body: Uint8Array): unknown; destroy(): unknown },
    reason: "uncaptured" | "unkeyable",
  ): void => {
    consumed.requests += 1;
    counts.misses += 1;
    sendResponse(outgoing, missPolicy.status, responseHeaders(
      missPolicy.headers,
      "miss",
      missBody.byteLength,
      [["x-jinn-replay-reason", reason]],
    ), missBody);
    emit({ kind: "miss", reason });
  };
  const recordSocketMiss = (
    socket: { write(chunk: string): unknown; end(chunk: Uint8Array): unknown; destroy(): unknown },
  ): void => {
    consumed.requests += 1;
    counts.misses += 1;
    sendSocketResponse(socket, missPolicy.status, responseHeaders(
      missPolicy.headers,
      "miss",
      missBody.byteLength,
      [["x-jinn-replay-reason", "unkeyable"]],
    ), missBody);
    emit({ kind: "miss", reason: "unkeyable" });
  };

  const server = createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES }, (incoming, outgoing) => {
    const serve = async (): Promise<void> => {
      counts.requests += 1;
      const body = await requestBody(incoming);
      if (body.kind === "refused") {
        recordMiss(outgoing, "unkeyable");
        return;
      }

      const headers = requestHeaders(incoming.rawHeaders);
      const url = incoming.method === "CONNECT" ? undefined : targetUrl(incoming.url, headers, defaultScheme);
      const outcome: ReplayOutcome = url === undefined
        ? { kind: "miss", reason: "unkeyable" }
        : resolveReplay(index, {
          method: incoming.method ?? "GET",
          url,
          headers,
          body: body.body,
        }, consumed);

      switch (outcome.kind) {
        case "hit": {
          const responseBody = index.bodyOf(outcome.entry.requestKey);
          consumed.requests += 1;
          consumed.bytes += responseBody.byteLength;
          counts.hits += 1;
          sendResponse(outgoing, outcome.entry.response.status, responseHeaders(
            outcome.entry.response.headers,
            "hit",
            responseBody.byteLength,
          ), responseBody);
          emit({ kind: "hit", requestKey: outcome.entry.requestKey, bytes: responseBody.byteLength });
          return;
        }
        case "miss":
          recordMiss(outgoing, outcome.reason);
          return;
        case "off-allowlist": {
          const responseBody = new TextEncoder().encode('{"error":"origin is not reachable in this world"}');
          consumed.requests += 1;
          counts.offAllowlist += 1;
          sendResponse(outgoing, 403, responseHeaders([], "off-allowlist", responseBody.byteLength), responseBody);
          emit(outcome);
          return;
        }
        case "budget-exhausted": {
          const responseBody = new TextEncoder().encode('{"error":"request budget exhausted"}');
          counts.budgetExhausted += 1;
          sendResponse(outgoing, 429, responseHeaders(
            [],
            "budget-exhausted",
            responseBody.byteLength,
            [["x-jinn-replay-limit", outcome.limit]],
          ), responseBody);
          emit(outcome);
          return;
        }
      }
    };
    void serve().catch(() => recordMiss(outgoing, "unkeyable"));
  });

  server.on("connect", (_incoming, socket) => {
    counts.requests += 1;
    recordSocketMiss(socket);
  });
  server.on("upgrade", (_incoming, socket) => {
    counts.requests += 1;
    recordSocketMiss(socket);
  });
  server.on("checkContinue", (incoming, outgoing) => {
    counts.requests += 1;
    incoming.resume();
    recordMiss(outgoing, "unkeyable");
  });
  server.on("checkExpectation", (incoming, outgoing) => {
    counts.requests += 1;
    incoming.resume();
    recordMiss(outgoing, "unkeyable");
  });
  server.on("clientError", (_error, socket) => {
    counts.requests += 1;
    recordSocketMiss(socket);
  });

  const address = await new Promise<ListenAddress>((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error);
    server.once("error", rejectListen);
    server.listen({ host: listen.host, port: listen.port }, () => {
      server.off("error", rejectListen);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(invalidListen("listen", "did not bind an IP socket"));
        return;
      }
      resolve(Object.freeze({ host: listen.host, port: bound.port }));
    });
  });

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    url: serviceUrl(address),
    address,
    stats: (): ReplayStats => Object.freeze({ ...counts, bytes: consumed.bytes }),
    close: (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
      return closePromise;
    },
  });
}
