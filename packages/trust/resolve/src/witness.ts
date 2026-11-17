// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, parseExactDsseEnvelope } from "@jinn-network/trust-core";
import type { DsseChainVerifier, Eip1271Witness, WitnessResult, WitnessVerifier } from "@jinn-network/trust-core";
import { isAddress, isHex, size } from "viem";

import { ERC1271_IS_VALID_SIGNATURE_ABI, ERC1271_MAGIC_VALUE } from "./abis.js";
import { isReadAnswered } from "./contract-answer.js";

// ---------------------------------------------------------------------------
// §7.2a's 1271 witness: "A witness is not bare data. It is a DSSE-signed
// statement by a witness identity -- {chainId, blockNumber, blockHash,
// isValidSignature result, verifier}." This module decodes that statement
// and content-matches it against the caller-supplied outer `Eip1271Witness`
// fields; when the witness's own author (`verifier`, an Agent IRI) is not
// among the caller's policy-accepted verifiers, it falls back to
// re-executing `isValidSignature` at the witnessed block against an
// injected archive-RPC client -- a real cost, named in the design, and the
// reason witnesses from policy-accepted verifiers are the practical path.
//
// A statement's `verifier` is whatever its writer put there, so naming an
// accepted author is not that author's word. Its word is a statement one of
// its keys signed: the caller says which keys stand for which author
// (`verifierKeys`) and supplies `trust-core`'s DSSE verifier port
// (`dsseVerifier`), which this module asks who signed the envelope. The
// signed bytes are the DSSE pre-authentication encoding of the envelope's
// `payloadType` and payload, and the payload must be the statement's own
// RFC 8785 form (`canonicalJsonBytes`, what `sealSignedRecord` writes) inside
// an envelope `sealDsseEnvelope` wrote byte for byte, so every reader reads
// one statement from them: a repeated member or a second payload is refused,
// not resolved by one parser's rule. A statement no key of its accepted
// author signed has no accepted author, and goes to the archive like any
// other.
// ---------------------------------------------------------------------------

/** The decoded shape of a witness statement's DSSE payload (§7.2a). Carries
 * the original EIP-1271 check the witness performed -- the Safe address,
 * the signed hash, the signature bytes, and the returned magic value --
 * alongside the anchoring facts also present on the outer `Eip1271Witness`. */
export interface WitnessStatementPayload {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly verifier: string;
  readonly safe: string;
  readonly hash: string;
  readonly signature: string;
  readonly result: string;
}

/** Structural injection seam for hermetic tests -- a real host wires this
 * to an archive-capable viem client. `getChainId` is the chain the client's
 * node serves, as viem's `PublicClient.getChainId` reports it. */
export interface ArchiveReadClient {
  getChainId: () => Promise<number>;
  readContract: (args: {
    address: `0x${string}`;
    abi: typeof ERC1271_IS_VALID_SIGNATURE_ABI;
    functionName: "isValidSignature";
    args: readonly [`0x${string}`, `0x${string}`];
    blockNumber: bigint;
  }) => Promise<unknown>;
}

export interface CreateWitnessVerifierOptions {
  /** Agent IRIs the deployment's trust policy currently accepts as
   * witness-verifiers (the caller's own §9 `witness-verifier`/
   * `verifier-agent` policy-purpose lookup -- `trust-resolve` never makes
   * this decision itself). */
  readonly acceptedVerifiers?: readonly string[];
  /** The working keys (`did:key`) that stand for each accepted verifier's
   * Agent IRI, as the caller established them (for example by verifying their
   * binding to that IRI). A statement naming an accepted verifier is that
   * verifier's word only when one of these keys signed it. */
  readonly verifierKeys?: ReadonlyMap<string, readonly string[]>;
  /** `trust-core`'s DSSE verifier port, asked which keys signed a witness
   * envelope. Without it no statement is believed on its author's word. */
  readonly dsseVerifier?: DsseChainVerifier;
  /** Archive re-execution fallback (§7.2a). Omit to fail closed when the
   * witness author is not policy-accepted, or did not sign the statement. A
   * statement is put only to a client serving the statement's chain. A read
   * no node took throws, as does a client that cannot say which chain it
   * serves: that is an outage, and says nothing about the witness. Anything a
   * node said about the block and contract the statement chose is an answer. */
  readonly archiveClient?: ArchiveReadClient;
}

const UNREADABLE_STATEMENT = "witness envelope does not decode to a signed statement.";

/** The statement a witness envelope carries, or why none can be read. The
 * envelope must be the bytes `sealDsseEnvelope` writes and its payload the
 * statement's own RFC 8785 form, so no reader of these bytes reads another
 * statement from them than the one their signer signed. */
function parseWitnessPayload(envelopeBytes: Uint8Array): WitnessStatementPayload | string {
  let payloadBytes: Uint8Array;
  let payload: unknown;
  try {
    ({ payloadBytes } = parseExactDsseEnvelope(envelopeBytes));
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return UNREADABLE_STATEMENT;
  }
  if (typeof payload !== "object" || payload === null) return UNREADABLE_STATEMENT;
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate["chainId"] !== "number"
    || typeof candidate["blockNumber"] !== "number"
    || typeof candidate["blockHash"] !== "string"
    || typeof candidate["verifier"] !== "string"
    || typeof candidate["safe"] !== "string"
    || typeof candidate["hash"] !== "string"
    || typeof candidate["signature"] !== "string"
    || typeof candidate["result"] !== "string"
  ) {
    return UNREADABLE_STATEMENT;
  }
  if (!isCanonicalForm(payloadBytes, payload)) {
    return "witness statement is not its own RFC 8785 serialization.";
  }
  return candidate as unknown as WitnessStatementPayload;
}

