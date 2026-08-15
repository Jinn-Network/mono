import { describe, expect, it } from "vitest";
import { WELL_KNOWN_PATH } from "@jinn-network/record-discovery-protocol";

import { archiveTailPath, parseArchivePath, stripBasePath } from "./paths.js";

const HEX64 = "a".repeat(64);

describe("parseArchivePath", () => {
  it("admits the well-known discovery document", () => {
    expect(parseArchivePath(WELL_KNOWN_PATH)).toEqual({ kind: "well-known", path: WELL_KNOWN_PATH });
  });

  it("admits a digest path with a 64-hex name", () => {
    expect(parseArchivePath(`/records/${HEX64}`)).toEqual({ kind: "record", path: `/records/${HEX64}` });
  });

  it("admits a source head and an archive page", () => {
    expect(parseArchivePath("/sources/feed/head")).toEqual({
      kind: "head", sourceName: "feed", path: "/sources/feed/head",
    });
    expect(parseArchivePath("/sources/feed/entries/0000000000000042")).toEqual({
      kind: "page", sourceName: "feed", page: "0000000000000042", path: "/sources/feed/entries/0000000000000042",
    });
  });

  it("admits the tail endpoint", () => {
    expect(archiveTailPath("feed")).toBe("/sources/feed/tail");
    expect(parseArchivePath("/sources/feed/tail")).toEqual({ kind: "tail", sourceName: "feed" });
  });

  it("refuses everything outside the five shapes", () => {
    for (const pathname of [
      "/",
      "/v1/status",
      "/artifacts/search",
      "/records",
      `/records/${HEX64}/extra`,
      `/records/${"z".repeat(64)}`,
      `/records/${HEX64}.content-type`,
      "/sources/feed",
      "/sources/feed/head.content-type",
      "/sources/FEED/head",
      "/sources/-bad-/head",
      "/sources/feed/entries/42",
      "/sources/feed/entries/00000000000000042",
      "/sources/feed/entries/000000000000004a",
      "/sources/../../etc/passwd",
      "/sources/feed/../../v1/status",
      "//sources/feed/head",
    ]) {
      expect(parseArchivePath(pathname), pathname).toBeUndefined();
    }
  });
});

describe("stripBasePath", () => {
  it("returns the remainder for a path under the mount", () => {
    expect(stripBasePath("/archive/sources/feed/head", "/archive")).toBe("/sources/feed/head");
    expect(stripBasePath("/archive", "/archive")).toBe("/");
  });

  it("returns the path unchanged when the mount is the origin root", () => {
    expect(stripBasePath("/sources/feed/head", "")).toBe("/sources/feed/head");
  });

  it("returns undefined for a path outside the mount", () => {
    expect(stripBasePath("/v1/status", "/archive")).toBeUndefined();
    expect(stripBasePath("/archiver/sources/feed/head", "/archive")).toBeUndefined();
  });
});
