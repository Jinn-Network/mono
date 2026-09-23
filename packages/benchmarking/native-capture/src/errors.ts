// SPDX-License-Identifier: Apache-2.0

/**
 * The coordinator's error taxonomy, kept in its own module so the capture and commissioning paths
 * can both raise it without importing each other.
 */

export type NativeCaptureErrorCode =
  | "UNKNOWN_ADAPTER"
  | "INCOMPATIBLE_SOURCE"
  | "LAUNCH_UNSUPPORTED"
  | "SESSION_EXISTS"
  | "SESSION_NOT_FOUND"
  | "SESSION_PHASE_INVALID"
  | "DUPLICATE_NATIVE_UNIT"
  | "ATOM_COORDINATE_MISMATCH"
  | "ARTIFACT_DESCRIPTOR_MISMATCH"
  | "CAPTURE_NONCONFORMING";

export class NativeCaptureError extends Error {
  constructor(readonly code: NativeCaptureErrorCode, message: string) {
    super(message);
    this.name = "NativeCaptureError";
  }
}
