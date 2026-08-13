import type {
  AttemptDescriptor,
  ProtocolObservation,
} from "@jinn-network/task-execution-protocol";

export type BenchmarkSubmissionUri = `urn:uuid:${string}`;
export type BenchmarkAttemptUri = `urn:uuid:${string}`;

/** The backend capability projection used by benchmark quote/launch procedures. */
export interface BenchmarkBackendCapabilities {
  readonly watch: boolean;
  readonly runPinning: {
    readonly keys: readonly {
      readonly key: string;
      readonly inventory: readonly string[];
    }[];
  };
}

export interface BenchmarkObservationCursor {
  readonly sequence: string;
}

export interface BenchmarkObservationSnapshot {
  readonly descriptor: AttemptDescriptor;
  readonly cursor: BenchmarkObservationCursor;
  readonly observations: readonly ProtocolObservation[];
}

/**
 * The structural backend port required by benchmark dispatch.
 *
 * Keeping this application port here prevents verification-only consumers of
 * matrix assembly from installing an execution backend. Concrete TEP backends
 * satisfy it structurally; this package does not redefine backend behavior.
 */
export interface BenchmarkExecutionBackend {
  capabilities(): Promise<BenchmarkBackendCapabilities>;
  submit(taskBytes: Uint8Array, submissionBytes: Uint8Array): Promise<
    | { readonly accepted: true; readonly submission: BenchmarkSubmissionUri; readonly digest: `sha256:${string}` }
    | { readonly accepted: false; readonly error: { readonly category: string; readonly detail?: string } }
  >;
  observe(ref: BenchmarkSubmissionUri | BenchmarkAttemptUri): Promise<BenchmarkObservationSnapshot>;
  watch?(
    ref: BenchmarkSubmissionUri | BenchmarkAttemptUri,
    cursor?: BenchmarkObservationCursor,
  ): AsyncIterable<ProtocolObservation>;
  cancel?(attempt: BenchmarkAttemptUri, reason: string): Promise<unknown>;
}
