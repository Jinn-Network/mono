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

type HeaderPair = readonly [string, string];
type BodyResult = { readonly kind: "body"; readonly body: Uint8Array } | { readonly kind: "refused" };
type FramedBody = { readonly body: Uint8Array | undefined; readonly contentLength: number | undefined };
type ServerOutput = {
  writeHead(status: number, headers: string[]): unknown;
  end(body?: Uint8Array): unknown;
  destroy(): unknown;
};
type SocketOutput = { write(chunk: string): unknown; end(chunk?: Uint8Array): unknown; destroy(): unknown };
type Output = { readonly kind: "server"; readonly value: ServerOutput } | { readonly kind: "socket"; readonly value: SocketOutput };
type Admission =
  | { readonly kind: "admitted"; readonly before: { readonly requests: number; readonly bytes: number }; responded: boolean }
  | { readonly kind: "budget-exhausted" };
type ActiveAttempt = {
  readonly admission: Extract<Admission, { kind: "admitted" }>;
  readonly method: string | undefined;
  readonly output: Output;
  readonly parserIncomplete: () => boolean;
};
type DeferredSocketRefusal =
  | {
    readonly kind: "admitted";
    readonly admission: Extract<Admission, { kind: "admitted" }>;
    readonly output: Output;
    readonly method: string | undefined;
  }
  | { readonly kind: "budget-exhausted"; readonly output: Output; readonly method: string | undefined };
type SocketAttempts = {
  readonly attempts: ActiveAttempt[];
  terminal: boolean;
  deferred: DeferredSocketRefusal | undefined;
};

const LOOPBACK_VALUES = Object.freeze(["127.0.0.1", "::1"] as const);
const NUMERIC_LOOPBACK_HOSTS = new Set<string>(LOOPBACK_VALUES);
const STATIC_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SERVICE_CONTROL_HEADERS = new Set([
  "content-length",
  "x-jinn-replay",
  "x-jinn-replay-limit",
  "x-jinn-replay-reason",
]);
const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
const encoder = new TextEncoder();

