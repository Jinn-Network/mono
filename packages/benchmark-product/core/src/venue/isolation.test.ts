import { describe, expect, test } from "vitest";
import {
  deriveVenueIsolationPosture,
  venueIsolationPostureForPolicy,
} from "./isolation.js";
import { LOCAL_VENUE_LIMITS, localVenueLimitsForRun } from "../operations/run-results.js";

describe("venue isolation posture", () => {
  test("native and local-Python execution expose only the unrestricted policy", () => {
    expect(venueIsolationPostureForPolicy(undefined)).toEqual({
      inventory: ["unrestricted"],
      provisionerCapabilities: ["process"],
    });
    expect(venueIsolationPostureForPolicy("unrestricted")).toEqual({
      inventory: ["unrestricted"],
      provisionerCapabilities: ["process"],
    });
  });

  test("OCI execution exposes both policies because the configured venue still owns native launchers", () => {
    expect(venueIsolationPostureForPolicy("oci-container")).toEqual({
      inventory: ["unrestricted", "oci-container"],
      provisionerCapabilities: ["process", "oci-container"],
    });
  });

  test("deduplicates and orders inventories deterministically", () => {
    expect(deriveVenueIsolationPosture([
      "oci-container",
      "unrestricted",
      "oci-container",
      "unrestricted",
    ])).toEqual({
      inventory: ["unrestricted", "oci-container"],
      provisionerCapabilities: ["process", "oci-container"],
    });
  });

  test("preserves native disclosures and replaces only the OCI isolation statement", () => {
    const native = localVenueLimitsForRun({
      policy: { submissionBaseline: { isolationPolicy: "unrestricted" } },
    } as never);
    expect(native).toBe(LOCAL_VENUE_LIMITS);

    const oci = localVenueLimitsForRun({
      policy: { submissionBaseline: { isolationPolicy: "oci-container" } },
    } as never);
    expect(oci).toHaveLength(LOCAL_VENUE_LIMITS.length);
    expect(oci).toContainEqual(expect.stringContaining(
      "admits both unrestricted and OCI-container execution",
    ));
    expect(oci).not.toContain(LOCAL_VENUE_LIMITS[2]);
  });
});
