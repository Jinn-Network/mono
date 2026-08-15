// SPDX-License-Identifier: MIT

import type {
  AdmissionEvidencePort,
  PinningObservationPort,
} from "@jinn-network/benchmarking-run";

/** Honest attested pinning posture until #2040/#2041 (design §18.3 / program §7.141). */
export function attestedPinningObservation(): PinningObservationPort {
  return {
    async observe() {
      return {
        harness: "unverifiable",
        model: "unverifiable",
        loadout: "unverifiable",
        isolation: "unverifiable",
      };
    },
  };
}

/** Absent admission receipt defaults to attested-only (design §8.4). */
export function marketplaceAdmissionEvidence(
  ports?: AdmissionEvidencePort,
): AdmissionEvidencePort {
  if (ports !== undefined) return ports;
  return {
    async tierFor() {
      return "attested-only";
    },
  };
}