function frozenStringSet(values: readonly string[]): ReadonlySet<string> {
  const snapshot = Object.freeze([...values]);
  const members = new Set(snapshot);
  let facade: ReadonlySet<string>;
  facade = Object.freeze({
    size: snapshot.length,
    has: (value: string): boolean => members.has(value),
    keys: (): IterableIterator<string> => snapshot[Symbol.iterator](),
    values: (): IterableIterator<string> => snapshot[Symbol.iterator](),
    entries: (): IterableIterator<[string, string]> => snapshot
      .map((value) => [value, value] as [string, string])[Symbol.iterator](),
    forEach: (callback: (value: string, again: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void => {
      for (const value of snapshot) callback.call(thisArg, value, value, facade);
    },
    [Symbol.iterator]: (): IterableIterator<string> => snapshot[Symbol.iterator](),
  }) as ReadonlySet<string>;
  return facade;
}

/** The only addresses this service is permitted to bind. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = frozenStringSet(LOOPBACK_VALUES);

export class NonLoopbackBindError extends InvalidDocumentError {
  constructor(host: string) {
    super([{
      path: "listen.host",
      message: `replay services bind numeric loopback only; "${host}" is not 127.0.0.1 or ::1`,
    }]);
    this.name = "NonLoopbackBindError";
  }
}

function invalidDocument(path: string, message: string): InvalidDocumentError {
  return new InvalidDocumentError([{ path, message }]);
}

function listenAddress(value: ListenAddress): ListenAddress {
  const { host, port } = value;
  if (typeof host !== "string" || !NUMERIC_LOOPBACK_HOSTS.has(host)) {
    throw new NonLoopbackBindError(typeof host === "string" ? host : String(host));
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw invalidDocument("listen.port", "must be an integer from 0 through 65535");
  }
  return Object.freeze({ host, port });
}

function defaultScheme(value: ReplayServiceOptions["defaultScheme"]): "http" | "https" {
  if (value === undefined) return "https";
  if (value === "http" || value === "https") return value;
  throw invalidDocument("defaultScheme", "must be http or https");
}

function isAsciiWithoutControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit > 0x7e || codeUnit < 0x21 || codeUnit === 0x7f) return false;
  }
  return true;
}

function validPort(value: string): boolean {
  if (value === "" || !/^[0-9]+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535;
}

/** Validate a Host/authority before it can be concatenated into an absolute URL. */
function authority(value: string): string | undefined {
  if (value === "" || !isAsciiWithoutControls(value) || /[/?#@%\\]/.test(value)) return undefined;

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return undefined;
    const suffix = value.slice(close + 1);
    if (suffix !== "" && (!suffix.startsWith(":") || !validPort(suffix.slice(1)))) return undefined;
  } else {
    const firstColon = value.indexOf(":");
    if (firstColon !== -1) {
      if (value.indexOf(":", firstColon + 1) !== -1 || !validPort(value.slice(firstColon + 1))) return undefined;
      if (firstColon === 0) return undefined;
    }
  }

  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return undefined;
  } catch {
    return undefined;
  }
  return value;
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

/** Turn one valid origin-form or absolute-form target into the URL a key consumes. */
function targetUrl(
  target: string | undefined,
  headers: readonly HeaderPair[],
  scheme: "http" | "https",
): string | undefined {
  if (target === undefined || target === "" || !isAsciiWithoutControls(target) || target.includes("#")) {
    return undefined;
  }
  const absolute = /^https?:\/\/([^/?#]*)(?:[/?][\s\S]*)?$/i.exec(target);
  if (absolute !== null) return authority(absolute[1] as string) === undefined ? undefined : target;
  if (!target.startsWith("/")) return undefined;

  const host = headerValue(headers, "host");
  if (host === undefined || authority(host) === undefined) return undefined;
  const forwarded = headerValue(headers, "x-jinn-forwarded-proto");
  const selected = forwarded === undefined ? scheme : asciiLowercase(forwarded);
  if (selected !== "http" && selected !== "https") return undefined;
  return `${selected}://${host}${target}`;
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

/** A message without a declared body is parser-complete as soon as its request event fires. */
function requestCanCarryBody(rawHeaders: readonly string[]): boolean {
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) continue;
    const normalized = asciiLowercase(name);
    if (normalized === "transfer-encoding") return true;
    if (normalized === "content-length" && !/^0+$/.test(value)) return true;
  }
  return false;
}

function nodeHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit > 0xff || (codeUnit < 0x20 && codeUnit !== 0x09) || codeUnit === 0x7f) return false;
  }
  return true;
}

function nodeHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function responseHeaders(sealed: readonly HeaderPair[], path: string): readonly HeaderPair[] {
  const nominated = new Set<string>();
  for (const [name, value] of sealed) {
    if (!nodeHeaderName(name)) throw invalidDocument(path, `header name "${name}" cannot be expressed by node:http`);
    if (!nodeHeaderValue(value)) throw invalidDocument(path, `header "${name}" cannot be expressed by node:http`);
    if (asciiLowercase(name) === "connection") {
      for (const member of value.split(",")) {
        const normalized = asciiLowercase(member.trim());
        if (normalized !== "") nominated.add(normalized);
      }
    }
  }
  return Object.freeze(sealed.filter(([name]) => {
    const normalized = asciiLowercase(name);
    return !STATIC_HOP_BY_HOP_HEADERS.has(normalized)
      && !SERVICE_CONTROL_HEADERS.has(normalized)
      && !nominated.has(normalized);
  }).map(([name, value]) => Object.freeze([name, value] as [string, string])));
}

function framedBody(status: number, method: string | undefined, body: Uint8Array): FramedBody {
  if ((status >= 100 && status < 200) || status === 204 || status === 205) {
    return Object.freeze({ body: undefined, contentLength: undefined });
  }
  if (method === "HEAD" || status === 304) {
    return Object.freeze({ body: undefined, contentLength: body.byteLength });
  }
  return Object.freeze({ body, contentLength: body.byteLength });
}

function wireHeaders(
  sealed: readonly HeaderPair[],
  replay: "hit" | "miss" | "off-allowlist" | "budget-exhausted",
  frame: FramedBody,
  details: readonly HeaderPair[] = [],
): string[] {
  const headers = sealed.flatMap(([name, value]) => [name, value]);
  if (frame.contentLength !== undefined) headers.push("content-length", String(frame.contentLength));
  headers.push("x-jinn-replay", replay);
  for (const [name, value] of details) headers.push(name, value);
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

function send(output: Output, status: number, headers: string[], frame: FramedBody): void {
  try {
    if (output.kind === "server") {
      output.value.writeHead(status, headers);
      output.value.end(frame.body);
      return;
    }
    output.value.write(`HTTP/1.1 ${status} Replay Refusal\r\n`);
    for (let index = 0; index < headers.length; index += 2) {
      output.value.write(`${headers[index] as string}: ${headers[index + 1] as string}\r\n`);
    }
    output.value.write("\r\n");
    output.value.end(frame.body);
  } catch {
    output.value.destroy();
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
  const scheme = defaultScheme(options.defaultScheme);
  const onEvent = options.onEvent;
  const index = await buildReplayIndex(world, options);
  const missPolicy = index.world.missPolicy;
  const missBody = encoder.encode(missPolicy.body.inlineUtf8);
  const missHeaders = responseHeaders(missPolicy.headers, "missPolicy.headers");
  const hitHeaders = new Map<string, readonly HeaderPair[]>();
  index.world.corpus.entries.forEach((entry, entryIndex) => {
    hitHeaders.set(entry.requestKey, responseHeaders(entry.response.headers, `corpus.entries.${entryIndex}.response.headers`));
  });

  const consumed = { requests: 0, bytes: 0 };
  const counts = { requests: 0, hits: 0, misses: 0, offAllowlist: 0, budgetExhausted: 0 };
  const attemptsBySocket = new WeakMap<object, SocketAttempts>();

  const emit = (event: ReplayEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // An observer cannot make a sealed response fail or create a second behavior branch.
    }
  };
  const admit = (): Admission => {
    counts.requests += 1;
    if (index.budget !== undefined && consumed.requests >= index.budget.maxRequests) {
      counts.budgetExhausted += 1;
      return { kind: "budget-exhausted" };
    }
    const before = Object.freeze({ requests: consumed.requests, bytes: consumed.bytes });
    consumed.requests += 1;
    return { kind: "admitted", before, responded: false };
  };
  const answer = (
    output: Output,
    admission: Extract<Admission, { kind: "admitted" }>,
    method: string | undefined,
    outcome: ReplayOutcome,
  ): void => {
    if (admission.responded) return;
    admission.responded = true;
    switch (outcome.kind) {
      case "hit": {
        const body = index.bodyOf(outcome.entry.requestKey);
        const headers = hitHeaders.get(outcome.entry.requestKey);
        if (headers === undefined) throw invalidDocument("corpus", "response headers were not preflighted");
        counts.hits += 1;
        const frame = framedBody(outcome.entry.response.status, method, body);
        send(output, outcome.entry.response.status, wireHeaders(headers, "hit", frame), frame);
        emit({ kind: "hit", requestKey: outcome.entry.requestKey, bytes: body.byteLength });
        return;
      }
      case "miss": {
        counts.misses += 1;
        const frame = framedBody(missPolicy.status, method, missBody);
        send(output, missPolicy.status, wireHeaders(
          missHeaders,
          "miss",
          frame,
          [["x-jinn-replay-reason", outcome.reason]],
        ), frame);
        emit(outcome);
        return;
      }
      case "off-allowlist": {
        counts.offAllowlist += 1;
        const body = encoder.encode('{"error":"origin is not reachable in this world"}');
        const frame = framedBody(403, method, body);
        send(output, 403, wireHeaders([], "off-allowlist", frame), frame);
        emit(outcome);
        return;
      }
      case "budget-exhausted": {
        counts.budgetExhausted += 1;
        const body = encoder.encode('{"error":"request budget exhausted"}');
        const frame = framedBody(429, method, body);
        send(output, 429, wireHeaders(
          [],
          "budget-exhausted",
          frame,
          [["x-jinn-replay-limit", outcome.limit]],
        ), frame);
        emit(outcome);
      }
    }
  };
  const answerBudget = (output: Output, method: string | undefined): void => {
    const body = encoder.encode('{"error":"request budget exhausted"}');
    const frame = framedBody(429, method, body);
    send(output, 429, wireHeaders(
      [],
      "budget-exhausted",
      frame,
      [["x-jinn-replay-limit", "requests"]],
    ), frame);
    emit({ kind: "budget-exhausted", limit: "requests" });
  };
  const begin = (output: Output, method: string | undefined): Extract<Admission, { kind: "admitted" }> | undefined => {
    const admission = admit();
    if (admission.kind === "budget-exhausted") {
      answerBudget(output, method);
      return undefined;
    }
    return admission;
  };

  const socketAttempts = (socket: object): SocketAttempts => {
    const existing = attemptsBySocket.get(socket);
    if (existing !== undefined) return existing;
    const state: SocketAttempts = { attempts: [], terminal: false, deferred: undefined };
    attemptsBySocket.set(socket, state);
    return state;
  };
  const flushDeferredSocketRefusal = (state: SocketAttempts): void => {
    if (state.attempts.length !== 0 || state.deferred === undefined) return;
    const deferred = state.deferred;
    state.deferred = undefined;
    if (deferred.kind === "admitted") {
      answer(deferred.output, deferred.admission, deferred.method, { kind: "miss", reason: "unkeyable" });
      return;
    }
    answerBudget(deferred.output, deferred.method);
  };
  const releaseAttempt = (socket: object, attempt: ActiveAttempt, terminal = false): void => {
    const state = attemptsBySocket.get(socket);
    if (state === undefined) return;
    const position = state.attempts.indexOf(attempt);
    if (position !== -1) state.attempts.splice(position, 1);
    if (terminal) state.terminal = true;
    flushDeferredSocketRefusal(state);
    if (state.attempts.length === 0 && !state.terminal && state.deferred === undefined) attemptsBySocket.delete(socket);
  };
  const startAttempt = (
    socket: object,
    output: Output,
    method: string | undefined,
    terminal = false,
    parserIncomplete: () => boolean = () => false,
  ): ActiveAttempt | undefined => {
    const state = socketAttempts(socket);
    if (!terminal && state.terminal && state.attempts.length === 0) state.terminal = false;
    const admission = begin(output, method);
    if (admission === undefined) {
      if (terminal) state.terminal = true;
      return undefined;
    }
    const attempt: ActiveAttempt = { admission, method, output, parserIncomplete };
    state.attempts.push(attempt);
    if (terminal) state.terminal = true;
    return attempt;
  };
  const resolveRequest = (
    method: string,
    url: string,
    headers: readonly HeaderPair[],
    body: Uint8Array,
    admission: Extract<Admission, { kind: "admitted" }>,
  ): ReplayOutcome => {
    const outcome = resolveReplay(index, { method, url, headers, body }, {
      requests: admission.before.requests,
      bytes: consumed.bytes,
    });
    if (outcome.kind === "hit") consumed.bytes += index.bodyOf(outcome.entry.requestKey).byteLength;
    return outcome;
  };

  const server = createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES }, (incoming, outgoing) => {
    const output: Output = { kind: "server", value: outgoing };
    const lifecycle = { complete: incoming.complete || !requestCanCarryBody(incoming.rawHeaders) };
    incoming.once("end", () => { lifecycle.complete = true; });
    const attempt = startAttempt(
      incoming.socket,
      output,
      incoming.method,
      false,
      () => !lifecycle.complete && !incoming.complete,
    );
    if (attempt === undefined) {
      incoming.resume();
      return;
    }
    const release = (): void => releaseAttempt(incoming.socket, attempt);
    outgoing.once("finish", release);
    outgoing.once("close", release);
    const serve = async (): Promise<void> => {
      const body = await requestBody(incoming);
      if (attempt.admission.responded) return;
      if (body.kind === "refused") {
        answer(output, attempt.admission, attempt.method, { kind: "miss", reason: "unkeyable" });
        return;
      }
      const headers = requestHeaders(incoming.rawHeaders);
      const url = incoming.method === "CONNECT" ? undefined : targetUrl(incoming.url, headers, scheme);
      const outcome: ReplayOutcome = url === undefined
        ? { kind: "miss", reason: "unkeyable" }
        : resolveRequest(incoming.method ?? "GET", url, headers, body.body, attempt.admission);
      answer(output, attempt.admission, attempt.method, outcome);
    };
    void serve().catch(() => {
      answer(output, attempt.admission, attempt.method, { kind: "miss", reason: "unkeyable" });
    });
  });

  const socketEvent = (socket: SocketOutput & object, method: string | undefined): void => {
    const output: Output = { kind: "socket", value: socket };
    const state = socketAttempts(socket);
    if (state.terminal) return;
    state.terminal = true;
    const admission = admit();
    state.deferred = admission.kind === "admitted"
      ? { kind: "admitted", admission, output, method }
      : { kind: "budget-exhausted", output, method };
    flushDeferredSocketRefusal(state);
  };
  server.on("connect", (_incoming, socket) => socketEvent(socket, "CONNECT"));
  server.on("upgrade", (_incoming, socket) => socketEvent(socket, "GET"));
  server.on("checkContinue", (incoming, outgoing) => {
    const output: Output = { kind: "server", value: outgoing };
    const attempt = startAttempt(incoming.socket, output, incoming.method, true);
    incoming.resume();
    if (attempt !== undefined) {
      answer(output, attempt.admission, attempt.method, { kind: "miss", reason: "unkeyable" });
      releaseAttempt(incoming.socket, attempt, true);
    }
  });
  server.on("checkExpectation", (incoming, outgoing) => {
    const output: Output = { kind: "server", value: outgoing };
    const attempt = startAttempt(incoming.socket, output, incoming.method, true);
    incoming.resume();
    if (attempt !== undefined) {
      answer(output, attempt.admission, attempt.method, { kind: "miss", reason: "unkeyable" });
      releaseAttempt(incoming.socket, attempt, true);
    }
  });
  server.on("clientError", (_error, socket) => {
    const state = attemptsBySocket.get(socket);
    const attempt = [...(state?.attempts ?? [])].reverse().find((candidate) => candidate.parserIncomplete());
    if (attempt !== undefined) {
      answer(attempt.output, attempt.admission, attempt.method, { kind: "miss", reason: "unkeyable" });
      releaseAttempt(socket, attempt);
      return;
    }
    if (state?.terminal) return;
    socketEvent(socket, undefined);
  });

  const address = await new Promise<ListenAddress>((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error);
    server.once("error", rejectListen);
    server.listen({ host: listen.host, port: listen.port }, () => {
      server.off("error", rejectListen);
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        server.close();
        reject(invalidDocument("listen", "did not bind an IP socket"));
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
