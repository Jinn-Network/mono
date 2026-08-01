// Type declarations ONLY. Design §3 makes the runtime surface public but homes its contracts
// here, so four consumers — the verifier, the admission observation port, the evaluation
// replayer, and a solver's own local runner — can depend on the contract without depending on
// the capability that implements it. A runtime value in this module would defeat that, and
// `ports.test.ts` asserts the module's runtime export set is empty.

import type { ChainEnvironmentRecord } from "./chain-record.js";
import type { CapabilityEnvelope } from "./envelope.js";
import type { ChainSolutionScript } from "./solution.js";

/**
 * Every byte a materialization needs, already resolved and digest-verified by the caller,
 * keyed by the record-body digest spelling. Resolution is the caller's business precisely
 * because it is the step that touches the network: a materializer that fetched its own inputs
 * would hold ambient authority, and no closure claim over it would mean anything.
 */
export interface ResolvedResources {
  readonly byDigest: ReadonlyMap<`sha256:${string}`, Uint8Array>;
}

/**
 * The execution context's network stance, travelling **with** the materialization request
 * rather than being asserted about it afterwards (§5.1 step 2). An attestation that named a
 * control the run was never given would be describing a different run.
 */
export interface NetworkPolicy {
  readonly egress: "denied";
  readonly dns: "absent";
  readonly archiveRpc: "unreachable";
  /** A sealed instance has no fork backend at all; §4.2's boundary rule depends on which. */
  readonly forkBackend: "absent" | "present";
}

/**
 * What the runtime turned out to be, as opposed to what the record asked for (§5.1 step 3). A
 * version string alone is insufficient, which is why every identity field is here — and
 * `unsupportedControls` is the point of the block: a determinism control the pinned runtime
 * cannot actually apply must surface as a named fact, never be silently dropped (§10).
 */
export interface RuntimeIdentityObservation {
  readonly imageManifestDigest: `sha256:${string}`;
  readonly platform: string;
  readonly reportedVersion: string;
  readonly binaryDigest: `sha256:${string}`;
  readonly evmConfigurationDigest: `sha256:${string}`;
  readonly chainId: number;
  readonly appliedControls: Readonly<Record<string, string>>;
  readonly unsupportedControls: readonly string[];
}

/**
 * The identities the materializer **actually loaded into the instance** — read back from the
 * materialized world, never copied from the artifact it was given. That direction is the whole
 * value of the block: a report derived from its own input cannot validate that input, and a
 * census transcribed from the artifact would agree with the artifact by construction while
 * saying nothing about the world that booted.
 *
 * E13's coverage set is computed over exactly these, so the member names match
 * `StateEntryCounts` one-for-one — `accounts.length` against `entryCounts.accounts`, and so on.
 * Two vocabularies for one partition is how an off-by-one mapping gets written and never
 * noticed. Read the other way, the equality is a loader-versus-producer cross-check: a mismatch
 * means the two disagree about the slice, and no census computed over the artifact is then true
 * of the instance.
 */
export interface ArtifactEntryObservation {
  readonly accounts: readonly string[];
  readonly codeEntries: readonly string[];
  readonly storageSlots: readonly { readonly address: string; readonly slot: string }[];
}

/** §5.1 step 6, and the isolation-evidence block of the §5.3 attestation. */
export interface IsolationObservation {
  readonly networkPolicy: NetworkPolicy;
  readonly egressAttempts: readonly {
    readonly target: string;
    readonly outcome: "refused" | "succeeded";
    readonly detail?: string;
  }[];
  readonly forbiddenProbes: readonly {
    readonly method: string;
    readonly expectedClass: string;
    readonly observedClass: string;
  }[];
  readonly exposedSignerAccounts: readonly string[];
  readonly ceilingChecks: readonly { readonly name: string; readonly enforced: boolean }[];
}

/** Cost observations (§5.3). Measurements, never gates. */
export interface MaterializationCost {
  readonly wallSeconds: number;
  readonly cpuSeconds?: number;
  readonly maxMemoryBytes?: number;
  readonly diskBytes?: number;
  readonly rpcCalls?: number;
  readonly rpcBytes?: number;
}

