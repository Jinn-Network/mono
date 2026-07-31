// SPDX-License-Identifier: Apache-2.0

import { CommandSpecSchema, type EnvironmentRecord } from "@jinn-network/environment-record";
import type { DsseSigner, Sha256Digest } from "@jinn-network/trust-core";
import type { z } from "zod";

import type { OutcomeSet } from "./outcome-set.js";
import type { VerifierIdentity } from "./predicate.js";

/** The record's shell-free command shape (C1's `CommandSpecSchema`). */
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

/** The record's pinned parser identity, carried into every run request so the
 * runtime resolves the same parser the record names. */
export type EnvironmentParserIdentity = EnvironmentRecord["parser"];

/** Injected time. No production module calls `Date.now()`. */
export interface Clock {
  now(): Date;
}

export interface ArtifactPutReceipt {
  readonly digest: Sha256Digest;
  readonly size: number;
}

/**
 * Digest-addressed artifact sink. An `EvidenceRepository` adapts in three lines
 * (see README); this package declares the narrowest surface it uses so it takes
 * no dependency on the evidence tree.
 */
export interface ArtifactStore {
  putArtifact(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ArtifactPutReceipt>;
}

export interface ImagePullRequest {
  /** Authoritative. `reference` is advisory (design §5.3 step 1). */
  readonly manifestDigest: Sha256Digest;
  readonly platform: string;
  readonly reference?: string;
  readonly signal?: AbortSignal;
}

export interface ImagePullResult {
  /** What the registry actually resolved. The caller compares it to the
   * requested digest and refuses a mismatch (`error/acquire`). */
  readonly resolvedManifestDigest: Sha256Digest;
}

export interface ContainerRunRequest {
  readonly manifestDigest: Sha256Digest;
  readonly platform: string;
  readonly workspace: string;
  /** Run first, inside this run's own container (see Findings F-C2-2). */
  readonly installCommands: readonly CommandSpec[];
  /** The record's declared verification scope. */
  readonly testCommands: readonly CommandSpec[];
  /** The record's pinned parser. Implementations acquire it by digest and MUST
   * fail closed on mismatch; the parser is what fixes the outcome vocabulary. */
  readonly parser: EnvironmentParserIdentity;
  /** Declared controls, already flattened to environment variables. */
  readonly env: Readonly<Record<string, string>>;
  readonly network: "none";
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface ContainerRunResult {
  /**
   * Identifies the container this run executed in. Every run gets a FRESH
   * container from the same image (design §5.3 step 3); the caller records
   * these ids so a host -- and this package's kit -- can check that rule
   * instead of trusting it.
   */
  readonly containerId: string;
  readonly installExitCodes: readonly number[];
  readonly testExitCodes: readonly number[];
  /** Parsed outcomes of the test commands, merged by test id. */
  readonly outcomes: OutcomeSet;
  readonly wallSeconds: number;
  readonly timedOut: boolean;
  /** Optional raw log bytes, stored as `evidence` when present. */
  readonly log?: Uint8Array;
}

export interface ContainerRuntime {
  pullByDigest(request: ImagePullRequest): Promise<ImagePullResult>;
  /** Creates a fresh container from the image, runs install then test commands
   * in it, parses the test output, and discards the container. */
  runContainer(request: ContainerRunRequest): Promise<ContainerRunResult>;
}

export interface VerificationDeps {
  readonly containerRuntime: ContainerRuntime;
  readonly artifactStore: ArtifactStore;
  /** Signer object. This package never holds, reads, or derives key material. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain (Findings F-C2-1). */
  readonly verifier: VerifierIdentity;
}
