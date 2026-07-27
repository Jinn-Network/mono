// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

export const AUTHORITY_MARKER_TEXT =
  "JINN-AUTHORITY/secret?token=Alpha+Beta=_2026";

export const AUTHORITY_MARKER_BYTES = Uint8Array.from([
  0x00,
  0xff,
  0x7f,
  0x4a,
  0x49,
  0x4e,
  0x4e,
  0x2d,
  0x41,
  0x55,
  0x54,
  0x48,
  0x2d,
  0x42,
  0x49,
  0x4e,
]);

export type SanitizedFailureKind =
  | "access-denied"
  | "protocol-failure"
  | "unavailable";

export type SanitizedOperation =
  | "block-read"
  | "block-write"
  | "local-pin-read"
  | "readback"
  | "remote-pin-read"
  | "remote-pin-write";

export function createAuthorityBearingError(
  message = "dependency unavailable",
): Error {
  const printableForms = markerForms(
    new TextEncoder().encode(AUTHORITY_MARKER_TEXT),
  );
  const binaryForms = markerForms(AUTHORITY_MARKER_BYTES);
  const nested = Object.assign(
    new Error(`${message}: ${printableForms.base64}`),
    {
      binary: Uint8Array.from(AUTHORITY_MARKER_BYTES),
      body: binaryForms.percentEncoded,
      token: printableForms.base64url,
    },
  );
  const error = Object.assign(
    new Error(`${message}: ${AUTHORITY_MARKER_TEXT}`),
    {
      client: {
        encodedAuthority: binaryForms.base64,
        printableHex: printableForms.hex,
        urlEncodedAuthority: encodeURIComponent(AUTHORITY_MARKER_TEXT),
      },
      endpoint:
        `https://gateway.example.test/${printableForms.percentEncoded}`,
      headers: {
        authorization: `Bearer ${printableForms.base64}`,
      },
      response: {
        body: binaryForms.hex,
        headers: {
          "x-authority": printableForms.base64url,
        },
        status: 503,
      },
    },
  ) as Error & { cause?: unknown };
  error.cause = nested;
  (nested as Error & { cause?: unknown }).cause = error;
  return error;
}

export function assertSanitizedDependencyError(
  error: unknown,
  code: string,
  operation: SanitizedOperation,
  failureKind: SanitizedFailureKind,
): boolean {
  assert.ok(error instanceof Error);
  assert.equal(
    (error as Error & { code?: unknown }).code,
    code,
  );
  const cause = error.cause;
  assert.equal(typeof cause, "object");
  assert.notEqual(cause, null);
  const causeObject = cause as object;
  assert.equal(Object.getPrototypeOf(causeObject), Object.prototype);
  assert.equal(Object.isFrozen(causeObject), true);
  assert.deepEqual(Object.keys(causeObject).sort(), [
    "failureKind",
    "operation",
  ]);
  assert.deepEqual(causeObject, {
    failureKind,
    operation,
  });
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(causeObject),
  )) {
    assert.ok("value" in descriptor);
    assert.equal(descriptor.configurable, false);
    assert.equal(descriptor.writable, false);
  }
  assertNoAuthorityMarkers(error);
  return true;
}

export function assertNoAuthorityMarkers(value: unknown): void {
  const printableBytes = new TextEncoder().encode(AUTHORITY_MARKER_TEXT);
  const forbiddenStrings = [
    AUTHORITY_MARKER_TEXT,
    encodeURIComponent(AUTHORITY_MARKER_TEXT),
    new URLSearchParams({
      authority: AUTHORITY_MARKER_TEXT,
    }).toString(),
    ...Object.values(markerForms(printableBytes)),
    ...Object.values(markerForms(AUTHORITY_MARKER_BYTES)),
  ].map((item) => item.toLowerCase());
  const forbiddenBytes = [printableBytes, AUTHORITY_MARKER_BYTES];
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [
    { depth: 0, value },
  ];
  const visited = new WeakSet<object>();
  let visitedNodes = 0;

  while (pending.length > 0) {
    const item = pending.pop()!;
    assert.ok(item.depth <= 16, "public error graph exceeded scan depth");
    if (typeof item.value === "string") {
      const normalized = item.value.toLowerCase();
      for (const marker of forbiddenStrings) {
        assert.equal(
          normalized.includes(marker),
          false,
          `public error graph leaked authority marker ${marker}`,
        );
      }
      continue;
    }
    if (item.value instanceof Uint8Array) {
      for (const marker of forbiddenBytes) {
        assert.equal(
          includesBytes(item.value, marker),
          false,
          "public error graph leaked binary authority marker",
        );
      }
      continue;
    }
    if (
      (typeof item.value !== "object" || item.value === null) &&
      typeof item.value !== "function"
    ) {
      continue;
    }
    if (visited.has(item.value)) continue;
    visited.add(item.value);
    visitedNodes += 1;
    assert.ok(visitedNodes <= 256, "public error graph exceeded scan size");

    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      pending.push({ depth: item.depth + 1, value: key });
      if ("value" in descriptor) {
        pending.push({
          depth: item.depth + 1,
          value: descriptor.value,
        });
      }
    }
  }
}

function markerForms(bytes: Uint8Array): {
  readonly base64: string;
  readonly base64url: string;
  readonly hex: string;
  readonly percentEncoded: string;
} {
  const buffer = Buffer.from(bytes);
  return {
    base64: buffer.toString("base64"),
    base64url: buffer.toString("base64url"),
    hex: buffer.toString("hex"),
    percentEncoded: [...bytes]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join(""),
  };
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0) return true;
  for (
    let offset = 0;
    offset <= haystack.byteLength - needle.byteLength;
    offset += 1
  ) {
    let matches = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
