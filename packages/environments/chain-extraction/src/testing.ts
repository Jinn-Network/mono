// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture loading only) and
// is allowlisted for this file in the tree guard. Grows task by task.

import type {
  ChainEnvironmentRecord,
  ChainInstance,
  MaterializationReport,
  MaterializationRequest,
  NetworkPolicy,
  ProbeExecutionRequest,
  ScriptReplayer,
} from "@jinn-network/chain-environment-record";
import {
  fromDigestSet,
  type DigestSet,
} from "@jinn-network/chain-environment-verification";
import {
  buildCanonicalChainObservation,
  chainObservationDigest,
  CHAIN_OBSERVATION_SCHEMA_ID,
  type CanonicalChainObservation,
} from "@jinn-network/chain-environment-verification";
import { canonicalJsonBytes, compareCodeUnitStrings, recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";

import type { ExtractionRequest } from "./baseline.js";
import { establishBaseline, type ConnectedBaseline } from "./baseline.js";
import { captureAnchor } from "./anchor.js";
import { createBudgetedArchivePort } from "./budget.js";
import {
  parseStateArtifact,
  serializeStateArtifact,
  stateArtifactDigest,
  stateArtifactEntryCounts,
  stateArtifactKeySet,
  type StateArtifact,
} from "./artifact.js";
import { PROVISIONAL_COMMITMENT } from "./candidate.js";
import { extractEnvironment } from "./extract.js";
import { DEFAULT_ARCHIVE_BUDGET } from "./identifiers.js";
import { keySetIsEmpty } from "./key-set.js";
import { widenAndReverify } from "./widen.js";
import type {
  ArchiveAccountProof,
  ArchiveRpcPort,
  ArtifactStore,
  BlockSelector,
  ChainStateBackend,
  Clock,
  ExtractionDeps,
  StateDumpPort,
  VerifierIdentity,
} from "./ports.js";
import { BLACKHOLE_EGRESS_POLICY_ID } from "@jinn-network/chain-environment-record";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createRequire } from "node:module";
import { STATE_ARTIFACT_SCHEMA_VERSION } from "./identifiers.js";
import { normalizeAddress, normalizeHex32, normalizeQuantity, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";
import type { RlpItem } from "./rlp.js";

const require = createRequire(import.meta.url);
const { buildConformanceChainRecord } = require(
  "../../chain-verification/dist/conformance-records.js",
) as {
  buildConformanceChainRecord: (options?: { closureClass?: "archive-dependent" }) => ChainEnvironmentRecord;
};

export const FAKE_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_ORACLE = "0xcccccccccccccccccccccccccccccccccccccccc";
export const FAKE_TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";
export const FAKE_ACTOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const FAKE_SLOT_1 = `0x${"0".repeat(63)}1`;
export const FAKE_SLOT_2 = `0x${"0".repeat(63)}2`;
export const FAKE_SEALED_COMMITMENT = `0x${"5".repeat(64)}` as `0x${string}`;

const EMPTY_HASH = keccak_256(new Uint8Array(0));
const EMPTY_TRIE_ROOT = keccak_256(new Uint8Array([0x80]));

interface FakeAccount {
  readonly balance: string;
  readonly nonce: string;
  readonly code?: string;
  readonly storage: ReadonlyMap<string, string>;
}

export interface FakeTrieWorldOptions {
  readonly tamperSlot?: { readonly address: HexAddress; readonly slot: Hex32 };
}

export interface FakeTrieWorld {
  readonly stateRoot: Hex32;
  proofFor(address: HexAddress, slots: readonly Hex32[]): ArchiveAccountProof;
  absenceProofFor(address: HexAddress): ArchiveAccountProof;
  archive(): ArchiveRpcPort;
}

function fromHex(value: string): Uint8Array {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const padded = body.length % 2 === 0 ? body : `0${body}`;
  return Uint8Array.from((padded.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function encodeLength(length: number): Uint8Array {
  if (length < 256) return new Uint8Array([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array(bytes);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeRlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    if (item.length < 56) {
      const out = new Uint8Array(1 + item.length);
      out[0] = 0x80 + item.length;
      out.set(item, 1);
      return out;
    }
    const lenEnc = encodeLength(item.length);
    return concatBytes([new Uint8Array([0xb7 + lenEnc.length]), lenEnc, item]);
  }
  const encodedChildren = item.map(encodeRlp);
  const payload = concatBytes(encodedChildren);
  if (payload.length < 56) {
    return concatBytes([new Uint8Array([0xc0 + payload.length]), payload]);
  }
  const lenEnc = encodeLength(payload.length);
  return concatBytes([new Uint8Array([0xf7 + lenEnc.length]), lenEnc, payload]);
}

function packNibbles(path: readonly number[], leaf: boolean): Uint8Array {
  const odd = path.length % 2 === 1;
  const flags = (leaf ? 2 : 0) + (odd ? 1 : 0);
  const bytes: number[] = [];
  if (odd) {
    // proof.ts walk() reads flags from the high nibble of the first path byte.
    bytes.push((flags << 4) + path[0]!);
    for (let index = 1; index < path.length; index += 2) {
      bytes.push((path[index]! << 4) + (path[index + 1] ?? 0));
    }
  } else {
    bytes.push(flags << 4);
    for (let index = 0; index < path.length; index += 2) {
      bytes.push((path[index]! << 4) + (path[index + 1] ?? 0));
    }
  }
  return new Uint8Array(bytes);
}

function nibbles(bytes: Uint8Array): number[] {
  return [...bytes].flatMap((byte) => [byte >> 4, byte & 0x0f]);
}

function minimalBytes(value: string): Uint8Array {
  const bytes = fromHex(value);
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.slice(start);
}

function nodeRef(serialized: Uint8Array): Uint8Array {
  return keccak_256(serialized);
}

type TrieNode =
  | { readonly kind: "branch"; readonly children: readonly (TrieNode | null)[]; readonly value: Uint8Array | null }
  | { readonly kind: "extension"; readonly path: readonly number[]; readonly next: TrieNode }
  | { readonly kind: "leaf"; readonly path: readonly number[]; readonly value: Uint8Array };

function serializeNode(node: TrieNode): Uint8Array {
  if (node.kind === "branch") {
    const items: RlpItem[] = [];
    for (let index = 0; index < 16; index += 1) {
      const child = node.children[index] ?? null;
      items.push(child === null ? new Uint8Array(0) : nodeRef(serializeNode(child)));
    }
    items.push(node.value ?? new Uint8Array(0));
    return encodeRlp(items);
  }
  if (node.kind === "extension") {
    return encodeRlp([packNibbles(node.path, false), nodeRef(serializeNode(node.next))]);
  }
  return encodeRlp([packNibbles(node.path, true), node.value]);
}

function insertNode(node: TrieNode | null, path: readonly number[], value: Uint8Array): TrieNode {
  if (path.length === 0) {
    const children = node?.kind === "branch"
      ? node.children
      : Array.from({ length: 16 }, () => null);
    return { kind: "branch", children, value };
  }

  if (node === null) {
    return { kind: "leaf", path, value };
  }

  if (node.kind === "branch") {
    const [head, ...tail] = path;
    const children = [...node.children] as (TrieNode | null)[];
    children[head!] = insertNode(children[head!] ?? null, tail, value);
    return { kind: "branch", children, value: node.value };
  }

  const nodePath = node.path;
  let common = 0;
  while (common < nodePath.length && common < path.length && nodePath[common] === path[common]) {
    common += 1;
  }

  if (common === nodePath.length) {
    if (node.kind === "extension") {
      return { kind: "extension", path: node.path, next: insertNode(node.next, path.slice(common), value) };
    }
    if (path.length === common) {
      return { kind: "leaf", path: node.path, value };
    }
    const branch: TrieNode = {
      kind: "branch",
      children: Array.from({ length: 16 }, () => null),
      value: node.value,
    };
    const [head, ...tail] = path.slice(common);
    const children = [...branch.children] as (TrieNode | null)[];
    children[head!] = insertNode(null, tail, value);
    const next = { kind: "branch", children, value: node.value } as TrieNode;
    return common === 0 ? next : { kind: "extension", path: nodePath, next };
  }

  const children: (TrieNode | null)[] = Array.from({ length: 16 }, () => null);

  if (node.kind === "leaf") {
    const nibble = nodePath[common]!;
    const remainder = nodePath.slice(common + 1);
    children[nibble] = remainder.length === 0
      ? { kind: "leaf", path: [], value: node.value }
      : { kind: "leaf", path: remainder, value: node.value };
  } else {
    const nibble = nodePath[common]!;
    const remainder = nodePath.slice(common + 1);
    children[nibble] = remainder.length === 0
      ? node.next
      : { kind: "extension", path: remainder, next: node.next };
  }

  const newNibble = path[common]!;
  const newRemainder = path.slice(common + 1);
  children[newNibble] = newRemainder.length === 0
    ? { kind: "leaf", path: [], value }
    : { kind: "leaf", path: newRemainder, value };

  const branch: TrieNode = { kind: "branch", children, value: null };
  return common === 0
    ? branch
    : { kind: "extension", path: nodePath.slice(0, common), next: branch };
}

function collectProof(
  node: TrieNode | null,
  path: readonly number[],
  out: Uint8Array[],
): boolean {
  if (node === null) return false;
  const serialized = serializeNode(node);
  out.push(serialized);

  if (path.length === 0) {
    return node.kind === "branch" ? (node.value?.length ?? 0) > 0 : node.kind === "leaf";
  }

  if (node.kind === "branch") {
    const child = node.children[path[0]!];
    return collectProof(child ?? null, path.slice(1), out);
  }

  let common = 0;
  const nodePath = node.path;
  while (common < nodePath.length && common < path.length && nodePath[common] === path[common]) {
    common += 1;
  }
  if (common < nodePath.length) return false;
  if (node.kind === "leaf") return common === path.length;
  return collectProof(node.next, path.slice(common), out);
}

function buildTrie(entries: ReadonlyMap<string, Uint8Array>): { root: Uint8Array; trie: TrieNode | null } {
  let trie: TrieNode | null = null;
  for (const [key, value] of entries) {
    trie = insertNode(trie, nibbles(fromHex(key)), value);
  }
  if (trie === null) return { root: EMPTY_TRIE_ROOT, trie: null };
  const serialized = serializeNode(trie);
  const root = keccak_256(serialized);
  return { root, trie };
}

function accountRlp(account: FakeAccount, storageRoot: Uint8Array): Uint8Array {
  const code = account.code ? fromHex(account.code) : new Uint8Array(0);
  const codeHash = code.length === 0 ? EMPTY_HASH : keccak_256(code);
  return encodeRlp([
    minimalBytes(account.nonce),
    minimalBytes(account.balance),
    storageRoot,
    codeHash,
  ]);
}

const DEFAULT_ACCOUNTS = (): Map<string, FakeAccount> => new Map([
  [FAKE_POOL, {
    balance: "0x0",
    nonce: "0x1",
    code: "0x60016002",
    storage: new Map([
      [FAKE_SLOT_1, `0x${"0".repeat(63)}7`],
      [FAKE_SLOT_2, `0x${"0".repeat(63)}3`],
    ]),
  }],
  [FAKE_ORACLE, {
    balance: "0x0",
    nonce: "0x1",
    code: "0x60ff",
    storage: new Map([[FAKE_SLOT_1, `0x${"0".repeat(62)}2a`]]),
  }],
  [FAKE_TOKEN, {
    balance: "0x0",
    nonce: "0x1",
    code: "0x6042",
    storage: new Map([[FAKE_SLOT_1, `0x${"0".repeat(63)}5`]]),
  }],
  [FAKE_ACTOR, {
    balance: "0xde0b6b3a7640000",
    nonce: "0x0",
    storage: new Map(),
  }],
]);

export function buildFakeTrieWorld(options: FakeTrieWorldOptions = {}): FakeTrieWorld {
  const accounts = DEFAULT_ACCOUNTS();
  const storageTries = new Map<string, { root: Uint8Array; trie: TrieNode | null }>();
  const stateEntries = new Map<string, Uint8Array>();

  for (const [address, account] of accounts) {
    const storageEntries = new Map<string, Uint8Array>();
    for (const [slot, value] of account.storage) {
      const normalizedSlot = normalizeSlot(slot);
      const slotKey = toHex(keccak_256(fromHex(normalizedSlot)));
      storageEntries.set(slotKey, encodeRlp(minimalBytes(value)));
    }
    const storageTrie = buildTrie(storageEntries);
    storageTries.set(normalizeAddress(address), storageTrie);
    const accountKey = toHex(keccak_256(fromHex(address)));
    stateEntries.set(accountKey, accountRlp(account, storageTrie.root));
  }

  const stateTrie = buildTrie(stateEntries);

  const proofFor = (address: HexAddress, slots: readonly Hex32[]): ArchiveAccountProof => {
    const normalized = normalizeAddress(address);
    const account = accounts.get(normalized);
    if (account === undefined) {
      return absenceProofFor(address);
    }
    const storageTrie = storageTries.get(normalized)!;
    const accountPath = nibbles(keccak_256(fromHex(normalized)));
    const accountNodes: Uint8Array[] = [];
    collectProof(stateTrie.trie, accountPath, accountNodes);

    const code = account.code ? fromHex(account.code) : new Uint8Array(0);
    const codeHash = code.length === 0 ? EMPTY_HASH : keccak_256(code);

    const storageProof = slots.map((slot) => {
      const normalizedSlot = normalizeSlot(slot);
      let value = account.storage.get(normalizedSlot) ?? account.storage.get(slot) ?? "0x0";
      if (options.tamperSlot?.address === normalized && options.tamperSlot.slot === normalizedSlot) {
        value = "0xdead";
      }
      const slotPath = nibbles(keccak_256(fromHex(normalizedSlot)));
      const nodes: Uint8Array[] = [];
      collectProof(storageTrie.trie, slotPath, nodes);
      return {
        key: normalizedSlot,
        value: normalizeQuantity(value),
        proof: nodes.map(toHex),
      };
    });

    return {
      address: normalized,
      balance: normalizeQuantity(account.balance),
      nonce: normalizeQuantity(account.nonce),
      codeHash: normalizeHex32(toHex(codeHash)),
      storageHash: normalizeHex32(toHex(storageTrie.root)),
      accountProof: accountNodes.map(toHex),
      storageProof,
    };
  };

  const absenceProofFor = (address: HexAddress): ArchiveAccountProof => {
    const normalized = normalizeAddress(address);
    const accountPath = nibbles(keccak_256(fromHex(normalized)));
    const accountNodes: Uint8Array[] = [];
    collectProof(stateTrie.trie, accountPath, accountNodes);
    return {
      address: normalized,
      balance: "0x0",
      nonce: "0x0",
      codeHash: normalizeHex32(toHex(EMPTY_HASH)),
      storageHash: normalizeHex32(toHex(EMPTY_TRIE_ROOT)),
      accountProof: accountNodes.map(toHex),
      storageProof: [],
    };
  };

  const archive = (): ArchiveRpcPort => {
    const baseHeader = {
      number: 1,
      hash: normalizeHex32(`0x${"1".repeat(64)}`),
      parentHash: normalizeHex32(`0x${"2".repeat(64)}`),
      stateRoot: normalizeHex32(toHex(stateTrie.root)),
      timestamp: 1,
    };
    const headerFor = (selector: BlockSelector) => {
      if (selector === "finalized" || selector === "latest") {
        return { ...baseHeader, number: Math.max(baseHeader.number, 21_000_000) };
      }
      return { ...baseHeader, number: selector };
    };
    return {
      getBlockHeader: async (selector) => headerFor(selector),
      getAccount: async (address) => {
        const normalized = normalizeAddress(address);
        const account = accounts.get(normalized);
        if (account === undefined) return undefined;
        const storageTrie = storageTries.get(normalized)!;
        const code = account.code ? fromHex(account.code) : new Uint8Array(0);
        return {
          nonce: normalizeQuantity(account.nonce),
          balanceWei: normalizeQuantity(account.balance),
          codeHash: normalizeHex32(toHex(code.length === 0 ? EMPTY_HASH : keccak_256(code))),
          storageRoot: normalizeHex32(toHex(storageTrie.root)),
        };
      },
      getCode: async (address) => {
        const account = accounts.get(normalizeAddress(address));
        return account?.code ? normalizeQuantity(account.code) : "0x";
      },
      getStorageAt: async (address, slot) => {
        const account = accounts.get(normalizeAddress(address));
        if (account === undefined) return normalizeHex32(`0x${"0".repeat(64)}`);
        const normalizedSlot = normalizeSlot(slot);
        const value = account.storage.get(normalizedSlot) ?? account.storage.get(slot) ?? "0x0";
        return normalizeHex32(value);
      },
      getProof: async (address, slots) => proofFor(normalizeAddress(address), slots.map(normalizeSlot)),
    };
  };

  return {
    stateRoot: normalizeHex32(toHex(stateTrie.root)),
    proofFor,
    absenceProofFor,
    archive,
  };
}

function fakeArchiveDependentDraft(): ChainEnvironmentRecord {
  const draft = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  return {
    ...draft,
    capabilityEnvelope: {
      ...draft.capabilityEnvelope,
      egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
    },
    determinismControls: {
      ...draft.determinismControls,
      resetMechanism: "fresh-process",
    },
    verificationContract: {
      ...draft.verificationContract,
      closureCheckRequired: true,
    },
    stateMaterialization: {
      ...draft.stateMaterialization,
      initialStateCommitment: PROVISIONAL_COMMITMENT,
    },
  };
}

/** Stable extraction request for kit and state tests. */
export function fakeExtractionRequest(): ExtractionRequest {
  const draft = fakeArchiveDependentDraft();
  return {
    draft,
    anchorBlockNumber: draft.sourceAnchor?.blockNumber ?? 1,
    fidelityClass: "anchored-subset",
    sourceAddresses: [FAKE_POOL],
    fixtureDeclarations: [],
    finalityPolicy: "finalized",
  };
}

/** The fake world's state artifact for coverage tests: pool (proven) and actor (fixture). */
export function fakeStateArtifact(stateRoot?: Hex32): StateArtifact {
  return {
    schemaVersion: STATE_ARTIFACT_SCHEMA_VERSION,
    anchor: {
      blockNumber: 1,
      blockHash: normalizeHex32(`0x${"1".repeat(64)}`),
      stateRoot: stateRoot ?? normalizeHex32(`0x${"0".repeat(64)}`),
      timestamp: 1,
    },
    accounts: [
      {
        address: FAKE_POOL,
        balance: "0x0",
        nonce: "0x1",
        code: "0x60016002",
        storage: [
          { slot: FAKE_SLOT_1, value: `0x${"0".repeat(63)}7` },
          { slot: FAKE_SLOT_2, value: `0x${"0".repeat(63)}3` },
        ],
      },
      {
        address: FAKE_ACTOR,
        balance: "0xde0b6b3a7640000",
        nonce: "0x0",
        storage: [],
      },
    ],
  };
}

export interface FakeArchiveOptions {
  /** The anchor cannot be served at all. */
  readonly anchorPruned?: boolean;
  /** After N calls, the archive starts answering the anchor header differently. */
  readonly anchorDriftsAfterCall?: number;
  /** `eth_getProof` is not offered. */
  readonly proofUnsupported?: boolean;
}

export function createFakeArchive(options: FakeArchiveOptions = {}): ArchiveRpcPort {
  const world = buildFakeTrieWorld();
  const inner = world.archive();
  let anchorHeaderReads = 0;
  return {
    async getBlockHeader(selector, signal) {
      if (options.anchorPruned) {
        throw new Error("missing trie node 0xabc (path ) state 0xdef");
      }
      const header = await inner.getBlockHeader(selector, signal);
      if (options.anchorDriftsAfterCall !== undefined && typeof selector === "number") {
        anchorHeaderReads += 1;
        if (anchorHeaderReads > options.anchorDriftsAfterCall) {
          return { ...header, stateRoot: normalizeHex32(`0x${"7".repeat(64)}`) };
        }
      }
      return header;
    },
    getAccount: (address, block, signal) => inner.getAccount(address, block, signal),
    getCode: (address, block, signal) => inner.getCode(address, block, signal),
    getStorageAt: (address, slot, block, signal) => inner.getStorageAt(address, slot, block, signal),
    async getProof(address, slots, block, signal) {
      if (options.proofUnsupported) {
        throw new Error("the method eth_getProof does not exist");
      }
      return inner.getProof(address, slots, block, signal);
    },
  };
}

export interface FakeRuntimeOptions {
  readonly observationDriftOnRun?: number;
  readonly hiddenReads?: number;
  readonly blackholeUnstable?: boolean;
  readonly divergeWithoutReads?: boolean;
  readonly dumpOmits?: readonly string[];
}

interface ReadEntry {
  readonly key: string;
  readonly value: string;
}

interface FakeRuntimeInstance extends ChainInstance {
  readonly observation: CanonicalChainObservation;
}

const HIDDEN_READ_GROUPS = [
  { address: FAKE_ORACLE, slots: [FAKE_SLOT_1] as const },
  { address: FAKE_TOKEN, slots: [FAKE_SLOT_1] as const },
] as const;

const CONFORMANCE_VERIFIER: VerifierIdentity = Object.freeze({
  id: "https://spec.jinn.network/chain-state-extraction/conformance",
  version: "0.1.0",
  digest: `sha256:${"c".repeat(64)}`,
}) as VerifierIdentity;

function readKey(kind: string, address: string, slot?: string): string {
  return slot === undefined
    ? `${kind}:${normalizeAddress(address)}`
    : `${kind}:${normalizeAddress(address)}:${normalizeSlot(slot)}`;
}

function artifactAccount(
  artifact: StateArtifact | undefined,
  address: string,
): StateArtifact["accounts"][number] | undefined {
  return artifact?.accounts.find((account) => normalizeAddress(account.address) === normalizeAddress(address));
}

function hiddenGroupSatisfied(
  artifact: StateArtifact | undefined,
  group: (typeof HIDDEN_READ_GROUPS)[number],
): boolean {
  const account = artifactAccount(artifact, group.address);
  if (account === undefined) return false;
  return group.slots.every((slot) => account.storage.some(
    (entry) => normalizeSlot(entry.slot) === normalizeSlot(slot),
  ));
}

function hiddenReadsRemaining(
  options: FakeRuntimeOptions,
  artifact: StateArtifact | undefined,
): number {
  if (options.hiddenReads === undefined || options.hiddenReads === 0) return 0;

  if (options.hiddenReads === Infinity) {
    return 1;
  }

  const limit = Math.min(options.hiddenReads, HIDDEN_READ_GROUPS.length);
  for (let index = 0; index < limit; index += 1) {
    const group = HIDDEN_READ_GROUPS[index];
    if (group !== undefined && !hiddenGroupSatisfied(artifact, group)) {
      return 1;
    }
  }
  return 0;
}

function appendSyntheticHiddenReads(
  log: ReadEntry[],
  options: FakeRuntimeOptions,
  remaining: number,
): void {
  if (options.hiddenReads !== Infinity || remaining <= 0) return;
  for (let index = 0; index < remaining; index += 1) {
    log.push({ key: `synthetic:${HIDDEN_READ_GROUPS.length + index}`, value: "1" });
  }
}

async function readPoolFromBackend(
  backend: ChainStateBackend,
  blockNumber: number,
  log: ReadEntry[],
): Promise<void> {
  const pool = normalizeAddress(FAKE_POOL);
  const zero = `0x${"0".repeat(64)}`;
  await backend.getBlockHeader(blockNumber);
  const account = await backend.getAccount(pool, blockNumber);
  log.push({ key: readKey("account", pool), value: account?.nonce ?? "0x0" });
  const code = await backend.getCode(pool, blockNumber);
  log.push({ key: readKey("code", pool), value: code ?? "0x" });
  for (const slot of [FAKE_SLOT_1, FAKE_SLOT_2]) {
    const value = await backend.getStorageAt(pool, normalizeSlot(slot), blockNumber);
    log.push({ key: readKey("slot", pool, slot), value: value ?? zero });
  }
}

function readPoolFromArtifact(artifact: StateArtifact | undefined, log: ReadEntry[]): void {
  const pool = normalizeAddress(FAKE_POOL);
  const account = artifactAccount(artifact, pool);
  const zero = `0x${"0".repeat(64)}`;
  log.push({ key: readKey("account", pool), value: account?.nonce ?? "0x0" });
  log.push({ key: readKey("code", pool), value: account?.code ?? "0x" });
  for (const slot of [FAKE_SLOT_1, FAKE_SLOT_2]) {
    const entry = account?.storage.find((one) => normalizeSlot(one.slot) === normalizeSlot(slot));
    log.push({ key: readKey("slot", pool, slot), value: entry?.value ?? zero });
  }
}

function readHiddenGroup(
  group: (typeof HIDDEN_READ_GROUPS)[number],
  artifact: StateArtifact | undefined,
  log: ReadEntry[],
): void {
  const address = normalizeAddress(group.address);
  const account = artifactAccount(artifact, address);
  const zero = `0x${"0".repeat(64)}`;
  log.push({ key: readKey("account", address), value: account?.nonce ?? "0x0" });
  log.push({ key: readKey("code", address), value: account?.code ?? "0x" });
  for (const slot of group.slots) {
    const entry = account?.storage.find((one) => normalizeSlot(one.slot) === normalizeSlot(slot));
    log.push({ key: readKey("slot", address, slot), value: entry?.value ?? zero });
  }
}

async function readUnsatisfiedHiddenGroupsFromBackend(
  backend: ChainStateBackend,
  blockNumber: number,
  log: ReadEntry[],
  options: FakeRuntimeOptions,
  artifact: StateArtifact | undefined,
): Promise<void> {
  const zero = `0x${"0".repeat(64)}`;
  let remaining = hiddenReadsRemaining(options, artifact);
  for (const group of HIDDEN_READ_GROUPS) {
    if (remaining <= 0) break;
    if (!hiddenGroupSatisfied(artifact, group)) {
      const address = normalizeAddress(group.address);
      const account = await backend.getAccount(address, blockNumber);
      log.push({ key: readKey("account", address), value: account?.nonce ?? "0x0" });
      const code = await backend.getCode(address, blockNumber);
      log.push({ key: readKey("code", address), value: code ?? "0x" });
      for (const slot of group.slots) {
        const value = await backend.getStorageAt(address, normalizeSlot(slot), blockNumber);
        log.push({ key: readKey("slot", address, slot), value: value ?? zero });
      }
      remaining -= 1;
    }
  }
  appendSyntheticHiddenReads(log, options, remaining);
}

function readUnsatisfiedHiddenGroupsFromArtifact(
  log: ReadEntry[],
  artifact: StateArtifact | undefined,
  options: FakeRuntimeOptions,
): void {
  let remaining = hiddenReadsRemaining(options, artifact);
  for (const group of HIDDEN_READ_GROUPS) {
    if (remaining <= 0) break;
    if (!hiddenGroupSatisfied(artifact, group)) {
      readHiddenGroup(group, artifact, log);
      remaining -= 1;
    }
  }
  appendSyntheticHiddenReads(log, options, remaining);
}

function loadStateArtifactFromRequest(request: MaterializationRequest): StateArtifact | undefined {
  const descriptor = request.record.stateMaterialization.stateArtifact;
  if (descriptor === undefined) return undefined;
  const digest = fromDigestSet(descriptor.descriptor.digest as DigestSet);
  const bytes = request.resources.byDigest.get(digest);
  if (bytes === undefined) return undefined;
  return parseStateArtifact(bytes);
}

function commitmentFor(request: MaterializationRequest): `0x${string}` {
  const declared = request.record.stateMaterialization.initialStateCommitment;
  const sealed = request.stateBackend === undefined;
  if (sealed && declared === PROVISIONAL_COMMITMENT) {
    return FAKE_SEALED_COMMITMENT;
  }
  return declared as `0x${string}`;
}

const SEALED_BOUNDARY_PROBE = {
  id: "out-of-slice-read-is-empty",
  receiptStatus: "not-executed" as const,
  gasUsed: "0",
  logs: [],
  returnData: "0x",
  expectedErrorClass: "empty-account" as const,
  observedErrorClass: "empty-account" as const,
};

function observationFromReadLog(
  readLog: readonly ReadEntry[],
  world: ReturnType<typeof buildFakeTrieWorld>,
  finalStateCommitment: `0x${string}` = FAKE_SEALED_COMMITMENT,
): CanonicalChainObservation {
  const sorted = [...readLog].sort((left, right) => compareCodeUnitStrings(left.key, right.key));
  const fingerprint = recordDigest(canonicalJsonBytes({ reads: sorted }));
  return buildCanonicalChainObservation({
    schema: CHAIN_OBSERVATION_SCHEMA_ID,
    probes: [SEALED_BOUNDARY_PROBE],
    touchedState: [],
    stateReads: [],
    traceProjectionDigest: fingerprint,
    finalStateCommitment,
    blocks: [{
      number: "1",
      hash: `0x${"1".repeat(64)}`,
      stateRoot: world.stateRoot,
      timestamp: "1",
    }],
  });
}

function buildFakeMaterializationReport(
  record: ChainEnvironmentRecord,
  networkPolicy: NetworkPolicy,
  loadedResources: readonly `sha256:${string}`[],
  postFixtureCommitment: `0x${string}`,
): MaterializationReport {
  const controls = record.determinismControls;
  const entryCounts = record.stateMaterialization.stateArtifact?.entryCounts ?? {
    accounts: 0,
    codeEntries: 0,
    storageSlots: 0,
  };
  return {
    runtimeIdentity: {
      imageManifestDigest: record.runtime.image.manifestDigest as `sha256:${string}`,
      platform: record.runtime.image.platform,
      reportedVersion: record.runtime.version,
      binaryDigest: record.runtime.binary.digest as `sha256:${string}`,
      evmConfigurationDigest: record.runtime.binary.digest as `sha256:${string}`,
      chainId: record.runtime.evm.sandboxChainId,
      appliedControls: {
        miningMode: controls.miningMode,
        orderingPolicy: controls.orderingPolicy,
        resetMechanism: controls.resetMechanism,
      },
      unsupportedControls: [],
    },
    artifactEntries: {
      accounts: Array.from({ length: entryCounts.accounts }, () => normalizeAddress(FAKE_POOL)),
      codeEntries: Array.from({ length: entryCounts.codeEntries }, () => normalizeAddress(FAKE_POOL)),
      storageSlots: Array.from({ length: entryCounts.storageSlots }, () => ({
        address: normalizeAddress(FAKE_POOL),
        slot: normalizeSlot(FAKE_SLOT_1),
      })),
    },
    postFixtureCommitment,
    loadedResources: [...loadedResources],
    isolation: {
      networkPolicy,
      egressAttempts: networkPolicy.forkBackend === "present"
        ? [{ target: "https://archive.example/rpc", outcome: "refused" as const }]
        : [],
      forbiddenProbes: [],
      exposedSignerAccounts: record.fixtures.accounts
        .filter((account) => account.role === "agent")
        .map((account) => account.address),
      ceilingChecks: [
        { name: "maxTransactions", enforced: true },
        { name: "maxAggregateGas", enforced: true },
        { name: "maxExecutionDurationMs", enforced: true },
      ],
    },
    cost: { wallSeconds: 0 },
  };
}

let blackholeRunCounter = 0;

export function createFakeChainRuntime(
  options: FakeRuntimeOptions = {},
): ExtractionDeps["runtime"] {
  const world = buildFakeTrieWorld();
  return {
    materializer: {
      async materialize(request: MaterializationRequest) {
        if (request.networkPolicy.forkBackend === "absent" && request.stateBackend !== undefined) {
          throw new Error("a sealed materialization must have no state backend");
        }
        const blockNumber = request.record.sourceAnchor?.blockNumber ?? 1;
        const artifact = loadStateArtifactFromRequest(request);
        const log: ReadEntry[] = [];
        if (request.stateBackend !== undefined) {
          await readPoolFromBackend(request.stateBackend, blockNumber, log);
          if (artifact !== undefined) {
            await readUnsatisfiedHiddenGroupsFromBackend(
              request.stateBackend,
              blockNumber,
              log,
              options,
              artifact,
            );
          }
        } else {
          readPoolFromArtifact(artifact, log);
          readUnsatisfiedHiddenGroupsFromArtifact(log, artifact, options);
        }
        const postFixtureCommitment = commitmentFor(request);
        let observation = observationFromReadLog(log, world);
        if (options.divergeWithoutReads === true && request.stateBackend === undefined) {
          observation = observationFromReadLog(log, world, `0x${"d".repeat(64)}`);
        }
        if (options.blackholeUnstable === true && request.stateBackend === undefined) {
          blackholeRunCounter += 1;
          if (blackholeRunCounter % 2 === 0) {
            observation = observationFromReadLog(log, world, `0x${"e".repeat(64)}`);
          }
        }
        if (options.observationDriftOnRun !== undefined
          && request.stateBackend !== undefined
          && blackholeRunCounter >= options.observationDriftOnRun) {
          observation = observationFromReadLog(log, world, `0x${"b".repeat(64)}`);
        }
        const loadedResources = [...request.resources.byDigest.keys()];
        const instance: FakeRuntimeInstance = {
          instanceId: request.instanceId,
          rpcEndpoint: "http://127.0.0.1:0",
          report: buildFakeMaterializationReport(
            request.record,
            request.networkPolicy,
            loadedResources,
            postFixtureCommitment,
          ),
          observation,
          async stop() {},
        };
        return instance;
      },
      async reset(instance: ChainInstance) {
        return instance.report!.postFixtureCommitment;
      },
    },
    probes: {
      async execute(request: ProbeExecutionRequest) {
        const observation = (request.instance as FakeRuntimeInstance).observation;
        return {
          observation,
          observationDigest: chainObservationDigest(observation),
          timedOut: false,
          cost: { wallSeconds: 0 },
        };
      },
    },
  } as unknown as ExtractionDeps["runtime"];
}

export function createFakeStateDumpPort(
  options: Pick<FakeRuntimeOptions, "dumpOmits"> = {},
): StateDumpPort {
  const omitSet = new Set(options.dumpOmits ?? []);
  return {
    async dump() {
      const artifact = fakeStateArtifact(buildFakeTrieWorld().stateRoot);
      const accounts: Record<string, {
        balance: string;
        nonce: string;
        code?: string;
        storage?: Record<string, string>;
      }> = {};
      for (const account of artifact.accounts) {
        const storage: Record<string, string> = {};
        for (const entry of account.storage) {
          const omitKey = `${account.address}/${entry.slot}`;
          if (!omitSet.has(omitKey)) {
            storage[entry.slot] = entry.value;
          }
        }
        accounts[account.address] = {
          balance: account.balance,
          nonce: account.nonce,
          ...(account.code === undefined ? {} : { code: account.code }),
          storage,
        };
      }
      return { accounts };
    },
  };
}

export interface InMemoryArtifactStore extends ArtifactStore {
  readonly artifacts: ReadonlyMap<Sha256Digest, Uint8Array>;
}

function conformanceArtifactNames(record: ChainEnvironmentRecord): string[] {
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  if (record.stateMaterialization.sourceProofManifest !== undefined) {
    names.push("source-proof-manifest");
  }
  if (record.stateMaterialization.fixtureCoverage?.manifest !== undefined) {
    names.push("fixture-coverage-manifest");
  }
  if (record.sourceAnchor?.headerProof !== undefined) {
    names.push("header-proof");
  }
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

export function createInMemoryArtifactStore(
  options?: { readonly missing?: readonly Sha256Digest[] },
): InMemoryArtifactStore {
  const { conformanceArtifactBytes } = require(
    "../../chain-verification/dist/conformance-records.js",
  ) as { conformanceArtifactBytes: (name: string) => Uint8Array };
  const record = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const byDigest = new Map<string, Uint8Array>();
  for (const name of conformanceArtifactNames(record)) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  const stored = new Map<Sha256Digest, Uint8Array>();
  const missing = new Set(options?.missing ?? []);
  return {
    artifacts: stored,
    async getArtifact(descriptor) {
      const digest = fromDigestSet(descriptor.digest as DigestSet);
      if (missing.has(digest)) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      const bytes = byDigest.get(digest) ?? stored.get(digest);
      if (bytes === undefined) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      return bytes;
    },
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      stored.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

export function createFixedClock(
  startedAt = "2026-07-31T09:00:00.000Z",
  endedAt = "2026-07-31T09:04:00.000Z",
): Clock {
  const instants = [new Date(startedAt), new Date(endedAt)];
  let index = 0;
  return {
    now() {
      const instant = instants[Math.min(index, instants.length - 1)]!;
      index += 1;
      return instant;
    },
  };
}

function fakeReplayer(): ScriptReplayer {
  return {
    async replay() {
      return {
        status: "replayed",
        observation: {},
        observationDigest: `sha256:${"f".repeat(64)}`,
        reportedValues: {},
      };
    },
  };
}

export interface FakeExtractionDepsOptions {
  readonly signer: DsseSigner;
  readonly archive?: ArchiveRpcPort;
  readonly runtime?: ExtractionDeps["runtime"];
  readonly stateDump?: StateDumpPort;
  readonly verifier?: VerifierIdentity;
}

export function createFakeExtractionDeps(options: FakeExtractionDepsOptions): ExtractionDeps {
  return {
    archive: options.archive ?? createFakeArchive(),
    forkBackend: { kind: "injected-port" },
    runtime: options.runtime ?? createFakeChainRuntime(),
    replayer: fakeReplayer(),
    artifactStore: createInMemoryArtifactStore(),
    signer: options.signer,
    clock: createFixedClock(),
    verifier: options.verifier ?? CONFORMANCE_VERIFIER,
    ...(options.stateDump === undefined ? {} : { stateDump: options.stateDump }),
  };
}

export async function fakeBaseline(
  deps: ExtractionDeps,
  request: ExtractionRequest = fakeExtractionRequest(),
): Promise<ConnectedBaseline> {
  const archive = createBudgetedArchivePort(deps.archive, {
    maxCalls: request.budget?.maxCalls ?? DEFAULT_ARCHIVE_BUDGET.maxCalls,
    maxBytes: request.budget?.maxBytes ?? DEFAULT_ARCHIVE_BUDGET.maxBytes,
  });
  const anchorOutcome = await captureAnchor(archive, {
    blockNumber: request.anchorBlockNumber,
  }, deps.clock);
  if (!anchorOutcome.ok) {
    throw new Error(anchorOutcome.detail);
  }
  const baselineOutcome = await establishBaseline(deps, request, archive, anchorOutcome.value);
  if (!baselineOutcome.ok) {
    throw new Error(baselineOutcome.detail);
  }
  return baselineOutcome.value;
}

export interface ChainExtractionConformanceOptions {
  readonly signer: DsseSigner;
}

function conformanceRequest(): ExtractionRequest {
  return {
    ...fakeExtractionRequest(),
    fixtureDeclarations: [{ address: FAKE_ACTOR, kind: "account" }],
    budget: { maxCalls: 500, maxBytes: 5_000_000 },
  };
}

export function describeChainExtractionConformance(
  options: ChainExtractionConformanceOptions,
): void {
  const { describe, expect, it } = globalThis as unknown as typeof import("vitest");

  describe("chain extraction conformance", () => {
    it("converges on the first pass", async () => {
      blackholeRunCounter = 0;
      const deps = createFakeExtractionDeps({
        signer: options.signer,
        runtime: createFakeChainRuntime({ hiddenReads: 0 }),
      });
      const extracted = await extractEnvironment(deps, conformanceRequest());
      expect(extracted.status).toBe("candidate");
      if (extracted.status !== "candidate") return;

      const result = await widenAndReverify(deps, {
        candidate: extracted.candidate,
        request: conformanceRequest(),
      });
      expect(result.status).toBe("converged");
      if (result.status !== "converged") return;
      expect(result.rounds).toHaveLength(1);
      expect(result.rounds[0]!.matchedBaseline).toBe(true);
      expect(result.attestation.outcome).toBe("closed-reproducible");
    });

    it("converges after two widenings", async () => {
      blackholeRunCounter = 0;
      const deps = createFakeExtractionDeps({
        signer: options.signer,
        runtime: createFakeChainRuntime({ hiddenReads: 2 }),
      });
      const extracted = await extractEnvironment(deps, conformanceRequest());
      expect(extracted.status).toBe("candidate");
      if (extracted.status !== "candidate") return;

      const result = await widenAndReverify(deps, {
        candidate: extracted.candidate,
        request: conformanceRequest(),
      }, { maxWidenings: 2 });
      expect(result.status).toBe("converged");
      if (result.status !== "converged") return;
      expect(result.rounds).toHaveLength(3);
      expect(result.rounds[0]!.matchedBaseline).toBe(false);
      expect(result.rounds[1]!.matchedBaseline).toBe(false);
      expect(result.rounds[2]!.matchedBaseline).toBe(true);
      const digests = result.rounds.map((round) => round.recordDigest);
      expect(new Set(digests).size).toBe(3);
      expect(stateArtifactEntryCounts(result.candidate.artifact).accounts).toBeGreaterThan(1);
      expect(keySetIsEmpty(stateArtifactKeySet(result.candidate.artifact))).toBe(false);
    });

    it("never converges, and terminates under the bound", async () => {
      blackholeRunCounter = 0;
      const deps = createFakeExtractionDeps({
        signer: options.signer,
        runtime: createFakeChainRuntime({ hiddenReads: Infinity }),
      });
      const extracted = await extractEnvironment(deps, conformanceRequest());
      expect(extracted.status).toBe("candidate");
      if (extracted.status !== "candidate") return;

      const result = await widenAndReverify(deps, {
        candidate: extracted.candidate,
        request: conformanceRequest(),
      }, { maxWidenings: 2 });
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.reason).toBe("widen-bound-exhausted");
      expect(result.archiveUsage.calls).toBeLessThan(result.archiveUsage.limits.maxCalls);
      expect(result.archiveUsage.bytes).toBeLessThan(result.archiveUsage.limits.maxBytes);
    });

    it("refuses an archive that disagrees with itself between calls", async () => {
      blackholeRunCounter = 0;
      const deps = createFakeExtractionDeps({
        signer: options.signer,
        archive: createFakeArchive({ anchorDriftsAfterCall: 1 }),
        runtime: createFakeChainRuntime(),
      });
      const result = await extractEnvironment(deps, conformanceRequest());
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.reason).toBe("archive-self-disagreement");
      expect(result.disposition).toBe("provider-disagreement");
    });

    it("is not fooled by a dump that silently omits state the run touched", async () => {
      blackholeRunCounter = 0;
      const omitKey = `${FAKE_POOL}/${FAKE_SLOT_2}`;
      const depsWithDump = createFakeExtractionDeps({
        signer: options.signer,
        runtime: createFakeChainRuntime({ hiddenReads: 0 }),
        stateDump: createFakeStateDumpPort({ dumpOmits: [omitKey] }),
      });
      const withDump = await extractEnvironment(depsWithDump, conformanceRequest());
      expect(withDump.status).toBe("candidate");
      if (withDump.status !== "candidate") return;
      expect(withDump.dumpOmissions.storage).toEqual([
        { address: FAKE_POOL, slots: [FAKE_SLOT_2] },
      ]);
      const artifact = withDump.candidate.artifact.accounts.find(
        (account) => normalizeAddress(account.address) === normalizeAddress(FAKE_POOL),
      );
      expect(artifact?.storage.some((entry) => normalizeSlot(entry.slot) === normalizeSlot(FAKE_SLOT_2))).toBe(true);

      const convergedWithDump = await widenAndReverify(depsWithDump, {
        candidate: withDump.candidate,
        request: conformanceRequest(),
      });
      expect(convergedWithDump.status).toBe("converged");
      if (convergedWithDump.status !== "converged") return;

      const depsWithoutDump = createFakeExtractionDeps({
        signer: options.signer,
        runtime: createFakeChainRuntime({ hiddenReads: 0 }),
      });
      const withoutDump = await extractEnvironment(depsWithoutDump, conformanceRequest());
      expect(withoutDump.status).toBe("candidate");
      if (withoutDump.status !== "candidate") return;
      const convergedWithoutDump = await widenAndReverify(depsWithoutDump, {
        candidate: withoutDump.candidate,
        request: conformanceRequest(),
      });
      expect(convergedWithoutDump.status).toBe("converged");
      if (convergedWithoutDump.status !== "converged") return;
      expect(stateArtifactDigest(serializeStateArtifact(convergedWithDump.candidate.artifact))).toBe(
        stateArtifactDigest(serializeStateArtifact(convergedWithoutDump.candidate.artifact)),
      );
    });
  });
}
