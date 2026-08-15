// SPDX-License-Identifier: Apache-2.0

import type {
  ChainStateBackend,
  ScriptReplayer,
} from "@jinn-network/chain-environment-record";
import type {
  ArtifactStore,
  ChainRuntime,
  Clock,
  VerifiedChainMaterializer,
  VerifierIdentity,
} from "@jinn-network/chain-environment-verification";
import type { DsseSigner } from "@jinn-network/trust-core";

import type { BudgetedArchivePort } from "./budget.js";
import type { ArchiveBudgetLimits } from "./identifiers.js";
import { normalizeAddress, normalizeSlot, type Hex32, type HexAddress, type HexBytes, type HexQuantity } from "./hex.js";

export type {
  ArtifactStore, ChainRuntime, ChainStateBackend, Clock, ScriptReplayer,
  VerifiedChainMaterializer, VerifierIdentity,
};

/** `"finalized"` is how the anchor's finality is *observed*, never how it is chosen. */
export type BlockSelector = number | "latest" | "finalized";

export interface ArchiveBlockHeader {
  readonly number: number;
  readonly hash: Hex32;
  readonly parentHash: Hex32;
  readonly stateRoot: Hex32;
  /** Unix seconds. */
  readonly timestamp: number;
}

/**
 * Field names and optionality follow CE1's `ChainStateBackend` exactly (`balanceWei`, not
 * `balance`; `storageRoot` optional), so `asChainStateBackend` is a pass-through rather
 * than a translation layer. `storageRoot` is present only when the archive supplied a
 * proof anyway -- no plain JSON-RPC method carries it (CE1-F12 / F-CE4-10).
 */
export interface ArchiveAccountState {
  readonly nonce: HexQuantity;
  readonly balanceWei: HexQuantity;
  readonly codeHash: Hex32;
  readonly storageRoot?: Hex32;
}

/** EIP-1186. The proof binds this account to the state root of the block it was taken
 * at; that root's correspondence to canonical history is a separate step (design E5). */
export interface ArchiveAccountProof {
  readonly address: HexAddress;
  readonly balance: HexQuantity;
  readonly nonce: HexQuantity;
  readonly codeHash: Hex32;
  readonly storageHash: Hex32;
  readonly accountProof: readonly HexBytes[];
  readonly storageProof: readonly {
    readonly key: Hex32;
    readonly value: HexQuantity;
    readonly proof: readonly HexBytes[];
  }[];
}

/**
 * The only network dependency in this package, and it is injected.
 *
 * Authoring-time only: nothing at verification or run time may hold one. The host
 * implements it over whatever archive access it has; this package never learns the
 * provider's name, URL, or credentials -- a provider is a locator, never identity
 * (design §4.1). Implementations MUST be free of hidden retry-with-different-provider
 * behavior: a differing answer for the same (method, arguments, block) is a fact this
 * package needs to see, not smooth over (design §5.2).
 */
export interface ArchiveRpcPort {
  getBlockHeader(selector: BlockSelector, signal?: AbortSignal): Promise<ArchiveBlockHeader>;
  /** `undefined` means the account does not exist at that block -- a fact worth carrying:
   * execution that reads an empty account must be reproducible too, and T7 covers it with
   * an absence proof. */
  getAccount(address: HexAddress, block: number, signal?: AbortSignal): Promise<ArchiveAccountState | undefined>;
  getCode(address: HexAddress, block: number, signal?: AbortSignal): Promise<HexBytes>;
  getStorageAt(address: HexAddress, slot: Hex32, block: number, signal?: AbortSignal): Promise<Hex32>;
  getProof(
    address: HexAddress,
    slots: readonly Hex32[],
    block: number,
    signal?: AbortSignal,
  ): Promise<ArchiveAccountProof>;
}

export interface ArchiveUsage {
  readonly calls: number;
  readonly bytes: number;
  readonly limits: ArchiveBudgetLimits;
  /** Which ceiling stopped the pipeline, if one did. */
  readonly exhausted?: "calls" | "bytes";
}

/**
 * How the connected fork reaches the archive. Finding F-CE4-1: a fork backend must never
 * be a URL this package holds -- that is ambient authority, and it would route the
 * runtime's lazy fetches around the budget and the journal, which is where this
 * pipeline's harvest ground truth comes from.
 */
