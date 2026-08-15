// SPDX-License-Identifier: Apache-2.0

import { keccak_256 } from "@noble/hashes/sha3.js";

import { normalizeHex32, normalizeSlot, type Hex32 } from "./hex.js";
import type { ArchiveAccountProof } from "./ports.js";
import { decodeRlp, type RlpItem } from "./rlp.js";

export interface ProofVerdict {
  /** True when the walk terminated consistently with the claimed account state -- either
   * at the claimed value, or at a proven absence. */
  readonly account: boolean;
  readonly absent: boolean;
  readonly storage: Readonly<Record<Hex32, boolean>>;
}

function fromHex(value: string): Uint8Array {
  const body = value.startsWith("0x") ? value.slice(2) : value;
  const padded = body.length % 2 === 0 ? body : `0${body}`;
  return Uint8Array.from((padded.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)));
}

function toHex(bytes: Uint8Array): string {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nibbles(bytes: Uint8Array): number[] {
  return [...bytes].flatMap((byte) => [byte >> 4, byte & 0x0f]);
}

/** Strips a quantity to its minimal big-endian form, which is how the trie stores it. */
function minimal(value: string): Uint8Array {
  const bytes = fromHex(value);
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.slice(start);
}

type WalkResult =
  | { readonly kind: "value"; readonly value: Uint8Array }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" };

/**
 * Walks a Merkle-Patricia proof from `root` along `path`, using only the supplied nodes.
 * Every reference is resolved by hash against the node list, so a proof that omits a node
 * -- or supplies one that does not hash to the reference -- is invalid rather than
 * "probably fine".
 */
function walk(root: Uint8Array, path: number[], nodes: readonly Uint8Array[]): WalkResult {
  const byHash = new Map(nodes.map((node) => [toHex(keccak_256(node)), node]));
  let expected = root;
  let cursor = 0;
  let current: Uint8Array | undefined = byHash.get(toHex(expected));

  for (let guard = 0; guard <= nodes.length; guard += 1) {
    if (current === undefined) return { kind: "absent" };
    if (!equalBytes(keccak_256(current), expected)) return { kind: "invalid" };

    let decoded: RlpItem;
    try {
      decoded = decodeRlp(current);
    } catch {
      return { kind: "invalid" };
    }
    if (!Array.isArray(decoded)) return { kind: "invalid" };

    if (decoded.length === 17) {
      if (cursor === path.length) {
        const value = decoded[16];
        if (!(value instanceof Uint8Array)) return { kind: "invalid" };
        return value.length === 0 ? { kind: "absent" } : { kind: "value", value };
      }
      const branch = decoded[path[cursor]!];
      if (!(branch instanceof Uint8Array)) return { kind: "invalid" };
      cursor += 1;
      if (branch.length === 0) return { kind: "absent" };
      expected = branch;
      current = byHash.get(toHex(branch));
      continue;
    }

    if (decoded.length !== 2) return { kind: "invalid" };
    const [encodedPath, payload] = decoded;
    if (!(encodedPath instanceof Uint8Array) || !(payload instanceof Uint8Array)) {
      return { kind: "invalid" };
    }
    const pathNibbles = nibbles(encodedPath);
    const flag = pathNibbles[0] ?? 0;
    const odd = (flag & 1) === 1;
    const leaf = (flag & 2) === 2;
    const partial = pathNibbles.slice(odd ? 1 : 2);
    const remaining = path.slice(cursor);
    if (partial.length > remaining.length) return { kind: "absent" };
    if (!partial.every((nibble, index) => nibble === remaining[index])) return { kind: "absent" };
    cursor += partial.length;

    if (leaf) {
      return cursor === path.length
        ? { kind: "value", value: payload }
        : { kind: "absent" };
    }
    expected = payload;
    current = byHash.get(toHex(payload));
  }
  return { kind: "invalid" };
}

/**
 * Verifies one EIP-1186 response against a declared state root, offline.
 *
 * The bound is design E5's and is not widened by this function: it proves the entries
 * belong to the trie under *that root*. Whether that root is the canonical chain's root at
 * block N is a separate, declared step (`anchorAuthenticityBoundOf`).
 */
export function verifyAccountProof(proof: ArchiveAccountProof, stateRoot: string): ProofVerdict {
  const root = fromHex(normalizeHex32(stateRoot));
  const accountPath = nibbles(keccak_256(fromHex(proof.address)));
  const walked = walk(root, accountPath, proof.accountProof.map(fromHex));

  let accountOk = false;
  let absent = false;

  if (walked.kind === "absent") {
    // A proven-absent account is legitimate coverage: execution that reads an empty
    // account must be reproducible too, and "empty" is exactly what the sealed world
    // returns for it.
    absent = true;
    accountOk = minimal(proof.balance).length === 0
      && minimal(proof.nonce).length === 0;
  } else if (walked.kind === "value") {
    const decoded = decodeRlp(walked.value);
    if (Array.isArray(decoded) && decoded.length === 4) {
      const [nonce, balance, storageHash, codeHash] = decoded as Uint8Array[];
      accountOk = equalBytes(nonce!, minimal(proof.nonce))
        && equalBytes(balance!, minimal(proof.balance))
        && equalBytes(storageHash!, fromHex(normalizeHex32(proof.storageHash)))
        && equalBytes(codeHash!, fromHex(normalizeHex32(proof.codeHash)));
    }
  }

  const storage: Record<string, boolean> = {};
  for (const entry of proof.storageProof) {
    const slot = normalizeSlot(entry.key);
    if (!accountOk) {
      storage[slot] = false;
      continue;
    }
    if (absent) {
      // Every slot of an absent account is zero; a non-zero claim is a contradiction.
      storage[slot] = minimal(entry.value).length === 0;
      continue;
    }
    const slotWalk = walk(
      fromHex(normalizeHex32(proof.storageHash)),
      nibbles(keccak_256(fromHex(slot))),
      entry.proof.map(fromHex),
    );
    const claimed = minimal(entry.value);
    if (slotWalk.kind === "absent") storage[slot] = claimed.length === 0;
    else if (slotWalk.kind === "value") {
      const decoded = decodeRlp(slotWalk.value);
      storage[slot] = decoded instanceof Uint8Array && equalBytes(decoded, claimed);
    } else storage[slot] = false;
  }

  return { account: accountOk, absent, storage };
}