/**
 * Everything a materialization observed that the verification protocol reads and the
 * attestation predicate carries. It is data, not behaviour, which is why it can live in a
 * tier-2 package: this declares the shape of the facts, and asserts none of them.
 */
export interface MaterializationReport {
  readonly runtimeIdentity: RuntimeIdentityObservation;
  readonly artifactEntries: ArtifactEntryObservation;
  /**
   * The commitment of the post-fixture, agent-visible world this instance actually came up
   * with — spelled the way the record spells it (`0x` + 64 lowercase hex), because §5.1 step 5
   * compares it directly against `stateMaterialization.initialStateCommitment` and a comparison
   * across two spellings is a conversion nobody specified.
   */
  readonly postFixtureCommitment: `0x${string}`;
  /** Every resource actually loaded, so "no uncommitted resource loaded" is checkable (§5.1 step 9). */
  readonly loadedResources: readonly `sha256:${string}`[];
  readonly isolation: IsolationObservation;
  readonly cost: MaterializationCost;
}

/**
 * A live instance, and the **structural floor** every consumer may rely on. Run-local identity,
 * destroyed after; never promoted, never a record (§4.5).
 *
 * `report` is optional for one reason, and it is the reason the runtime surface is public at
 * all: a solver's local runner materializes a world to drive its agent against and wants none
 * of the verification machinery. Requiring it to produce isolation evidence and cost
 * observations would make the decisive consumer in the seam argument pay for a capability it
 * never uses. A verifying implementation always populates it, and narrows the handle to say so
 * — `ChainInstance & { report: MaterializationReport }` — which keeps ONE declaration of the
 * shape rather than two. A materializer that returns no report cannot be verified, and that is
 * an infrastructure failure the verifier names rather than a claim it can make anyway.
 */
export interface ChainInstance {
  /** Echoes `MaterializationRequest.instanceId`; a verifier asserts the two agree. */
  readonly instanceId: string;
  /** A runner-local endpoint. Under the blackhole policy it is the only reachable interface. */
  readonly rpcEndpoint: string;
  readonly report?: MaterializationReport;
  readonly stop: () => Promise<void>;
}

/**
 * Read-only chain state supplied by the caller, for the materialization classes that resolve
 * historical state at run time rather than from a committed artifact.
 *
 * It is injected for two reasons that both matter. Custody first: a materializer that dialled
 * `archive.providerLocators` itself would hold ambient network authority, and every closure
 * claim about the surrounding process would be worth less. Second, and the reason the shape is
 * this narrow: a caller that owns the backend owns the record of what execution actually
 * reached for — which accounts, which slots, which code. A lazily-fetching fork hides that
 * behind its own cache, and a state extractor left guessing at it is back to trusting a dump,
 * which §7's widen-and-reverify loop exists precisely to avoid.
 *
 * Locators in a record are locators: they tell a caller where it *may* look. They are not an
 * instruction to the materializer, and nothing in this contract reads them.
 */
export interface ChainStateBackend {
  /**
   * `undefined` means the account is absent at that block — which is a legitimate answer, not a
   * failure. A sealed world answers the same way for anything outside its committed slice
   * (§4.2's boundary rule), so absence has to be expressible here or the two would disagree.
   *
   * `storageRoot` is **optional** because no plain JSON-RPC method carries it: `eth_getBalance`,
   * `eth_getTransactionCount`, and `eth_getCode` do not, and only `eth_getProof` does. Requiring
   * it would put a proof-sized call behind every distinct account a fork touches, and would fail
   * outright against archives that do not implement `eth_getProof`. A backend that already holds
   * proof data may pass it through; a backend serving plain reads omits it. `codeHash` stays
   * mandatory: it is keccak over the code bytes, and the fork backends that consume this resolve
   * accounts as nonce/balance/code-hash anyway.
   */
  getAccount(address: string, blockNumber: number): Promise<{
    readonly nonce: string;
    readonly balanceWei: string;
    readonly codeHash: string;
    readonly storageRoot?: string;
  } | undefined>;
  getCode(address: string, blockNumber: number): Promise<string | undefined>;
  getStorageAt(address: string, slot: string, blockNumber: number): Promise<string | undefined>;
  getBlockHeader(blockNumber: number): Promise<{
    readonly hash: string;
    readonly stateRoot: string;
    readonly timestamp: number;
  } | undefined>;
}

