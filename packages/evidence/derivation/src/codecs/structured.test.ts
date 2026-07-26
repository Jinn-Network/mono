// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { transformJsonBytes } from "./json.js";
import { transformJsonlBytes } from "./jsonl.js";

const encoder = new TextEncoder();

function expectDeterministicTransform(
  transform: (
    bytes: Uint8Array,
    replacements: ReadonlyMap<string, string>,
  ) => Uint8Array,
  source: string,
  replacements: ReadonlyMap<string, string>,
  expected: string,
): void {
  const sourceBytes = encoder.encode(source);
  const expectedBytes = encoder.encode(expected);
  expect(transform(sourceBytes, replacements)).toEqual(expectedBytes);
  expect(transform(sourceBytes, replacements)).toEqual(expectedBytes);
}

test("replaces a top-level JSON string at the root pointer", () => {
  expectDeterministicTransform(
    transformJsonBytes,
    '"private-root"',
    new Map([["", "[REDACTED_ROOT]"]]),
    '"[REDACTED_ROOT]"',
  );
});

test("replaces an empty JSON object key at the RFC 6901 slash pointer", () => {
  expectDeterministicTransform(
    transformJsonBytes,
    '{"":"private-empty-key","keep":"same"}',
    new Map([["/", "[REDACTED_EMPTY_KEY]"]]),
    '{"":"[REDACTED_EMPTY_KEY]","keep":"same"}',
  );
});

test("replaces a top-level JSONL string at its line root pointer", () => {
  expectDeterministicTransform(
    transformJsonlBytes,
    '"private-root"\n{"keep":"same"}\n',
    new Map([["/0", "[REDACTED_ROOT]"]]),
    '"[REDACTED_ROOT]"\n{"keep":"same"}\n',
  );
});

test("replaces an empty JSONL object key at its RFC 6901 slash segment", () => {
  expectDeterministicTransform(
    transformJsonlBytes,
    '{"":"private-empty-key","keep":"same"}\n',
    new Map([["/0/", "[REDACTED_EMPTY_KEY]"]]),
    '{"":"[REDACTED_EMPTY_KEY]","keep":"same"}\n',
  );
});

test("does not reinterpret a JSONL coordinate without a line segment", () => {
  expect(() =>
    transformJsonlBytes(
      encoder.encode('"private-root"\n'),
      new Map([["/", "[REDACTED_ROOT]"]]),
    ),
  ).toThrowError(expect.objectContaining({ code: "INTERNAL_FAILURE" }));
});
