import { describe, expect, test } from "vitest";

import { InvalidDocumentError } from "./sealing.js";
import type { RequestKeyPolicy } from "./request-key-policy.js";
import {
  InvalidRequestError,
  canonicalRequestKey,
  canonicalRequestKeyFromParts,
  canonicalRequestParts,
  type CanonicalizableRequest,
  type CanonicalRequestParts,
} from "./request-key.js";

const policy: RequestKeyPolicy = {
  version: "irk1",
  headerSubset: ["accept", "content-type"],
  pathTrailingSlash: "preserve",
  plusInQuery: "literal",
  bodyCanonicalization: "opaque-bytes",
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("canonical request key shape", () => {
  test("is the pinned version prefix plus 64 lowercase hexadecimal digits", () => {
    expect(canonicalRequestKey({ method: "GET", url: "https://api.example.test/pools" }, policy))
      .toMatch(/^irk1:[0-9a-f]{64}$/);
  });

  test("different policy material cannot share a key", () => {
    const request = { method: "GET", url: "https://api.example.test/pools" };
    const wider: RequestKeyPolicy = {
      ...policy,
      headerSubset: ["accept", "content-type", "x-chain"],
    };
    expect(canonicalRequestKey(request, policy)).not.toBe(canonicalRequestKey(request, wider));
  });

  test("the live-request and stored-parts entry points agree", () => {
    const request = { method: "get", url: "https://api.example.test/pools?b=2&a=1" };
    const parts = canonicalRequestParts(request, policy);
    expect(canonicalRequestKeyFromParts(parts, policy)).toBe(canonicalRequestKey(request, policy));
  });
});

describe("method, origin, and path canonicalization", () => {
  test("ASCII-uppercases the method", () => {
    expect(canonicalRequestParts({ method: "get", url: "https://a.test/x" }, policy).method)
      .toBe("GET");
  });

  test("folds scheme and host case and elides a default port", () => {
    const one = canonicalRequestParts({
      method: "GET",
      url: "https://API.Example.Test:443/pools",
    }, policy);
    expect(one.origin).toBe("https://api.example.test");
    expect(canonicalRequestKey(
      { method: "GET", url: "HTTPS://API.Example.Test:443/pools" },
      policy,
    )).toBe(canonicalRequestKey(
      { method: "GET", url: "https://api.example.test/pools" },
      policy,
    ));
  });

  test("keeps a non-default port in the origin and key", () => {
    const withPort = canonicalRequestParts(
      { method: "GET", url: "https://a.test:8443/x" },
      policy,
    );
    expect(withPort.origin).toBe("https://a.test:8443");
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test:8443/x" }, policy))
      .not.toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x" }, policy));
  });

  test("uppercases percent triplets and decodes only unreserved ASCII bytes", () => {
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/a%7eb%2fc" }, policy).path)
      .toBe("/a~b%2Fc");
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/a%7Eb" }, policy))
      .toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/a~b" }, policy));
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/a%2Fb" }, policy))
      .not.toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/a/b" }, policy));
  });

  test("applies the trailing-slash policy without stripping the root", () => {
    const strip: RequestKeyPolicy = { ...policy, pathTrailingSlash: "strip" };
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/pools/" }, policy))
      .not.toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/pools" }, policy));
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/pools/" }, strip))
      .toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/pools" }, strip));
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/" }, strip).path)
      .toBe("/");
  });

  test("omits fragments because they are not sent in an HTTP request", () => {
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/x#fragment" }, policy))
      .toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x" }, policy));
  });

  test("accepts an explicit ASCII IDNA label and percent-encodes Unicode path data", () => {
    expect(canonicalRequestParts(
      { method: "GET", url: "https://xn--exmple-cua.test/café" },
      policy,
    )).toMatchObject({
      origin: "https://xn--exmple-cua.test",
      path: "/caf%C3%A9",
    });
  });

  test("rejects raw non-ASCII authority text before WHATWG URL IDNA conversion", () => {
    for (const url of ["https://exämple.test/x", "https://例え.test/x"]) {
      expect(() => canonicalRequestKey({ method: "GET", url }, policy), url)
        .toThrow(InvalidRequestError);
    }
  });

  test("refuses unsupported or ambiguous request targets and invalid methods", () => {
    for (const url of ["/pools", "ftp://a.test/x", "https://user:pass@a.test/x"]) {
      expect(() => canonicalRequestKey({ method: "GET", url }, policy), url)
        .toThrow(InvalidRequestError);
    }
    expect(() => canonicalRequestParts({ method: "GET", url: "https://a.test/a%zz" }, policy))
      .toThrow(InvalidRequestError);
    expect(() => canonicalRequestKey({ method: "GET POST", url: "https://a.test/x" }, policy))
      .toThrow(InvalidRequestError);
  });
});

describe("policy validation", () => {
  test("refuses a hand-built uncanonical policy on every key computation", () => {
    expect(() => canonicalRequestKey(
      { method: "GET", url: "https://a.test/x" },
      { ...policy, headerSubset: ["content-type", "accept"] },
    )).toThrow(InvalidDocumentError);
  });
});

describe("query canonicalization", () => {
  test("sorts pairs by name and then by value", () => {
    expect(canonicalRequestParts(
      { method: "GET", url: "https://a.test/x?b=2&a=9&a=1" },
      policy,
    ).query).toEqual([["a", "1"], ["a", "9"], ["b", "2"]]);
  });

  test("keeps a valueless key distinct from an empty-valued key", () => {
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/x?a" }, policy).query)
      .toEqual([["a"]]);
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/x?a=" }, policy).query)
      .toEqual([["a", ""]]);
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/x?a" }, policy))
      .not.toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x?a=" }, policy));
  });

  test("treats plus literally under the literal policy", () => {
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/x?q=a+b" }, policy).query)
      .toEqual([["q", "a+b"]]);
  });

  test("canonicalizes literal plus and percent-encoded space identically under the space policy", () => {
    const space: RequestKeyPolicy = { ...policy, plusInQuery: "space" };
    const literalPlus = canonicalRequestParts(
      { method: "GET", url: "https://a.test/x?q=a+b" },
      space,
    );
    const encodedSpace = canonicalRequestParts(
      { method: "GET", url: "https://a.test/x?q=a%20b" },
      space,
    );
    expect(literalPlus.query).toEqual([["q", "a b"]]);
    expect(encodedSpace.query).toEqual([["q", "a b"]]);
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/x?q=a+b" }, space))
      .toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x?q=a%20b" }, space));
  });

  test("makes an empty query equivalent to an absent query and keeps real value changes", () => {
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/x?" }, policy))
      .toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x" }, policy));
    expect(canonicalRequestKey({ method: "GET", url: "https://a.test/x?chain=base" }, policy))
      .not.toBe(canonicalRequestKey({ method: "GET", url: "https://a.test/x?chain=eth" }, policy));
  });
});

describe("header canonicalization", () => {
  test("projects away every undeclared header", () => {
    const bare = canonicalRequestKey({ method: "GET", url: "https://a.test/x" }, policy);
    const noisy = canonicalRequestKey({
      method: "GET",
      url: "https://a.test/x",
      headers: {
        "accept-encoding": "gzip, br",
        authorization: "Bearer secret",
        traceparent: "00-abc-def-01",
        "user-agent": "solver/1.2.3",
      },
    }, policy);
    expect(noisy).toBe(bare);
  });

  test("matches declared names case-insensitively and trims only HTTP optional whitespace", () => {
    const one = canonicalRequestParts({
      method: "GET",
      url: "https://a.test/x",
      headers: { Accept: "application/json" },
    }, policy);
    const two = canonicalRequestParts({
      method: "GET",
      url: "https://a.test/x",
      headers: [["ACCEPT", " \tapplication/json\t "]],
    }, policy);
    expect(one.headers).toEqual({ accept: ["application/json"] });
    expect(two.headers).toEqual(one.headers);
  });

  test("keeps absent and empty declared values distinct", () => {
    expect(canonicalRequestParts({ method: "GET", url: "https://a.test/x" }, policy).headers)
      .toEqual({});
    expect(canonicalRequestParts({
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: "" },
    }, policy).headers).toEqual({ accept: [""] });
  });

  test("sorts repeated values and accepts both tuple and record-array input", () => {
    const tuples = canonicalRequestParts({
      method: "GET",
      url: "https://a.test/x",
      headers: [["accept", "text/html"], ["accept", "application/json"]],
    }, policy).headers;
    const record = canonicalRequestParts({
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: ["application/json", "text/html"] },
    }, policy).headers;
    expect(tuples).toEqual({ accept: ["application/json", "text/html"] });
    expect(record).toEqual(tuples);
  });

  test("changes the key when a declared value changes", () => {
    expect(canonicalRequestKey({
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: "application/json" },
    }, policy)).not.toBe(canonicalRequestKey({
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: "text/html" },
    }, policy));
  });
});