export interface MaterializationRequest {
  readonly record: ChainEnvironmentRecord;
  readonly resources: ResolvedResources;
  /**
   * Assigned by the **caller**, not the runtime (§5.1 step 8). K distinct ids are the verifier's
   * claim about having launched K fresh processes; a runtime that named its own instances would
   * be asserting its own freshness, which is the one party whose word cannot settle it.
   */
  readonly instanceId: string;
  /** Travels with the request (§5.1 step 2), so the attestation describes the run that happened. */
  readonly networkPolicy: NetworkPolicy;
  /**
   * Required whenever `requiresStateBackend(record)` is true — that is, for every
   * `archive-dependent` record. **Normative:** a materializer handed such a record without a
   * backend fails closed; it never falls back to a locator from the record. A `closed-state`
   * record needs no backend at all, and passing one does not make it archive-dependent.
   */
  readonly stateBackend?: ChainStateBackend;
  readonly signal?: AbortSignal;
}

/**
 * A handle a verifying materializer returns: the floor, narrowed to say the report is present.
 * Declared here rather than in the capability so the family carries ONE shape for one instance
 * — a second, wider interface elsewhere is exactly the drift that homing these types in the
 * record package prevents.
 */
export type VerifiedChainInstance = ChainInstance & {
  readonly report: MaterializationReport;
};

/**
 * Brings a described world into existence, and rewinds one to its baseline.
 *
 * `reset` returns the post-reset commitment because `reset-divergence` is decided against it
 * and nothing else can produce it; `stop` disposes an instance and is not a reset. A runner
 * with no rewind mechanism implements `reset` by materializing afresh, which is what a
 * `closed-state` record's `fresh-process` reset mechanism means anyway.
 */
export interface ChainMaterializer {
  materialize(request: MaterializationRequest): Promise<ChainInstance>;
  reset(instance: ChainInstance, signal?: AbortSignal): Promise<`0x${string}`>;
}

export interface ProbeExecutionRequest {
  readonly instance: ChainInstance;
  readonly probeSuite: Uint8Array;
  readonly signal?: AbortSignal;
}

/**
 * The digest is over the **canonical observation**, never over backend JSON (§5.1 step 7).
 * `Observation` is a parameter rather than a named type because the canonical chain observation
 * schema belongs to the evaluation family, not to this package.
 */
export interface ProbeExecutionResult<Observation> {
  readonly observation: Observation;
  readonly observationDigest: `sha256:${string}`;
}

export interface ProbeExecutor<Observation = unknown> {
  execute(request: ProbeExecutionRequest): Promise<ProbeExecutionResult<Observation>>;
}

export interface ReplayRequest {
  readonly instance: ChainInstance;
  readonly script: ChainSolutionScript;
  /** The effective envelope: the record's, as tightened by the task. */
  readonly envelope: CapabilityEnvelope;
  readonly signal?: AbortSignal;
}

/** A script exceeding the envelope is refused, not graded (§6.4, §8). */
export interface ReplayRefusal {
  readonly reason:
    | "envelope-exceeded"
    | "operation-not-permitted"
    | "signer-not-in-scope"
    | "environment-mismatch";
  readonly detail: string;
}

export type ReplayOutcome<Observation = unknown> =
  | {
      readonly status: "replayed";
      readonly observation: Observation;
      readonly observationDigest: `sha256:${string}`;
      /** Values the script reported, by name, for the read-and-report predicate shape. */
      readonly reportedValues: Readonly<Record<string, string>>;
    }
  | { readonly status: "refused"; readonly refusal: ReplayRefusal };

export interface ScriptReplayer<Observation = unknown> {
  replay(request: ReplayRequest): Promise<ReplayOutcome<Observation>>;
}
