import { asciiLowercase, asciiUppercase, isAsciiHost, isHttpToken } from "./ascii.js";
import { serializeCanonicalJson } from "./canonical.js";
import { sha256Hex } from "./hashing.js";
import { assertIJsonString, type JsonValue } from "./json.js";
import { compareCodeUnitStrings } from "./order.js";
import {
  REQUEST_KEY_VERSION,
  assertRequestKeyPolicy,
  type RequestKeyPolicy,
} from "./request-key-policy.js";
import { InvalidDocumentError } from "./sealing.js";

/** A live request that cannot be reduced to one deterministic corpus key. */
export class InvalidRequestError extends Error {
  readonly category = "invalid-request" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export type HeaderInput =
  | readonly (readonly [string, string])[]
  | Readonly<Record<string, string | readonly string[]>>;

export interface CanonicalizableRequest {
  readonly method: string;
  /** Absolute `http:` or `https:` URL. */
  readonly url: string;
  readonly headers?: HeaderInput;
  readonly body?: Uint8Array | null;
}

/** `[name]` is valueless; `[name, value]` has an equals sign, even when value is empty. */
export type QueryPair = readonly [string] | readonly [string, string];

export interface CanonicalRequestParts {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly query: readonly QueryPair[];
  readonly headers: Readonly<Record<string, readonly string[]>>;
  /** Digest of the canonical body bytes, or null for an absent or empty body. */
  readonly body: string | null;
}

const ABSOLUTE_URL_WITH_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/;
const DEFAULT_PORTS = new Map<string, string>([["http:", "80"], ["https:", "443"]]);
const PERCENT_TRIPLET = /^%[0-9A-Fa-f]{2}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const CANONICAL_PART_KEYS = ["body", "headers", "method", "origin", "path", "query"];
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertRequestString(value: unknown, what: string): asserts value is string {
  if (typeof value !== "string") throw new InvalidRequestError(`${what} must be a string`);
  try {
    assertIJsonString(value);
  } catch {
    throw new InvalidRequestError(`${what} must contain only Unicode scalar values`);
  }
}

function invalidStoredPart(path: string, message: string): never {
  throw new InvalidDocumentError([{ path, message }]);
}

function storedString(value: unknown, path: string): string {
  if (typeof value !== "string") invalidStoredPart(path, "must be a string");
  try {
    assertIJsonString(value);
  } catch {
    invalidStoredPart(path, "must contain only Unicode scalar values");
  }
  return value;
}

function isValidHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 && codeUnit !== 0x09) return false;
    if (codeUnit === 0x7f) return false;
  }
  return true;
}

function isAsciiString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function normalizePercentEncoding(value: string, what: string, decodeSpace = false): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (character !== "%") {
      normalized += character;
      continue;
    }

    const triplet = value.slice(index, index + 3);
    if (!PERCENT_TRIPLET.test(triplet)) {
      throw new InvalidRequestError(`${what} contains a malformed percent-encoding`);
    }
    const upper = `%${asciiUppercase(triplet.slice(1))}`;
    const decoded = String.fromCharCode(Number.parseInt(upper.slice(1), 16));
    normalized += UNRESERVED.test(decoded) || (decodeSpace && decoded === " ") ? decoded : upper;
    index += 2;
  }
  return normalized;
}

function decodeUtf8Strict(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidRequestError(`${what} is not valid UTF-8`);
  }
}

function canonicalMethod(method: string): string {
  const upper = asciiUppercase(method);
  if (!isHttpToken(asciiLowercase(upper))) {
    throw new InvalidRequestError("method must be an HTTP token");
  }
  return upper;
}

