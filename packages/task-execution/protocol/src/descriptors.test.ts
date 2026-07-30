import { describe, expect, test } from "vitest";
import { resourceDescriptorHasLocator, type ResourceDescriptor } from "./descriptors.js";

describe("resourceDescriptorHasLocator", () => {
  test("accepts a descriptor with only a uri", () => {
    expect(resourceDescriptorHasLocator({ uri: "https://example.test/x" })).toBe(true);
  });
  test("accepts a descriptor with only a digest", () => {
    expect(resourceDescriptorHasLocator({ digest: { sha256: "ab".repeat(32) } })).toBe(true);
  });
  test("accepts a descriptor with only inline content", () => {
    expect(resourceDescriptorHasLocator({ content: "aGVsbG8=" })).toBe(true);
  });
  test("rejects a descriptor with none of uri/digest/content", () => {
    const bare: ResourceDescriptor = { name: "orphan" };
    expect(resourceDescriptorHasLocator(bare)).toBe(false);
  });
  test("rejects an empty digest object as a locator", () => {
    expect(resourceDescriptorHasLocator({ digest: {} })).toBe(false);
  });
});
