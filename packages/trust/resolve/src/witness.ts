// SPDX-License-Identifier: Apache-2.0

import { parseDsseEnvelope } from "@jinn-network/trust-core";
import type { Eip1271Witness, WitnessResult, WitnessVerifier } from "@jinn-network/trust-core";
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
// Deliberately deferred, consistent with the finding recorded against
// `trust-core`'s `policy.ts` (`DsseChainVerifier`, T7): cryptographically
// verifying the witness envelope's own DSSE signature against its
// signer's `did:key` is multicodec-aware decode work not implemented
// anywhere in this tree yet. This module checks envelope well-formedness
// (decodes, carries at least one signature) and the mandatory content
// match (structural authenticity) -- not signature authenticity. Trusting
// a witness's signed content is conditioned entirely on the witness's
// Agent IRI being in the caller's policy-accepted set, exactly as the
// design assigns ("witness-verifier acceptability is a §9 policy purpose
// ... decided by the CALLER"). Flagged as a finding.
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
 * to an archive-capable viem client. */
export interface ArchiveReadClient {
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
  /** Archive re-execution fallback (§7.2a). Omit to fail closed when the
   * witness author is not policy-accepted. A read no node took throws: that is an
   * outage, and says nothing about the witness. Anything a node said about the
   * block and contract the statement chose is an answer. */
  readonly archiveClient?: ArchiveReadClient;
}

function parseWitnessPayload(envelopeBytes: Uint8Array): WitnessStatementPayload | undefined {
  let decoded;
  try {
    decoded = parseDsseEnvelope(envelopeBytes);
  } catch {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded.payloadBytes));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
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
    return undefined;
  }
  return candidate as unknown as WitnessStatementPayload;
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
 * and is signed, and that its content matches the outer `Eip1271Witness`
 * claim (the lifted-witness defense); if the witness's own author is
 * policy-accepted, the witness-attested `isValidSignature` result is
 * trusted directly. Otherwise falls back to archive re-execution when an
 * `archiveClient` is configured, and fails closed when it is not.
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
      if (payload === undefined) {
        return { verified: false, reason: "witness envelope does not decode to a signed statement." };
      }
      if (!contentMatches(payload, witness)) {
        return {
          verified: false,
          reason: "witness statement content does not match the claimed chainId/blockNumber/blockHash/verifier.",
        };
      }

      if (acceptedVerifiers.has(payload.verifier)) {
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
          reason: `witness author "${payload.verifier}" is not policy-accepted, and no archive client is `
            + "configured for re-execution.",
        };
      }

      if (!canBeReexecuted(payload)) {
        return { verified: false, reason: "witness statement cannot be put to the archive." };
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
