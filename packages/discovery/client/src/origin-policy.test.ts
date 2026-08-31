import { describe, expect, it } from "vitest";

import { ContainedOriginError, isPrivateOrReservedHost, resolveContainedUrl } from "./origin-policy.js";

const ROOT = "https://peer.example/archive";

describe("resolveContainedUrl (§7/§14.1: a peer-introduced path may not leave the configured serving root)", () => {
  it("resolves a relative archive path under the serving root", () => {
    expect(resolveContainedUrl(ROOT, "entries/0002.json").toString()).toBe(
      "https://peer.example/archive/entries/0002.json",
    );
  });

  it("accepts a root-anchored path that still lands inside the prefix", () => {
    expect(resolveContainedUrl(ROOT, "/archive/entries/0002.json").toString()).toBe(
      "https://peer.example/archive/entries/0002.json",
    );
  });

  it("accepts an absolute URL that is genuinely inside the serving root", () => {
    expect(resolveContainedUrl(ROOT, "https://peer.example/archive/x.json").toString()).toBe(
      "https://peer.example/archive/x.json",
    );
  });

  // The issue's exact vector: `new URL(absolute, base)` discards the base.
  it("refuses an absolute loopback URL (the reported SSRF)", () => {
    expect(() => resolveContainedUrl(ROOT, "http://127.0.0.1:8545/")).toThrow(ContainedOriginError);
  });

  it("refuses an absolute URL at another public origin", () => {
    expect(() => resolveContainedUrl(ROOT, "https://evil.example/collect")).toThrow(ContainedOriginError);
  });

  it("refuses a protocol-relative locator", () => {
    expect(() => resolveContainedUrl(ROOT, "//evil.example/collect")).toThrow(ContainedOriginError);
  });

  it("refuses a scheme change on the same host", () => {
    expect(() => resolveContainedUrl(ROOT, "http://peer.example/archive/x.json")).toThrow(ContainedOriginError);
  });

  it("refuses a port change on the same host", () => {
    expect(() => resolveContainedUrl(ROOT, "https://peer.example:8443/archive/x.json")).toThrow(ContainedOriginError);
  });

  it("refuses a traversal that escapes the serving-root prefix", () => {
    expect(() => resolveContainedUrl(ROOT, "../../etc/keys.json")).toThrow(ContainedOriginError);
  });

  it("refuses a sibling prefix that only looks contained textually", () => {
    expect(() => resolveContainedUrl(ROOT, "/archived-elsewhere/x.json")).toThrow(ContainedOriginError);
  });

  it("refuses embedded credentials", () => {
    expect(() => resolveContainedUrl(ROOT, "https://user:pass@peer.example/archive/x.json")).toThrow(
      ContainedOriginError,
    );
  });

  it("refuses a non-http(s) scheme", () => {
    expect(() => resolveContainedUrl(ROOT, "file:///etc/passwd")).toThrow(ContainedOriginError);
  });

  it("refuses an empty or whitespace-only candidate", () => {
    expect(() => resolveContainedUrl(ROOT, "")).toThrow(ContainedOriginError);
    expect(() => resolveContainedUrl(ROOT, "   ")).toThrow(ContainedOriginError);
  });

  it("refuses an unusable serving root rather than guessing one", () => {
    expect(() => resolveContainedUrl("not a url", "entries/1.json")).toThrow(ContainedOriginError);
    expect(() => resolveContainedUrl("ftp://peer.example/archive", "entries/1.json")).toThrow(ContainedOriginError);
  });

  it("treats a serving root with a trailing slash identically", () => {
    expect(resolveContainedUrl("https://peer.example/archive/", "entries/1.json").toString()).toBe(
      "https://peer.example/archive/entries/1.json",
    );
  });

  it("keeps a loopback serving root usable for local deployments", () => {
    expect(resolveContainedUrl("http://127.0.0.1:7331", "entries/1.json").toString()).toBe(
      "http://127.0.0.1:7331/entries/1.json",
    );
  });

  it("refuses a sibling when the serving root carries a query string", () => {
    // Appending "/" to the raw root would leave the base path without its trailing
    // slash, and a prefix test against `/archive` accepts `/archived-elsewhere`.
    expect(() => resolveContainedUrl("https://peer.example/archive?x=1", "/archived-elsewhere/x.json")).toThrow(
      ContainedOriginError,
    );
    expect(resolveContainedUrl("https://peer.example/archive?x=1", "entries/1.json").toString()).toBe(
      "https://peer.example/archive/entries/1.json",
    );
  });

  it("refuses a backslash-spelled protocol-relative locator", () => {
    expect(() => resolveContainedUrl(ROOT, String.raw`\\evil.example/collect`)).toThrow(ContainedOriginError);
  });

  it("resolves the root-anchored archive page shape producers actually emit", () => {
    expect(resolveContainedUrl("https://peer.example", "/sources/requester/entries/0001").toString()).toBe(
      "https://peer.example/sources/requester/entries/0001",
    );
  });

  it("names the refused candidate and the serving root in the error", () => {
    try {
      resolveContainedUrl(ROOT, "http://169.254.169.254/latest/meta-data/");
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ContainedOriginError);
      expect((error as ContainedOriginError).message).toContain("169.254.169.254");
      expect((error as ContainedOriginError).message).toContain(ROOT);
    }
  });
});

describe("isPrivateOrReservedHost (§7/§14.1 hostile-locator classifier)", () => {
  const refused = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "0.0.0.0",
    "localhost",
    "LOCALHOST",
    "100.64.0.1", // CGNAT (issue: missing today)
    "100.127.255.255",
    "255.255.255.255", // broadcast
    "224.0.0.1", // IPv4 multicast
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1", // IPv6 multicast
    "::ffff:127.0.0.1", // IPv4-mapped (issue: missing today)
    "[::ffff:127.0.0.1]",
    "::ffff:10.0.0.1",
    "64:ff9b::127.0.0.1", // NAT64 embedding
    "2002:7f00:0001::", // 6to4 embedding of 127.0.0.1
    "2130706433", // bare-integer spelling of 127.0.0.1
    "0177.0.0.1", // octal spelling of 127.0.0.1
    "0x7f000001", // hex spelling of 127.0.0.1
    "192.168.0x1", // mixed hex final label
  ];
  for (const host of refused) {
    it(`refuses ${host}`, () => {
      expect(isPrivateOrReservedHost(host)).toBe(true);
    });
  }

  const allowed = [
    "peer.example",
    "8.8.8.8",
    "172.32.0.1", // just outside 172.16.0.0/12
    "172.15.255.255",
    "100.63.255.255", // just below the CGNAT block
    "100.128.0.1", // just above it
    "1.1.1.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2002:0808:0808::", // 6to4 of a public IPv4
  ];
  for (const host of allowed) {
    it(`allows ${host}`, () => {
      expect(isPrivateOrReservedHost(host)).toBe(false);
    });
  }
});
