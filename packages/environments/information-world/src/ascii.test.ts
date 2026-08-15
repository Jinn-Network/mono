import { describe, expect, test } from "vitest";

import { asciiLowercase, asciiUppercase, isAsciiHost, isHttpToken } from "./ascii.js";

describe("ASCII case folding", () => {
  test("folds only A-Z / a-z and leaves every other code point alone", () => {
    expect(asciiLowercase("Content-Type")).toBe("content-type");
    expect(asciiUppercase("get")).toBe("GET");
    expect(asciiLowercase("Ä")).toBe("Ä");
    expect(asciiUppercase("ß")).toBe("ß");
  });

  test("is immune to the Turkish dotted-I trap that toLowerCase-with-locale would hit", () => {
    // `"I".toLocaleLowerCase("tr")` is "ı" (dotless). A header name folded that way would
    // stop matching `if-none-match` on a Turkish host, and the corpus entry would go missing.
    expect(asciiLowercase("IF-NONE-MATCH")).toBe("if-none-match");
    expect(asciiUppercase("if-none-match")).toBe("IF-NONE-MATCH");
  });

  test("round-trips through both directions without loss for ASCII tokens", () => {
    expect(asciiLowercase(asciiUppercase("x-jinn-replay"))).toBe("x-jinn-replay");
  });
});

describe("host and token predicates", () => {
  test("accepts ASCII hosts, including IPv4 literals and bracketed IPv6", () => {
    expect(isAsciiHost("api.example.test")).toBe(true);
    expect(isAsciiHost("127.0.0.1")).toBe(true);
    expect(isAsciiHost("[::1]")).toBe(true);
  });

  test("rejects a host with any non-ASCII code point", () => {
    // A non-ASCII host would send the key through the host's IDNA/ICU tables, and an ICU
    // upgrade could then change a sealed corpus's keys. Corpus origins are ASCII, so this
    // path is refused rather than normalized.
    expect(isAsciiHost("exämple.test")).toBe(false);
    expect(isAsciiHost("例え.test")).toBe(false);
  });

  test("accepts RFC 9110 field-name tokens and rejects everything else", () => {
    expect(isHttpToken("accept")).toBe(true);
    expect(isHttpToken("x-jinn-replay")).toBe(true);
    expect(isHttpToken("content-type")).toBe(true);
    expect(isHttpToken("Accept")).toBe(false);
    expect(isHttpToken("accept charset")).toBe(false);
    expect(isHttpToken("accept:")).toBe(false);
    expect(isHttpToken("")).toBe(false);
  });
});