/** Whether `bytes` are `value`'s RFC 8785 form. A repeated member, which
 * parsers resolve differently, never is. */
function isCanonicalForm(bytes: Uint8Array, value: unknown): boolean {
  try {
    const canonical = canonicalJsonBytes(value);
    return canonical.length === bytes.length && canonical.every((byte, index) => byte === bytes[index]);
  } catch {
    return false;
  }
}

/** Whether one of `keys` signed the envelope. What the port cannot read was
 * signed by no one. */
function signedByOneOf(
  dsseVerifier: DsseChainVerifier | undefined,
  envelopeBytes: Uint8Array,
  keys: readonly string[] | undefined,
): boolean {
  if (dsseVerifier === undefined || keys === undefined) return false;
  try {
    return dsseVerifier(envelopeBytes).validSignerKeyids.some((keyid) => keys.includes(keyid));
  } catch {
    return false;
  }
}

function contentMatches(payload: WitnessStatementPayload, witness: Eip1271Witness): boolean {
  return payload.chainId === witness.chainId
    && payload.blockNumber === witness.blockNumber
    && payload.blockHash === witness.blockHash
    && payload.verifier === witness.verifier;
}

/** Far past any real Safe signature, and small enough for a node to take. */
const MAX_REEXECUTED_SIGNATURE_BYTES = 1_048_576;

/** Whether a statement can be put to the archive at all. A read that fails is an
 * outage, so what a store holds must be turned away before one is made. */
function canBeReexecuted(payload: WitnessStatementPayload): boolean {
  return isAddress(payload.safe)
    && isHex(payload.hash) && size(payload.hash) === 32
    && isHex(payload.signature) && size(payload.signature) <= MAX_REEXECUTED_SIGNATURE_BYTES
    && Number.isSafeInteger(payload.blockNumber) && payload.blockNumber >= 0;
}

/**
 * Builds a `WitnessVerifier` (§7.2a): checks the witness envelope decodes
 * to a statement in its exact form, and that its content matches the outer
 * `Eip1271Witness` claim (the lifted-witness defense); if the witness's own
 * author is policy-accepted and one of the keys that stand for it signed the
 * statement, the witness-attested `isValidSignature` result is trusted
 * directly. Otherwise falls back to archive re-execution on the statement's
 * chain when an `archiveClient` is configured, and fails closed when it is
 * not.
 */
export function createWitnessVerifier(options: CreateWitnessVerifierOptions = {}): WitnessVerifier {
  const acceptedVerifiers = new Set(options.acceptedVerifiers ?? []);

  return {
    async verify1271Witness(witness: Eip1271Witness): Promise<WitnessResult> {
      // A store may hold anything, and a throw from this leg reads as an outage.
      if (typeof witness !== "object" || witness === null) {
        return { verified: false, reason: "witness cannot be read." };
      }
      const payload = parseWitnessPayload(witness.envelopeBytes);
      if (typeof payload === "string") return { verified: false, reason: payload };
      if (!contentMatches(payload, witness)) {
        return {
          verified: false,
          reason: "witness statement content does not match the claimed chainId/blockNumber/blockHash/verifier.",
        };
      }

      const accepted = acceptedVerifiers.has(payload.verifier);
      if (accepted && signedByOneOf(
        options.dsseVerifier,
        witness.envelopeBytes,
        options.verifierKeys?.get(payload.verifier),
      )) {
        return payload.result === ERC1271_MAGIC_VALUE
          ? { verified: true }
          : {
            verified: false,
            reason: `witness-attested isValidSignature result "${payload.result}" is not the EIP-1271 magic value.`,
          };
      }

      if (options.archiveClient === undefined) {
        return {
          verified: false,
          reason: (accepted
            ? `witness statement is not signed by a key that stands for its author "${payload.verifier}"`
            : `witness author "${payload.verifier}" is not policy-accepted`)
            + ", and no archive client is configured for re-execution.",
        };
      }

      if (!canBeReexecuted(payload)) {
        return { verified: false, reason: "witness statement cannot be put to the archive." };
      }

      // Another chain's state says nothing about this statement.
      const servedChainId = await options.archiveClient.getChainId();
      if (servedChainId !== payload.chainId) {
        return {
          verified: false,
          reason: `archive client serves chain ${String(servedChainId)}, not the statement's chain ${payload.chainId}.`,
        };
      }

      let magicValue: unknown;
      try {
        magicValue = await options.archiveClient.readContract({
          address: payload.safe as `0x${string}`,
          abi: ERC1271_IS_VALID_SIGNATURE_ABI,
          functionName: "isValidSignature",
          args: [payload.hash as `0x${string}`, payload.signature as `0x${string}`],
          blockNumber: BigInt(witness.blockNumber),
        });
      } catch (cause) {
        if (!isReadAnswered(cause)) throw cause; // an outage, not a verdict on the witness
        return {
          verified: false,
          reason: `archive re-execution of isValidSignature failed: `
            + `${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
      return magicValue === ERC1271_MAGIC_VALUE
        ? { verified: true }
        : {
          verified: false,
          reason: `archive re-execution returned "${String(magicValue)}", not the EIP-1271 magic value.`,
        };
    },
  };
}