export type ForkBackendBinding =
  /** CE1/CE3 accept an injected state backend on the materialize request (disposition A). */
  | { readonly kind: "injected-port" }
  /**
   * The host serves a runner-local JSON-RPC endpoint from the SAME injected port and gives
   * CE4 its locator to write into `stateMaterialization.archive.providerLocators`
   * (disposition B -- needs no upstream change; locators are record data, and this package
   * still dials nothing).
   */
  | { readonly kind: "locator"; readonly locator: string };

/**
 * Optional. CE1 and CE3 disagree about the instance handle's shape and neither pins a
 * dump method (F-CE4-2), and this pipeline does not need one: the journal is the closure
 * set. A host that can dump supplies this port and gets a cross-check; a host that cannot
 * loses nothing but the cross-check.
 */
export interface ChainStateDump {
  readonly accounts: Readonly<Record<string, {
    readonly balance: string;
    readonly nonce: string;
    readonly code?: string;
    readonly storage?: Readonly<Record<string, string>>;
  }>>;
}

export interface StateDumpPort {
  dump(instanceId: string, signal?: AbortSignal): Promise<ChainStateDump>;
}

/**
 * Everything this package touches the world through. Six of the seven members are what
 * CE3's two protocol entry points need, because this pipeline invokes them as a library;
 * `archive` and `forkBackend` are what CE4 adds, and both are authoring-time only.
 */
export interface ExtractionDeps {
  readonly archive: ArchiveRpcPort;
  readonly forkBackend: ForkBackendBinding;
  /**
   * CE3's `ChainRuntime` (`{materializer, probes}`), narrowed so the materializer is the
   * **reporting** one. CE4 cannot write `initialStateCommitment` without
   * `report.postFixtureCommitment`, so a host that composes a non-reporting materializer
   * should fail at composition, in its own types, rather than at extraction time -- and
   * `deps.runtime` still satisfies `ChainVerificationDeps["runtime"]` when it is handed
   * straight to CE3.
   */
  readonly runtime: ChainRuntime & { readonly materializer: VerifiedChainMaterializer };
  /** CE1's `ScriptReplayer`, used to replay the author's reference scripts during
   * localization. CE3's `ChainRuntime` does not carry it, so it is injected beside. */
  readonly replayer: ScriptReplayer;
  /** Optional (F-CE4-2): a cross-check only. The journal, not a dump, is the closure set. */
  readonly stateDump?: StateDumpPort;
  readonly artifactStore: ArtifactStore;
  /** A signing function. This package never holds, reads, or derives key material; it
   * forwards it to CE3, which seals the attestation. */
  readonly signer: DsseSigner;
  readonly clock: Clock;
  /** Host-declared identity of the running toolchain; forwarded to CE3 unchanged. */
  readonly verifier: VerifierIdentity;
}

/**
 * Presents the budgeted port as CE1's `ChainStateBackend`, which is what a `fork`
 * materialization takes (`requiresStateBackend(record) === true`). Nothing is translated:
 * the field names match, `storageRoot` is optional on both sides (CE1-F12), and account
 * absence is `undefined` on both sides -- which matters more than it looks. A backend that
 * reported zero-values for an absent account would disagree with the sealed world it is
 * about to produce, where an out-of-slice read is empty by the boundary rule (design §4.2);
 * the disagreement would then surface as probe noise instead of as the coverage fact it is.
 *
 * The adapter still exists for two small jobs: normalizing the address and slot spellings
 * before they reach the journal, and narrowing the header to the three fields CE1 declares.
 */
export function asChainStateBackend(archive: BudgetedArchivePort): ChainStateBackend {
  return {
    async getAccount(address, blockNumber) {
      return archive.getAccount(normalizeAddress(address), blockNumber);
    },
    async getCode(address, blockNumber) {
      return archive.getCode(normalizeAddress(address), blockNumber);
    },
    async getStorageAt(address, slot, blockNumber) {
      return archive.getStorageAt(normalizeAddress(address), normalizeSlot(slot), blockNumber);
    },
    async getBlockHeader(blockNumber) {
      const header = await archive.getBlockHeader(blockNumber);
      return { hash: header.hash, stateRoot: header.stateRoot, timestamp: header.timestamp };
    },
  };
}