describe("body canonicalization", () => {
  test("maps an absent or empty body to null", () => {
    expect(canonicalRequestParts({ method: "POST", url: "https://a.test/x" }, policy).body)
      .toBeNull();
    expect(canonicalRequestParts({
      method: "POST",
      url: "https://a.test/x",
      body: new Uint8Array(),
    }, policy).body).toBeNull();
  });

  test("opaque-bytes keys the exact bytes", () => {
    expect(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{"a":1, "b":2}'),
    }, policy)).not.toBe(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{"a":1,"b":2}'),
    }, policy));
  });

  test("json-jcs removes member order and insignificant whitespace", () => {
    const jcs: RequestKeyPolicy = { ...policy, bodyCanonicalization: "json-jcs" };
    expect(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{ "b": 2,\n  "a": 1 }'),
    }, jcs)).toBe(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{"a":1,"b":2}'),
    }, jcs));
  });

  test("json-jcs still distinguishes different JSON values", () => {
    const jcs: RequestKeyPolicy = { ...policy, bodyCanonicalization: "json-jcs" };
    expect(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{"a":1}'),
    }, jcs)).not.toBe(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8('{"a":2}'),
    }, jcs));
  });

  test("json-jcs refuses non-JSON input", () => {
    const jcs: RequestKeyPolicy = { ...policy, bodyCanonicalization: "json-jcs" };
    expect(() => canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8("not json"),
    }, jcs)).toThrow(InvalidRequestError);
  });

  test("utf8-trim removes surrounding whitespace only", () => {
    const trim: RequestKeyPolicy = { ...policy, bodyCanonicalization: "utf8-trim" };
    expect(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8("  hello  "),
    }, trim)).toBe(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8("hello"),
    }, trim));
    expect(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8("he llo"),
    }, trim)).not.toBe(canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: utf8("hello"),
    }, trim));
  });

  test("text policies refuse invalid UTF-8", () => {
    const trim: RequestKeyPolicy = { ...policy, bodyCanonicalization: "utf8-trim" };
    expect(() => canonicalRequestKey({
      method: "POST",
      url: "https://a.test/x",
      body: new Uint8Array([0xff, 0xfe]),
    }, trim)).toThrow(InvalidRequestError);
  });
});

