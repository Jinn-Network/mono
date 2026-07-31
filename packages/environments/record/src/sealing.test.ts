import { describe, expect, test } from "vitest";
import { z } from "zod";

import { bareHexDigest, environmentRecordDigest, sha256Hex } from "./hashing.js";
import { InvalidDocumentError, parseExactWithSchema, sealWithSchema } from "./sealing.js";

const Example = z.strictObject({ alpha: z.number(), beta: z.string() });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("digest primitives", () => {
  test("sha256Hex is lowercase hex of the digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("environmentRecordDigest carries the sha256: prefix the record body uses", () => {
    expect(environmentRecordDigest(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("bareHexDigest strips the prefix for in-toto DigestSet subject values", () => {
    const digest = environmentRecordDigest(new Uint8Array());
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
    expect(environmentRecordDigest(a)).toBe(environmentRecordDigest(b));
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
