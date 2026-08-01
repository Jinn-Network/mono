// SPDX-License-Identifier: Apache-2.0

// The published conformance kit. `node:fs/promises` appears here (fixture loading only) and
// is allowlisted for this file in the tree guard. Grows task by task.

import { keccak_256 } from "@noble/hashes/sha3.js";

import { normalizeAddress, normalizeHex32, normalizeQuantity, normalizeSlot, type Hex32, type HexAddress } from "./hex.js";
import type { ArchiveAccountProof, ArchiveRpcPort } from "./ports.js";
import type { RlpItem } from "./rlp.js";

export const FAKE_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_ORACLE = "0xcccccccccccccccccccccccccccccccccccccccc";
export const FAKE_TOKEN = "0xdddddddddddddddddddddddddddddddddddddddd";
export const FAKE_ACTOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const FAKE_SLOT_1 = `0x${"0".repeat(63)}1`;
export const FAKE_SLOT_2 = `0x${"0".repeat(63)}2`;

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
    const header = {
      number: 1,
      hash: normalizeHex32(`0x${"1".repeat(64)}`),
      parentHash: normalizeHex32(`0x${"2".repeat(64)}`),
      stateRoot: normalizeHex32(toHex(stateTrie.root)),
      timestamp: 1,
    };
    return {
      getBlockHeader: async () => header,
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