describe("uncanonicalizable live requests", () => {
  test("refuses percent-encoded authority bytes that WHATWG would feed into IDNA", () => {
    expect(() => canonicalRequestKey(
      { method: "GET", url: "https://ex%C3%A4mple.test/x" },
      policy,
    )).toThrow(InvalidRequestError);
  });

  test("refuses unpaired Unicode surrogates before URL parsing can replace them", () => {
    const unpaired = String.fromCharCode(0xd800);
    for (const url of [`https://a.test/${unpaired}`, `https://a.test/x?q=${unpaired}`]) {
      expect(() => canonicalRequestKey({ method: "GET", url }, policy), url)
        .toThrow(InvalidRequestError);
    }
  });

  test.each<readonly [string, unknown]>([
    ["a non-string method", { method: 7, url: "https://a.test/x" }],
    ["a non-string URL", { method: "GET", url: new URL("https://a.test/x") }],
    ["a body that is not bytes", { method: "POST", url: "https://a.test/x", body: [1, 2] }],
    ["a malformed header tuple", {
      method: "GET",
      url: "https://a.test/x",
      headers: [["accept"]],
    }],
    ["a non-string header value", {
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: 5 },
    }],
    ["a non-record header container", {
      method: "GET",
      url: "https://a.test/x",
      headers: new Map([["accept", "application/json"]]),
    }],
    ["an invalid header name", {
      method: "GET",
      url: "https://a.test/x",
      headers: { "bad name": "ignored only if it were a valid field" },
    }],
    ["a header value containing a line break", {
      method: "GET",
      url: "https://a.test/x",
      headers: { accept: "application/json\r\nx-injected: yes" },
    }],
  ])("refuses %s with InvalidRequestError", (_label, malformed) => {
    expect(() => canonicalRequestKey(
      malformed as CanonicalizableRequest,
      policy,
    )).toThrow(InvalidRequestError);
  });

  test("refuses malformed percent-encoding in query components", () => {
    expect(() => canonicalRequestKey(
      { method: "GET", url: "https://a.test/x?q=%zz" },
      policy,
    )).toThrow(InvalidRequestError);
  });
});