function canonicalTarget(url: string, policy: RequestKeyPolicy): {
  origin: string;
  path: string;
  rawQuery: string;
} {
  assertRequestString(url, "request url");
  const authorityMatch = ABSOLUTE_URL_WITH_AUTHORITY.exec(url);
  if (authorityMatch === null) {
    throw new InvalidRequestError("request url must be an absolute URL with an authority");
  }
  const rawAuthority = authorityMatch[1] as string;
  if (!isAsciiHost(rawAuthority)) {
    throw new InvalidRequestError("request url authority must be ASCII");
  }
  if (rawAuthority.includes("%")) {
    throw new InvalidRequestError("request url authority must not use percent-encoding");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRequestError("request url must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRequestError("request url must use the http or https scheme");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidRequestError("request url must not carry userinfo");
  }
  if (!isAsciiHost(parsed.hostname)) {
    throw new InvalidRequestError("request url host must be ASCII");
  }

  const defaultPort = DEFAULT_PORTS.get(parsed.protocol);
  const port = parsed.port === "" || parsed.port === defaultPort ? "" : `:${parsed.port}`;
  let path = normalizePercentEncoding(parsed.pathname === "" ? "/" : parsed.pathname, "path");
  if (policy.pathTrailingSlash === "strip" && path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return {
    origin: `${parsed.protocol.slice(0, -1)}://${parsed.hostname}${port}`,
    path,
    rawQuery: parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search,
  };
}

function canonicalQuery(rawQuery: string, policy: RequestKeyPolicy): QueryPair[] {
  if (rawQuery === "") return [];
  const plusMeansSpace = policy.plusInQuery === "space";
  const pairs: QueryPair[] = [];
  for (const segment of rawQuery.split("&")) {
    if (segment === "") continue;
    const equals = segment.indexOf("=");
    const rawName = equals === -1 ? segment : segment.slice(0, equals);
    const prepare = (part: string): string => normalizePercentEncoding(
      plusMeansSpace ? part.split("+").join("%20") : part,
      "query",
      plusMeansSpace,
    );
    const name = prepare(rawName);
    pairs.push(equals === -1 ? [name] : [name, prepare(segment.slice(equals + 1))]);
  }
  return pairs.sort(compareQueryPairs);
}

function* headerEntries(headers: HeaderInput): Generator<readonly [string, string]> {
  if (Array.isArray(headers)) {
    for (const entry of headers as readonly unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new InvalidRequestError("header tuple input must contain two-member tuples");
      }
      const [name, value] = entry;
      assertRequestString(name, "header name");
      assertRequestString(value, "header value");
      yield [name, value];
    }
    return;
  }
  if (!isPlainRecord(headers)) {
    throw new InvalidRequestError("headers must be tuple input or a header record");
  }
  for (const [name, value] of Object.entries(
    headers as Readonly<Record<string, string | readonly string[]>>,
  )) {
    if (Array.isArray(value)) {
      for (const single of value as readonly unknown[]) {
        assertRequestString(single, "header value");
        yield [name, single];
      }
    } else {
      assertRequestString(value, "header value");
      yield [name, value];
    }
  }
}

function trimOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charAt(start) === " " || value.charAt(start) === "\t")) start += 1;
  while (end > start && (value.charAt(end - 1) === " " || value.charAt(end - 1) === "\t")) end -= 1;
  return value.slice(start, end);
}

function canonicalHeaders(
  headers: HeaderInput | undefined,
  policy: RequestKeyPolicy,
): Record<string, string[]> {
  const declared = new Set(policy.headerSubset);
  const collected = new Map<string, string[]>();
  if (headers !== undefined) {
    for (const [rawName, rawValue] of headerEntries(headers)) {
      if (!isHttpToken(asciiLowercase(rawName))) {
        throw new InvalidRequestError("header name must be an RFC 9110 token");
      }
      if (!isValidHeaderValue(rawValue)) {
        throw new InvalidRequestError("header value contains a forbidden control character");
      }
      const name = asciiLowercase(rawName);
      if (!declared.has(name)) continue;
      const values = collected.get(name) ?? [];
      values.push(trimOws(rawValue));
      collected.set(name, values);
    }
  }

  const canonical: Record<string, string[]> = {};
  for (const name of policy.headerSubset) {
    const values = collected.get(name);
    if (values !== undefined) canonical[name] = [...values].sort(compareCodeUnitStrings);
  }
  return canonical;
}

function canonicalBody(
  body: Uint8Array | null | undefined,
  policy: RequestKeyPolicy,
): string | null {
  if (body === undefined || body === null) return null;
  if (!(body instanceof Uint8Array)) {
    throw new InvalidRequestError("body must be a Uint8Array");
  }
  if (body.length === 0) return null;
  switch (policy.bodyCanonicalization) {
    case "opaque-bytes":
      return `sha256:${sha256Hex(body)}`;
    case "json-jcs": {
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(decodeUtf8Strict(body, "body")) as JsonValue;
        return `sha256:${sha256Hex(serializeCanonicalJson(parsed))}`;
      } catch (error) {
        if (error instanceof InvalidRequestError) throw error;
        throw new InvalidRequestError("body is not canonicalizable JSON under the json-jcs policy");
      }
    }
    case "utf8-trim":
      return `sha256:${sha256Hex(encoder.encode(decodeUtf8Strict(body, "body").trim()))}`;
  }
}

function compareQueryPairs(left: QueryPair, right: QueryPair): number {
  const byName = compareCodeUnitStrings(left[0], right[0]);
  if (byName !== 0) return byName;
  const leftValue = left.length === 2 ? left[1] : undefined;
  const rightValue = right.length === 2 ? right[1] : undefined;
  if (leftValue === undefined) return rightValue === undefined ? 0 : -1;
  if (rightValue === undefined) return 1;
  return compareCodeUnitStrings(leftValue, rightValue);
}

