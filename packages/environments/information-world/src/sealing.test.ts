import { describe, expect, test } from "vitest";
import { z } from "zod";

import { bareHexDigest, informationWorldRecordDigest, sha256Hex } from "./hashing.js";
import { InvalidDocumentError, parseExactWithSchema, sealWithSchema } from "./sealing.js";

const Example = z.strictObject({ alpha: z.number(), beta: z.string() });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("digest primitives", () => {
  test("sha256Hex is lowercase hex of the digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("informationWorldRecordDigest carries the sha256: prefix the record body uses", () => {
    expect(informationWorldRecordDigest(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("bareHexDigest strips the prefix for in-toto DigestSet subject values", () => {
    const digest = informationWorldRecordDigest(new Uint8Array());
    expect(bareHexDigest(digest)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(bareHexDigest(digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(bareHexDigest(digest).startsWith("sha256:")).toBe(false);
  });

  test("bareHexDigest rejects a value that is not a prefixed sha256 digest", () => {
    expect(() => bareHexDigest("a".repeat(64) as never)).toThrow(InvalidDocumentError);
    expect(() => bareHexDigest("sha256:NOTHEX" as never)).toThrow(InvalidDocumentError);
  });
});

describe("sealing", () => {
  test("key-permuted documents seal to identical bytes and one digest", () => {
    const a = sealWithSchema(Example, { alpha: 1, beta: "two" });
    const b = sealWithSchema(Example, { beta: "two", alpha: 1 });
    expect(decode(a)).toBe(decode(b));
    expect(informationWorldRecordDigest(a)).toBe(informationWorldRecordDigest(b));
  });

  test("sealWithSchema rejects an invalid document with issue paths", () => {
    try {
      sealWithSchema(Example, { alpha: "not a number", beta: "two" });
      throw new Error("expected InvalidDocumentError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidDocumentError);
      expect((error as InvalidDocumentError).errors[0]?.path).toBe("alpha");
    }
  });

  // zod's object copy does not carry a `__proto__` member across, so a document holding one
  // would seal to bytes that quietly lack it. At a boundary whose whole job is "these bytes
  // are the record forever", dropping content is worse than refusing it.
  test("sealWithSchema refuses a __proto__ member rather than silently dropping it", () => {
    const document = JSON.parse('{"alpha":1,"beta":"two","__proto__":{"polluted":true}}') as unknown;
    expect(() => sealWithSchema(Example, document)).toThrow(InvalidDocumentError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("sealWithSchema refuses a nested __proto__ member too", () => {
    const Nested = z.strictObject({ inner: z.looseObject({ mechanism: z.string() }) });
    const document = JSON.parse('{"inner":{"mechanism":"m","__proto__":{"x":1}}}') as unknown;
    expect(() => sealWithSchema(Nested, document)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema round-trips sealed bytes", () => {
    const bytes = sealWithSchema(Example, { alpha: 1, beta: "two" });
    expect(parseExactWithSchema(Example, bytes)).toEqual({ alpha: 1, beta: "two" });
  });

  test("parseExactWithSchema rejects re-canonicalized (pretty-printed) bytes", () => {
    const pretty = new TextEncoder().encode(JSON.stringify({ alpha: 1, beta: "two" }, null, 2));
    expect(() => parseExactWithSchema(Example, pretty)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects key-reordered bytes", () => {
    const reordered = new TextEncoder().encode('{"beta":"two","alpha":1}');
    expect(() => parseExactWithSchema(Example, reordered)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects invalid UTF-8", () => {
    expect(() => parseExactWithSchema(Example, new Uint8Array([0xff, 0xfe]))).toThrow(
      InvalidDocumentError,
    );
  });
});