describe("stored canonical request parts", () => {
  const stored: CanonicalRequestParts = {
    method: "GET",
    origin: "https://api.example.test",
    path: "/pools",
    query: [["chain", "base"], ["limit", "50"]],
    headers: {
      accept: ["application/json"],
      "content-type": ["application/json"],
    },
    body: null,
  };

  test("accepts an independently written canonical parts document", () => {
    expect(canonicalRequestKeyFromParts(stored, policy)).toMatch(/^irk1:[0-9a-f]{64}$/);
    expect(canonicalRequestKeyFromParts({
      ...stored,
      body: `sha256:${"0".repeat(64)}`,
    }, policy)).not.toBe(canonicalRequestKeyFromParts(stored, policy));
  });

  test.each<readonly [string, unknown]>([
    ["a non-object", null],
    ["a missing member", {
      method: "GET",
      origin: "https://api.example.test",
      path: "/pools",
      query: [],
      headers: {},
    }],
    ["an extra member", { ...stored, extension: true }],
    ["a lowercase method", { ...stored, method: "get" }],
    ["a method that is not an HTTP token", { ...stored, method: "GET POST" }],
    ["an uppercase origin", { ...stored, origin: "HTTPS://API.EXAMPLE.TEST" }],
    ["an origin with a default port", { ...stored, origin: "https://api.example.test:443" }],
    ["an origin with raw IDNA input", { ...stored, origin: "https://exämple.test" }],
    ["an origin with encoded IDNA input", { ...stored, origin: "https://ex%C3%A4mple.test" }],
    ["an origin with userinfo", { ...stored, origin: "https://user@api.example.test" }],
    ["an origin with a path", { ...stored, origin: "https://api.example.test/x" }],
    ["a relative path", { ...stored, path: "pools" }],
    ["a path with raw Unicode", { ...stored, path: "/café" }],
    ["a path with lowercase percent hex", { ...stored, path: "/a%2fb" }],
    ["a path with an encoded unreserved byte", { ...stored, path: "/a%7Eb" }],
    ["a path with a dot segment", { ...stored, path: "/a/../pools" }],
    ["query pairs in descending order", {
      ...stored,
      query: [["limit", "50"], ["chain", "base"]],
    }],
    ["an empty query tuple", { ...stored, query: [[]] }],
    ["a three-member query tuple", { ...stored, query: [["a", "b", "c"]] }],
    ["a non-string query member", { ...stored, query: [["limit", 50]] }],
    ["an unnormalized query percent triplet", { ...stored, query: [["q", "%7e"]] }],
    ["a raw space under the literal-plus policy", { ...stored, query: [["q", "a b"]] }],
    ["a raw query separator", { ...stored, query: [["q", "a&b"]] }],
    ["a raw equals sign in a query name", { ...stored, query: [["a=b", "value"]] }],
    ["a URL-escaped query character left raw", { ...stored, query: [["q", "a\"b"]] }],
    ["an undeclared header", { ...stored, headers: { "x-chain": ["base"] } }],
    ["a non-record header container", {
      ...stored,
      headers: new Map([["accept", ["application/json"]]]),
    }],
    ["an uppercase header name", { ...stored, headers: { Accept: ["application/json"] } }],
    ["a header with no values", { ...stored, headers: { accept: [] } }],
    ["header values in descending order", {
      ...stored,
      headers: { accept: ["text/html", "application/json"] },
    }],
    ["a header value with outer optional whitespace", {
      ...stored,
      headers: { accept: [" application/json"] },
    }],
    ["a header value with a control character", {
      ...stored,
      headers: { accept: ["application/json\n"] },
    }],
    ["an unprefixed body digest", { ...stored, body: "0".repeat(64) }],
    ["an uppercase body digest", { ...stored, body: `sha256:${"A".repeat(64)}` }],
    ["a non-string body digest", { ...stored, body: 7 }],
  ])("refuses %s before deriving a key", (_label, malformed) => {
    expect(() => canonicalRequestKeyFromParts(
      malformed as CanonicalRequestParts,
      policy,
    )).toThrow(InvalidDocumentError);
  });

  test("refuses a trailing slash stored under the strip policy", () => {
    const strip: RequestKeyPolicy = { ...policy, pathTrailingSlash: "strip" };
    expect(() => canonicalRequestKeyFromParts(
      { ...stored, path: "/pools/" },
      strip,
    )).toThrow(InvalidDocumentError);
  });

  test("refuses plus and encoded-space spellings stored under the space policy", () => {
    const space: RequestKeyPolicy = { ...policy, plusInQuery: "space" };
    for (const value of ["a+b", "a%20b"]) {
      expect(() => canonicalRequestKeyFromParts(
        { ...stored, query: [["q", value]] },
        space,
      ), value).toThrow(InvalidDocumentError);
    }
    expect(() => canonicalRequestKeyFromParts(
      { ...stored, query: [["q", "a b"]] },
      space,
    )).not.toThrow();
  });
});
