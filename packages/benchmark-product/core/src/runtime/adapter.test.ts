import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import {
  NATIVE_RUNTIME_ADAPTER_ID,
  listRuntimeAdapters,
  runtimeNativeArtifactPublicationPolicy,
  runtimeSubmissionBaseline,
} from "./adapter.js";

describe("runtime adapter registry", () => {
  test("the absent binding preserves the existing native submission baseline", () => {
    expect(runtimeSubmissionBaseline()).toEqual({ isolationPolicy: "unrestricted" });
  });

  test("lists the native adapter as the compatibility runtime", () => {
    expect(listRuntimeAdapters()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: NATIVE_RUNTIME_ADAPTER_ID, available: true }),
      expect.objectContaining({ id: "inspect", available: true, selectionRequired: true }),
    ]));
  });

  test("keeps runtime-native publication consent behind the adapter boundary", () => {
    expect(runtimeNativeArtifactPublicationPolicy()).toBe("not-applicable");
    expect(runtimeNativeArtifactPublicationPolicy({
      adapterId: "inspect",
      selectionManifestSha256: "a".repeat(64),
    })).toBe("explicit-consent");
  });

  test("an unregistered adapter refuses explicitly rather than falling back to native", () => {
    expect(() => runtimeSubmissionBaseline({
      adapterId: "unknown-runtime",
      selectionManifestSha256: "a".repeat(64),
    })).toThrow(BenchmarkProductError);
  });
});