function validateStoredOrigin(value: unknown, policy: RequestKeyPolicy): string {
  const origin = storedString(value, "origin");
  let canonical: ReturnType<typeof canonicalTarget>;
  try {
    canonical = canonicalTarget(origin, policy);
  } catch (error) {
    if (error instanceof InvalidRequestError) invalidStoredPart("origin", error.message);
    throw error;
  }
  if (canonical.origin !== origin || canonical.path !== "/" || canonical.rawQuery !== "") {
    invalidStoredPart("origin", "must be an exact canonical HTTP origin without path, query, or fragment");
  }
  return origin;
}

function validateStoredPath(
  value: unknown,
  origin: string,
  policy: RequestKeyPolicy,
): string {
  const path = storedString(value, "path");
  if (!path.startsWith("/")) invalidStoredPart("path", "must be an absolute path");
  let canonical: ReturnType<typeof canonicalTarget>;
  try {
    canonical = canonicalTarget(`${origin}${path}`, policy);
  } catch (error) {
    if (error instanceof InvalidRequestError) invalidStoredPart("path", error.message);
    throw error;
  }
  if (canonical.origin !== origin || canonical.path !== path || canonical.rawQuery !== "") {
    invalidStoredPart("path", "must be the exact canonical path under the declared policy");
  }
  return path;
}

function validateStoredQueryComponent(
  value: unknown,
  path: string,
  policy: RequestKeyPolicy,
  isName: boolean,
): string {
  const component = storedString(value, path);
  if (!isAsciiString(component)) {
    invalidStoredPart(path, "must use canonical ASCII percent-encoding for non-ASCII data");
  }
  const plusMeansSpace = policy.plusInQuery === "space";
  let normalized: string;
  try {
    normalized = normalizePercentEncoding(
      plusMeansSpace ? component.split("+").join("%20") : component,
      "query",
      plusMeansSpace,
    );
  } catch (error) {
    if (error instanceof InvalidRequestError) invalidStoredPart(path, error.message);
    throw error;
  }
  if (normalized !== component) {
    invalidStoredPart(path, "must be the exact canonical query component under the declared policy");
  }
  for (let index = 0; index < component.length; index += 1) {
    const character = component.charAt(index);
    if (character === "%") {
      index += 2;
      continue;
    }
    const codeUnit = component.charCodeAt(index);
    const encodedByHttpUrl = codeUnit < 0x21
      || codeUnit === 0x7f
      || character === "\""
      || character === "'"
      || character === "<"
      || character === ">";
    const structuralDelimiter = character === "&" || character === "#"
      || (isName && character === "=");
    const canonicalSpace = character === " " && plusMeansSpace;
    if ((encodedByHttpUrl && !canonicalSpace) || structuralDelimiter) {
      invalidStoredPart(path, "contains a character that cannot occur literally in a canonical query component");
    }
  }
  return component;
}

function validateStoredQuery(value: unknown, policy: RequestKeyPolicy): QueryPair[] {
  if (!Array.isArray(value)) invalidStoredPart("query", "must be an array of query pairs");
  const query: QueryPair[] = value.map((candidate, index) => {
    if (!Array.isArray(candidate) || (candidate.length !== 1 && candidate.length !== 2)) {
      invalidStoredPart(`query.${index}`, "must be a one- or two-member query tuple");
    }
    const name = validateStoredQueryComponent(candidate[0], `query.${index}.0`, policy, true);
    if (candidate.length === 1) return [name];
    return [name, validateStoredQueryComponent(candidate[1], `query.${index}.1`, policy, false)];
  });
  for (let index = 1; index < query.length; index += 1) {
    if (compareQueryPairs(query[index - 1] as QueryPair, query[index] as QueryPair) > 0) {
      invalidStoredPart(`query.${index}`, "query pairs must be sorted by name and then value");
    }
  }
  return query;
}

