import { describe, expect, it } from "vitest";
import { codeOnly } from "./source-text.js";

describe("codeOnly", () => {
  it("blanks line, block, and JSDoc prose while preserving code, offsets, and newlines", () => {
    const source = [
      "/** no-op runtime in JSDoc */",
      "// randomUUID in a line comment",
      "/* ephemeral-key in a block comment */",
      "const url = 'https://example.test/path'; const runtime = createNoopRuntime();",
      "const template = `sha256:${url}`;",
      "const pattern = /https?:\\/\\//u;",
      "const marker = 'ephemeral-key';",
    ].join("\n");

    const result = codeOnly(source);

    expect(result).toHaveLength(source.length);
    expect([...result.matchAll(/\n/gu)].map(({ index }) => index))
      .toEqual([...source.matchAll(/\n/gu)].map(({ index }) => index));
    expect(result).not.toContain("no-op runtime in JSDoc");
    expect(result).not.toContain("randomUUID in a line comment");
    expect(result).not.toContain("ephemeral-key in a block comment");
    expect(result).toContain("'https://example.test/path'");
    expect(result).toContain("createNoopRuntime()");
    expect(result).toContain("`sha256:${url}`");
    expect(result).toContain("/https?:\\/\\//u");
    expect(result).toContain("'ephemeral-key'");
  });
});
