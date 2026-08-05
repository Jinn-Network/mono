import { describe, expect, test } from "vitest";
import { z } from "zod";

import { documentDigest, sha256Hex } from "./hashing.js";
import {
  InvalidDocumentError,
  parseExactWithSchema,
  sealRecord,
  sealWithSchema,
} from "./sealing.js";

const Example = z.strictObject({ alpha: z.number(), beta: z.string() });

describe("sealing", () => {
  test("sha256Hex is lowercase hex of the digest", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("documentDigest prefixes the algorithm", () => {
    expect(documentDigest(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("key-permuted documents seal to one digest", () => {
    const a = sealRecord({ alpha: 1, beta: "two" });
    const b = sealRecord({ beta: "two", alpha: 1 });
    expect(a.digest).toBe(b.digest);
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
    const sealed = sealWithSchema(Example, { alpha: 1, beta: "two" });
    expect(parseExactWithSchema(Example, sealed.bytes)).toEqual({ alpha: 1, beta: "two" });
  });

  test("parseExactWithSchema rejects non-canonical bytes", () => {
    const nonCanonical = new TextEncoder().encode('{"beta":"two","alpha":1}');
    expect(() => parseExactWithSchema(Example, nonCanonical)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects invalid UTF-8", () => {
    expect(() => parseExactWithSchema(Example, new Uint8Array([0xff, 0xfe]))).toThrow(
      InvalidDocumentError,
    );
  });

  test("parseExactWithSchema rejects UTF-8 BOM prefix", () => {
    const sealed = sealWithSchema(Example, { alpha: 1, beta: "two" });
    const bomPrefixed = new Uint8Array(sealed.bytes.length + 3);
    bomPrefixed.set([0xef, 0xbb, 0xbf], 0);
    bomPrefixed.set(sealed.bytes, 3);
    expect(() => parseExactWithSchema(Example, bomPrefixed)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects alternate unicode escape encoding", () => {
    const alternate = new TextEncoder().encode('{"alpha":1,"beta":"\\u0074wo"}');
    expect(() => parseExactWithSchema(Example, alternate)).toThrow(InvalidDocumentError);
  });

  test("parseExactWithSchema rejects pretty-printed whitespace", () => {
    const pretty = new TextEncoder().encode('{\n  "alpha": 1,\n  "beta": "two"\n}');
    expect(() => parseExactWithSchema(Example, pretty)).toThrow(InvalidDocumentError);
  });
});