function validateStoredHeaders(
  value: unknown,
  policy: RequestKeyPolicy,
): Record<string, string[]> {
  if (!isPlainRecord(value)) invalidStoredPart("headers", "must be a header record");
  const declared = new Set(policy.headerSubset);
  for (const name of Object.keys(value)) {
    if (!declared.has(name)) {
      invalidStoredPart(`headers.${name}`, "must be a lowercase header declared by the policy");
    }
  }

  const headers: Record<string, string[]> = {};
  for (const name of policy.headerSubset) {
    if (!Object.hasOwn(value, name)) continue;
    const candidate = value[name];
    if (!Array.isArray(candidate) || candidate.length === 0) {
      invalidStoredPart(`headers.${name}`, "must be a non-empty array of values");
    }
    const values = candidate.map((member, index) => {
      const path = `headers.${name}.${index}`;
      const headerValue = storedString(member, path);
      if (!isValidHeaderValue(headerValue)) {
        invalidStoredPart(path, "contains a forbidden control character");
      }
      if (trimOws(headerValue) !== headerValue) {
        invalidStoredPart(path, "must already be trimmed of HTTP optional whitespace");
      }
      return headerValue;
    });
    for (let index = 1; index < values.length; index += 1) {
      if (compareCodeUnitStrings(values[index - 1] as string, values[index] as string) > 0) {
        invalidStoredPart(`headers.${name}.${index}`, "header values must be sorted by code unit");
      }
    }
    headers[name] = values;
  }
  return headers;
}

function validateCanonicalRequestParts(
  value: unknown,
  policy: RequestKeyPolicy,
): CanonicalRequestParts {
  if (!isRecord(value)) invalidStoredPart("", "canonical request parts must be an object");
  const keys = Object.keys(value).sort(compareCodeUnitStrings);
  if (keys.length !== CANONICAL_PART_KEYS.length
    || keys.some((key, index) => key !== CANONICAL_PART_KEYS[index])) {
    invalidStoredPart("", "canonical request parts must contain exactly method, origin, path, query, headers, and body");
  }

  const method = storedString(value.method, "method");
  let canonicalMethodValue: string;
  try {
    canonicalMethodValue = canonicalMethod(method);
  } catch (error) {
    if (error instanceof InvalidRequestError) invalidStoredPart("method", error.message);
    throw error;
  }
  if (canonicalMethodValue !== method) {
    invalidStoredPart("method", "must already be ASCII-uppercased");
  }

  const origin = validateStoredOrigin(value.origin, policy);
  const path = validateStoredPath(value.path, origin, policy);
  const query = validateStoredQuery(value.query, policy);
  const headers = validateStoredHeaders(value.headers, policy);
  if (value.body !== null) {
    const body = storedString(value.body, "body");
    if (!SHA256_DIGEST.test(body)) {
      invalidStoredPart("body", "must be null or a sha256:-prefixed lowercase-hex digest");
    }
  }

  return {
    method,
    origin,
    path,
    query,
    headers,
    body: value.body as string | null,
  };
}

/** Reduce a live request to the exact canonical parts stored by a corpus entry. */
export function canonicalRequestParts(
  request: CanonicalizableRequest,
  policy: RequestKeyPolicy,
): CanonicalRequestParts {
  assertRequestKeyPolicy(policy);
  if (!isRecord(request)) throw new InvalidRequestError("request must be an object");
  assertRequestString(request.method, "method");
  if (request.body !== undefined && request.body !== null && !(request.body instanceof Uint8Array)) {
    throw new InvalidRequestError("body must be a Uint8Array");
  }
  const target = canonicalTarget(request.url, policy);
  return {
    method: canonicalMethod(request.method),
    origin: target.origin,
    path: target.path,
    query: canonicalQuery(target.rawQuery, policy),
    headers: canonicalHeaders(request.headers, policy),
    body: canonicalBody(request.body, policy),
  };
}

/** Validate stored parts in full, then derive their request key. */
export function canonicalRequestKeyFromParts(
  parts: CanonicalRequestParts,
  policy: RequestKeyPolicy,
): string {
  assertRequestKeyPolicy(policy);
  const canonical = validateCanonicalRequestParts(parts, policy);
  const material: JsonValue = {
    v: REQUEST_KEY_VERSION,
    policy: {
      headerSubset: [...policy.headerSubset],
      pathTrailingSlash: policy.pathTrailingSlash,
      plusInQuery: policy.plusInQuery,
      bodyCanonicalization: policy.bodyCanonicalization,
    },
    method: canonical.method,
    origin: canonical.origin,
    path: canonical.path,
    query: canonical.query.map((pair) => [...pair]),
    headers: Object.fromEntries(
      Object.entries(canonical.headers).map(([name, values]) => [name, [...values]]),
    ),
    body: canonical.body,
  };
  return `${REQUEST_KEY_VERSION}:${sha256Hex(serializeCanonicalJson(material))}`;
}

/** Map a canonicalizable live request to its versioned corpus key. */
export function canonicalRequestKey(
  request: CanonicalizableRequest,
  policy: RequestKeyPolicy,
): string {
  return canonicalRequestKeyFromParts(canonicalRequestParts(request, policy), policy);
}
