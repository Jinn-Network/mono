/**
 * The declarative `BackendCapabilities` record (design §15) plus the carried-amendment-1
 * `runPinning` block (profiles §5.2). Capabilities are statements, not proof — they are where
 * negotiation starts; verification and reputation of actual behavior live above the protocol.
 */

/**
 * A backend's declared enforcement posture for a supported run-pinning key (profiles §5.2):
 * `enforced` — a direct-execution binding (local) guarantees the pinned configuration runs;
 * `attested` — an open-competition binding (marketplace) conveys the pinning as a
 * claim-eligibility constraint and verifies it after the fact against the recorded Execution.
 */
export const RUN_PINNING_ENFORCEMENT_POSTURES = ["enforced", "attested"] as const;
export type RunPinningEnforcementPosture = (typeof RUN_PINNING_ENFORCEMENT_POSTURES)[number];

/**
 * One supported run-pinning key (`harness`, `model`, `loadout`, `isolationPolicy`, or a
 * namespaced profile-added key) and the backend's inventory + posture for it. A pinning key a
 * backend does not declare here is a typed `unsupported-requirement` rejection at `submit`
 * (profiles §5.2) — never a silent degradation.
 */
export interface RunPinningKeySupport {
  /** The requirements-map key this entry declares support for. */
  key: string;
  /** The backend's supported inventory for this key (harness ids, model ids, loadout kinds, isolation policy ids). */
  inventory: readonly string[];
  posture: RunPinningEnforcementPosture;
}

/** Declarative record of what a backend supports (design §15). */
export interface BackendCapabilities {
  /** Task profile URIs this backend can execute. */
  taskProfiles: string[];
  /** Consumable input media types. */
  inputMediaTypes: string[];
  /** Producible output media types. */
  outputMediaTypes: string[];
  /** Artifact size ceiling, if the backend enforces one. */
  maxArtifactBytes?: number;
  /** Optional-verb support: whether `cancel` is implemented. */
  cancel: boolean;
  /** Optional-verb support: whether `watch` is implemented. */
  watch: boolean;
  /** Optional-verb support: whether `preflight` is implemented. */
  preflight: boolean;
  /** Optional-verb support: whether `fetchArtifact` is implemented. */
  fetchArtifact: boolean;
  /** Whether the backend can resolve capability grants / opaque descriptors. */
  confidentialInputs: boolean;
  /** DSSE support for observations. */
  signedObservations: boolean;
  /** DSSE support for Deliveries. */
  signedDeliveries: boolean;
  /** `none` | `available` | `always` — whether Evidence Capture runs for this backend's Attempts. */
  evidenceCapture: "none" | "available" | "always";
  /** Whether the backend actively terminates at deadline vs merely reports expiry. */
  deadlineEnforcement: boolean;
  /** Runtime isolation classes offered. */
  isolation: string[];
  /** Supported per-Submission attempt bounds. */
  attempts: {
    maxTotal?: [number, number];
    maxConcurrent?: [number, number];
  };
  /** Carried amendment 1 (profiles §5.2): supported run-pinning keys + enforcement posture. */
  runPinning: {
    keys: RunPinningKeySupport[];
  };
}
