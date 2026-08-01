// SPDX-License-Identifier: Apache-2.0

import type {
  ChainInstance,
  ChainMaterializer,
  NetworkPolicy,
} from "@jinn-network/chain-environment-record";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";

import type { ResourceDescriptor } from "./digests.js";
import type { VerifierIdentity } from "./predicate.js";

/** Injected time. No production module in this package reads the system clock directly. */
export interface Clock {
  now(): Date;
}

export interface ArtifactPutReceipt {
  readonly digest: Sha256Digest;
  readonly size: number;
}

/**
 * Digest-addressed artifact store. Unlike the SWE sibling's write-only port, this one has a
 * read side, because design §5.1 step 1 resolves and digest-verifies every resource *before*
 * anything is materialized (Finding F-CE3-2). An `EvidenceRepository` adapts in a few lines;
 * this package declares the narrowest surface it uses so it takes no dependency on the
 * evidence tree.
 */
export interface ArtifactStore {
  /** Resolves by digest. Implementations MUST fail rather than return other bytes; the
   * caller re-digests anyway, and a mismatch is `artifact-unavailable`. */
  getArtifact(
    reference: ResourceDescriptor,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array>;
  putArtifact(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactPutReceipt>;
}

/** One resource, resolved and digest-verified at step 1. The ordered list of these is the
 * resolution log, whose digest rides in the attestation's isolation evidence. */
export interface ResolvedResource {
  readonly name: string;
  readonly descriptor: ResourceDescriptor;
  readonly digest: Sha256Digest;
  readonly size: number;
}

export interface ChainProbeExecutionRequest {
  readonly instance: ChainInstance;
  readonly probeSuiteBytes: Uint8Array;
  readonly comparatorBytes: Uint8Array;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface ChainProbeExecutionResult<Observation = unknown> {
  readonly observation: Observation;
  readonly observationDigest: Sha256Digest;
  readonly timedOut: boolean;
  readonly cost: { readonly wallSeconds: number };
}

export interface ChainProbeExecutor<Observation = unknown> {
  execute(request: ChainProbeExecutionRequest): Promise<ChainProbeExecutionResult<Observation>>;
}

/**
 * The chain plane's runtime. Two ports, not one: a consumer that only wants to materialize a
 * world (a solver's local runner) supplies a materializer and never a probe executor, which
 * is exactly the seam design §3 declares public.
 */
export interface ChainRuntime {
  readonly materializer: ChainMaterializer;
  readonly probes: ChainProbeExecutor;
}

/**
 * The information plane's runtime, injected only when a composite composes information
 * worlds. Absent-and-needed is `verification-infrastructure-failure`, never a silent skip:
 * a composite whose information plane was not exercised has not been verified (E14 sequences
 * the chain-only path first, so v1 composites carry an empty `informationWorlds` list and
 * never reach this port).
 */
export interface InformationWorldRuntime {
  serve(request: {
    readonly instance: ChainInstance;
    readonly worldRecords: readonly Uint8Array[];
    readonly corpora: ReadonlyMap<string, Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly observation: unknown; readonly egressAttempts: readonly string[] }>;
}

export interface ChainVerificationDeps {
  readonly runtime: ChainRuntime;
  readonly artifactStore: ArtifactStore;
  /** A signing function. This package never holds, reads, or derives key material. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain (design §5.3, Finding F-CE3-1). */
  readonly verifier: VerifierIdentity;
  /** Composite-only; see `InformationWorldRuntime`. */
  readonly informationRuntime?: InformationWorldRuntime;
}

/**
 * Design §5.1 step 2. Every direction is closed and the instance carries no fork backend,
 * which is the shape a sealed `closed-state` world has. A caller verifying a record whose
 * runtime *is* configured with a fork backend passes `forkBackend: "present"`, and the
 * protocol switches to the refusal evidence mode.
 */
export const DEFAULT_BLACKHOLE_POLICY: NetworkPolicy = Object.freeze({
  egress: "denied",
  dns: "absent",
  archiveRpc: "unreachable",
  forkBackend: "absent",
}) as NetworkPolicy;
