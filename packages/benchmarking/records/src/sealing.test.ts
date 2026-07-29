import { describe, expect, test } from "vitest";
import { z } from "zod";
import { IJsonNumberError } from "./json.js";
import { InvalidDocumentError, sealRecord, sealWithSchema } from "./sealing.js";

describe("sealRecord", () => {
  test("sealing an object with two source key orderings yields identical digest", () => {
    const a = sealRecord({ b: 1, a: 2 } as never);
    const b = sealRecord({ a: 2, b: 1 } as never);
    expect(a.digest).toBe(b.digest);
    expect(a.bytes).toEqual(b.bytes);
  });

  test("sealing an object with a fractional number throws IJsonNumberError", () => {
    expect(() => sealRecord({ q: 1.5 } as never)).toThrow(IJsonNumberError);
  });

  test("digest is a lowercase sha256: prefixed hex string", () => {
    const { digest } = sealRecord({ a: 1 } as never);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("sealWithSchema", () => {
  const schema = z.object({ name: z.string() });

  test("seals a valid document", () => {
    const { digest } = sealWithSchema(schema, { name: "ok" });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("throws InvalidDocumentError with a category on schema failure", () => {
    expect(() => sealWithSchema(schema, { name: 1 })).toThrow(InvalidDocumentError);
    try {
      sealWithSchema(schema, {});
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidDocumentError).category).toBe("invalid-document");
      expect((error as InvalidDocumentError).errors.length).toBeGreaterThan(0);
    }
  });
});
