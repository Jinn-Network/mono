import { describe, expect, it } from "vitest";
import { LOCATION_PROFILE_HTTPS, LOCATION_PROFILE_IPFS } from "@jinn-network/record-discovery-protocol";

import { formatLocation, isHttpsLocator, isIpfsLocator } from "./locations.js";

describe("isHttpsLocator (§7, LOCATION_PROFILE_HTTPS)", () => {
  it("accepts an https URL", () => {
    expect(isHttpsLocator("https://example.org/records/abc")).toBe(true);
  });

  it("rejects a non-https URL", () => {
    expect(isHttpsLocator("http://example.org/records/abc")).toBe(false);
  });

  it("rejects an unparseable string", () => {
    expect(isHttpsLocator("not a url")).toBe(false);
  });
});

describe("isIpfsLocator (§7, LOCATION_PROFILE_IPFS)", () => {
  it("accepts a CIDv0", () => {
    expect(isIpfsLocator("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(true);
  });

  it("accepts a CIDv1", () => {
    expect(isIpfsLocator("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe(true);
  });

  it("rejects a non-CID string", () => {
    expect(isIpfsLocator("not-a-cid")).toBe(false);
  });
});

describe("formatLocation", () => {
  it("builds a PublishedLocation for a conforming https locator", () => {
    const location = formatLocation(LOCATION_PROFILE_HTTPS, "https://example.org/records/abc");
    expect(location).toEqual({ profile: LOCATION_PROFILE_HTTPS, locator: "https://example.org/records/abc" });
  });

  it("builds a PublishedLocation for a conforming ipfs locator", () => {
    const location = formatLocation(LOCATION_PROFILE_IPFS, "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    expect(location).toEqual({ profile: LOCATION_PROFILE_IPFS, locator: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });
  });

  it("rejects an unknown location profile", () => {
    expect(() => formatLocation("https://example.org/unknown-profile/1.0", "https://example.org/x")).toThrow();
  });

  it("rejects a locator that does not conform to its declared profile", () => {
    expect(() => formatLocation(LOCATION_PROFILE_HTTPS, "not-a-url")).toThrow();
    expect(() => formatLocation(LOCATION_PROFILE_IPFS, "https://example.org/x")).toThrow();
  });
});
