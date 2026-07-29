/**
 * Venue-conditional injected ports for Matrix assembly and launch (design §8.3, §13).
 * The run package never imports a concrete backend, evidence binding, or marketplace package —
 * hosts inject implementations that satisfy these contracts.
 */

import type { MatrixRecord, RunRecord } from "@jinn-network/benchmarking-records";
import type {
  EvaluationSpec,
  MeasurementMap,
  VerdictOutcome,
} from "@jinn-network/task-execution-profiles";

/** Pinning-axis observation status (design §8.1). */
export type PinningAxisStatus = "match" | "mismatch" | "unverifiable";

/** Per-cell integrity tier sourced from admission evidence (design §8.4). */
export type IntegrityTier = "re-derivable" | "attested-only";

/** Optional cost field sourcing pinned by the assembly procedure version (§8.3). */
export interface CellCost {
  value: string;
  unit: string;
  source: "reported" | "settled";
}

/**
 * One accounted cell inside the declared input scope at the close boundary (§8.3).
 * Attempt identity is carried by observation/delivery surfaces — never re-derived here
 * (program §7.22).
 */
export interface InScopeCell {
  cellKey: string;
  armId: string;
  replicate: number;
  taskDigest: string;
  /** 1-based dispatch count for this cell (replacement lineage). */
  dispatches: number;
  /** Accounted dispatch index (usually the latest successful or terminal dispatch). */
  accounted?: number;
  /** Exact sealed Submission bytes for the accounted dispatch, when present. */
  submissionBytes?: Uint8Array;
  /** Digest of the accounted sealed Submission (`sha256:<hex>`). */
  submissionDigest?: `sha256:${string}`;
  /** Backend-minted Attempt URI read from observe/delivery — never re-derived. */
  attempt?: string;
  /** Exact sealed Delivery bytes when a delivery is in scope. */
  deliveryBytes?: Uint8Array;
  deliveryDigest?: `sha256:${string}`;
  /** In-scope verdict digests (and optional sealed verdict payloads for named checks). */
  verdicts: readonly InScopeVerdict[];
  /** Opaque observation log / evidence handle for pinning + cost ports. */
  evidenceRef?: unknown;
  /** True when this cell's accounted dispatch is an exclusion-hit (§7.4). */
  exclusionHit?: boolean;
  exclusionReason?: string;
  /** Task evaluation-spec digest (`sha256:<hex>`) for verdict-spec-match. */
  evaluationSpecDigest?: string;
  /** Shared EvaluationSpec body for verdicts that omit a per-verdict copy. */
  evaluationSpec?: EvaluationSpec;
  /** Terminal could-not-grade signal for unscorable derivation (§8.2). */
  evaluationTerminal?: "could-not-grade";
  /** Ignored by assembly — integrity tier is sourced only from `AdmissionEvidencePort`. */
  integrityTier?: IntegrityTier;
}

export interface InScopeVerdict {
  digest: `sha256:${string}`;
  /** Sealed or logical verdict payload used by verdict-spec-match / consistency checks. */
  record: {
    evaluationSpecification?: string;
    evaluator?: string;
    verdict?: string;
    [key: string]: unknown;
  };
  /**
   * Required for a verdict to become valid/judged: profiles `checkVerdictConsistency`
   * fails closed when EvaluationSpec or measurements are missing.
   */
  measurements?: MeasurementMap;
  evaluationSpec?: EvaluationSpec;
  delivered?: VerdictOutcome;
  declaredUnscorableClass?: string;
}

/** Declared input scope at the close boundary — never "known to" any party (§8.3). */
export interface InputScope {
  submissionsForRun(runDigest: string): AsyncIterable<InScopeCell>;
  /** Cancellation marker from launch drain — Matrix completeness.runOutcome becomes "cancelled". */
  runCancelled?: boolean;
}

/** Trust §7.5 steps 1–4 at effective time; fail-closed on unresolved (§8.1/§8.3). */
export interface TrustResolver {
  resolveAgent(evidence: unknown, at: Date): Promise<string | "unresolved">;
}

export interface CloseBoundary {
  at: string;
  anchor?: { chain: string; blockNumber: number; blockHash: string };
}

/** Local: just `at`; marketplace: `at` + first finalized block at/after closeAt (M7). */
export interface CloseBoundaryResolver {
  resolve(run: RunRecord): Promise<CloseBoundary>;
}

export interface PinningObservation {
  harness: PinningAxisStatus;
  model: PinningAxisStatus;
  loadout: PinningAxisStatus;
  isolation: PinningAxisStatus;
}

/** Evidence Runtime Observation / attestation → per-axis pinning status (§8.1). */
export interface PinningObservationPort {
  observe(delivery: unknown, arm: unknown): Promise<PinningObservation>;
}

/** Admission receipt → integrity tier; conservative `attested-only` when absent (§8.4). */
export interface AdmissionEvidencePort {
  tierFor(
    cell: Pick<InScopeCell, "cellKey" | "taskDigest" | "evaluationSpecDigest">,
  ): Promise<IntegrityTier>;
}

/** Optional cost/latency sourcing pinned by assembly procedure version (§8.3). */
export interface CostSource {
  costFor(cell: InScopeCell): Promise<CellCost | undefined>;
  latencyFor(cell: InScopeCell): Promise<number | undefined>;
}

/** Optional Matrix authority / signature verification through injected ports (§12.1). */
export interface MatrixSignaturePort {
  verifyMatrixAuthority(
    matrixBytes: Uint8Array,
    run: RunRecord,
  ): Promise<{ ok: true } | { ok: false; detail: string }>;
}

/** The full injected port bag `assembleMatrix` / `verifyMatrix` consume. */
export interface AssemblyPorts {
  inputScope: InputScope;
  trust: TrustResolver;
  closeBoundary: CloseBoundaryResolver;
  pinning: PinningObservationPort;
  admission: AdmissionEvidencePort;
  cost: CostSource;
  verifySignatures?: MatrixSignaturePort;
}

export type AssemblyProcedure = {
  procedure: string;
  version: string;
};
