// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, parseDsseEnvelope, parseExactDsseEnvelope, recordDigest, verifyEnvelopeBinding } from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseChainVerifier,
  PolicyCheckInput,
  WitnessVerifier,
} from "@jinn-network/trust-core";

import { ed25519PublicKeyFromDidKey } from "./did-key.js";
import { verifyDsseSignatures } from "./dsse.js";
import type { DsseVerificationKey } from "./dsse.js";
import { defaultRecordKinds } from "./kinds/index.js";
import type { RecordKind, RecordKinds } from "./kinds/index.js";
import { documentField, readRecord } from "./record-view.js";
import type { RecordView } from "./record-view.js";
import { UNKNOWN_KIND, describeError, failed, passed, skipped } from "./results.js";
import type { CheckResult, Finding, RecordCheckId, RecordOutcome, RecordReport } from "./results.js";

export interface RecordTrustOptions {
  /** Keys for signatures whose `keyid` does not carry its own key. Consulted before the `keyid`. */
  readonly keys?: readonly DsseVerificationKey[];
  /** Without one, `trust-binding` is skipped. See `createStaticBindingResolver` for offline sets. */
  readonly bindingResolver?: BindingResolver;
  /** Needed only for a `safe` ceremony. Without one, such a binding fails its ceremony. */
  readonly witnessVerifier?: WitnessVerifier;
  /** §7.5 step 5, the deployment's trust policy for this check. */
  readonly policy?: PolicyCheckInput;
  /**
   * The evidence's effective time. Overrides what the record states about itself, which is a claim
   * by whoever signed it. Without this a kind stating no time of its own is skipped.
   */
  readonly atTime?: string;
}

export interface CheckRecordOptions {
  /** The digest these bytes were asked for by. Without one, `digest` compares nothing and says so. */
  readonly digest?: string;
  readonly kinds?: RecordKinds;
  readonly trust?: RecordTrustOptions;
}

/** Everything `checkRecordSet` reads back after checking one record. */
export interface InspectedRecord {
  readonly report: RecordReport;
  readonly view: RecordView;
  readonly kind?: RecordKind;
}

const SPEC_ORIGIN = "https://spec.jinn.network/";
const JINN_MEDIA_TYPE_PREFIX = "application/vnd.jinn.";

/** The type identifier the bytes state, if any: "Type identifiers are URLs under https://spec.jinn.network/". */
function namedType(view: RecordView): string | undefined {
  for (const field of ["kind", "protocol", "predicateType"]) {
    const value = documentField(view, field);
    if (typeof value === "string" && value.startsWith(SPEC_ORIGIN)) return value;
  }
  return view.payloadType?.startsWith(JINN_MEDIA_TYPE_PREFIX) === true ? view.payloadType : undefined;
}

function identifies(kind: RecordKind, view: RecordView): boolean {
  try {
    return kind.identify(view);
  } catch {
    return false;
  }
}

function checkDigest(digest: string, claimed: string | undefined): CheckResult<"digest"> {
  if (claimed === undefined) {
    return skipped("digest", "no-claimed-digest", `No digest was claimed for these bytes to be compared with; they hash to ${digest}.`);
  }
  return claimed === digest
    ? passed("digest")
    : failed("digest", [{ code: "content-corruption", detail: `Claimed ${claimed}, but these bytes hash to ${digest}.` }]);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Whether `bytes` are RFC 8785 of their own parse. Never re-canonicalizes a value it was handed. */
function canonicalFinding(bytes: Uint8Array, parsed: unknown): Finding | undefined {
  if (parsed === undefined) return { code: "not-json", detail: "These bytes are not JSON." };
  try {
    return bytesEqual(canonicalJsonBytes(parsed), bytes)
      ? undefined
      : { code: "not-canonical", detail: "These bytes are not the RFC 8785 encoding of their own parse." };
  } catch (cause) {
    return { code: "not-i-json", detail: `These bytes have no sealed encoding: ${describeError(cause)}` };
  }
}

function exactEnvelopeFinding(bytes: Uint8Array): Finding | undefined {
  try {
    parseExactDsseEnvelope(bytes);
    return undefined;
  } catch (cause) {
    return { code: "not-canonical", detail: describeError(cause) };
  }
}

function checkEncoding(view: RecordView, kind: RecordKind | undefined, named: string | undefined): CheckResult<"encoding"> {
  if (kind?.encodingExemption !== undefined) return skipped("encoding", "encoding-not-required", kind.encodingExemption);
  const finding = kind !== undefined && view.signatures !== undefined
    ? exactEnvelopeFinding(view.bytes) ?? canonicalFinding(view.documentBytes, view.document)
    : canonicalFinding(view.bytes, view.parsed);
  if (finding === undefined) return passed("encoding");
  if (kind === undefined && named === undefined) {
    return skipped("encoding", "not-a-record", `${finding.detail} They name no type, so nothing says they are a sealed record: they may be an artifact named by digest.`);
  }
  return failed("encoding", [finding]);
}

function checkSchema(view: RecordView, kind: RecordKind | undefined, ambiguous: boolean): CheckResult<"schema"> {
  if (kind === undefined) return skipped("schema", "unknown-kind", "No registered kind claims this record, so no schema was applied.");
  if (ambiguous) return failed("schema", [{ code: "ambiguous-kind", detail: "More than one registered kind claims this record." }]);
  const findings = kind.validate(view);
  return findings.length === 0 ? passed("schema") : failed("schema", findings);
}

function usableKey(keyid: string, supplied: readonly DsseVerificationKey[]): DsseVerificationKey | undefined {
  const given = supplied.find(({ keyId }) => keyId === keyid);
  if (given !== undefined) return given.publicKey.asymmetricKeyType === "ed25519" ? given : undefined;
  const publicKey = ed25519PublicKeyFromDidKey(keyid);
  return publicKey === undefined ? undefined : { keyId: keyid, publicKey };
}

interface SignatureOutcome {
  readonly result: CheckResult<"signature">;
  readonly verifiedSigners: readonly string[];
}

function checkSignature(view: RecordView, kind: RecordKind | undefined, trust: RecordTrustOptions | undefined): SignatureOutcome {
  const outcome = (result: CheckResult<"signature">, verifiedSigners: readonly string[] = []) => ({ result, verifiedSigners });
  if (kind === undefined) return outcome(skipped("signature", "unknown-kind", "No registered kind says who signs this record, so no signature was verified."));
  if (view.signatures === undefined) {
    return outcome(kind.unsignedBecause === undefined
      ? failed("signature", [{ code: "not-signed", detail: "This kind is a DSSE envelope, and these bytes are not a well-formed one." }])
      : skipped("signature", "unsigned-record", kind.unsignedBecause));
  }

  const usable: DsseVerificationKey[] = [];
  const unverifiable: Finding[] = [];
  for (const { keyid } of view.signatures) {
    const key = keyid === undefined ? undefined : usableKey(keyid, trust?.keys ?? []);
    if (key !== undefined) usable.push(key);
    else {
      unverifiable.push({
        code: "no-verification-key",
        ...(keyid === undefined ? {} : { subject: keyid }),
        detail: keyid === undefined
          ? "A signature carries no keyid, so no key could be chosen for it."
          : `No Ed25519 key is known for keyid ${keyid}: it does not decode to one and none was supplied.`,
      });
    }
  }
  const missing = (kind.requiredSigners?.(view) ?? [])
    .filter((signer) => !view.signatures!.some(({ keyid }) => keyid === signer))
    .map((signer): Finding => ({ code: "required-signer-missing", subject: signer, detail: `This kind must be signed by ${signer}, and no signature names it.` }));
  if (usable.length === 0) {
    return outcome(missing.length > 0
      ? failed("signature", [...missing, ...unverifiable])
      : { id: "signature", status: "skipped", findings: unverifiable });
  }

  const { validSignerKeyids } = verifyDsseSignatures(view.bytes, usable, {
    allowRespelledEnvelope: kind.anyEnvelopeSpelling === true,
  });
  const invalid = usable
    .filter(({ keyId }) => !validSignerKeyids.includes(keyId))
    .map(({ keyId }): Finding => ({ code: "signature-invalid", subject: keyId, detail: `The signature under ${keyId} does not verify.` }));
  const refused = [...invalid, ...missing];
  return outcome(
    refused.length > 0 ? failed("signature", [...refused, ...unverifiable]) : passed("signature", unverifiable),
    validSignerKeyids,
  );
}

/** A verifier for `verifyEnvelopeBinding`, which also calls it on consent and revocation envelopes. */
function bindingDsseVerifier(kind: RecordKind, trust: RecordTrustOptions): DsseChainVerifier {
  return (envelopeBytes) => {
    let keyids: readonly (string | undefined)[];
    try {
      keyids = parseDsseEnvelope(envelopeBytes).signatures.map(({ keyid }) => keyid);
    } catch {
      return { validSignerKeyids: [] };
    }
    const keys = keyids.flatMap((keyid) => {
      const key = keyid === undefined ? undefined : usableKey(keyid, trust.keys ?? []);
      return key === undefined ? [] : [key];
    });
    return verifyDsseSignatures(envelopeBytes, keys, { allowRespelledEnvelope: kind.anyEnvelopeSpelling === true });
  };
}

async function checkTrustBinding(
  view: RecordView,
  kind: RecordKind | undefined,
  signature: SignatureOutcome,
  trust: RecordTrustOptions | undefined,
): Promise<CheckResult<"trust-binding">> {
  if (kind === undefined) return skipped("trust-binding", "unknown-kind", "No registered kind says who this record speaks for.");
  if (trust?.bindingResolver === undefined) return skipped("trust-binding", "no-binding-resolver", "No binding resolver was supplied, so no key was tied to an identity.");
  if (signature.verifiedSigners.length === 0) return skipped("trust-binding", "no-verified-signer", "No signature was verified, so there is no key to bind.");
  const attribution = kind.attribution?.(view);
  if (attribution === undefined) return skipped("trust-binding", "no-attribution", "This record names no agent a binding could be resolved for.");
  const atTime = trust.atTime ?? attribution.atTime;
  if (atTime === undefined) return skipped("trust-binding", "no-effective-time", "This record states no effective time and the caller supplied none.");

  const findings: Finding[] = [];
  for (const key of signature.verifiedSigners) {
    try {
      // eslint-disable-next-line no-await-in-loop -- a record has few signers, and a resolver may be remote.
      const verdict = await verifyEnvelopeBinding(
        {
          envelopeBytes: view.bytes,
          key,
          agent: attribution.agent,
          family: attribution.scope,
          atTime,
          ...(attribution.allowSignsForAuthorization === true ? { allowSignsForAuthorization: true } : {}),
        },
        {
          bindingResolver: trust.bindingResolver,
          witnessVerifier: trust.witnessVerifier ?? {
            verify1271Witness: async () => ({ verified: false, reason: "no witness verifier was supplied" }),
          },
          dsseVerifier: bindingDsseVerifier(kind, trust),
          ...(trust.policy === undefined ? {} : { policy: trust.policy }),
        },
      );
      if (verdict.ok) return passed("trust-binding");
      findings.push({
        code: verdict.reason ?? "binding-not-resolved",
        subject: key,
        detail: verdict.detail ?? `No binding ties ${key} to ${attribution.agent} at ${atTime}.`,
      });
    } catch (cause) {
      // Trust §7.5's resolver is a dependency. Its outage says nothing about the record.
      return skipped("trust-binding", "binding-dependency-failed", `The binding could not be resolved: ${describeError(cause)}`);
    }
  }
  return failed("trust-binding", findings);
}

function guarded<Id extends RecordCheckId>(id: Id, run: () => CheckResult<Id>): CheckResult<Id> {
  try {
    return run();
  } catch (cause) {
    return failed(id, [{ code: "check-threw", detail: describeError(cause) }]);
  }
}

function outcomeOf(checks: readonly CheckResult<RecordCheckId>[], kind: RecordKind | undefined): RecordOutcome {
  if (checks.some(({ status }) => status === "failed")) return "failed";
  return kind === undefined ? "unknown-kind" : "checked";
}

export async function inspectRecord(bytes: Uint8Array, options: CheckRecordOptions = {}): Promise<InspectedRecord> {
  const digest = recordDigest(bytes);
  const view = readRecord(bytes);
  const kinds = options.kinds ?? defaultRecordKinds;
  const matches = Object.entries(kinds).filter(([, candidate]) => identifies(candidate, view));
  const [kindId, kind] = matches[0] ?? [UNKNOWN_KIND, undefined];
  const names = namedType(view);

  const digestCheck = checkDigest(digest, options.digest);
  const encoding = guarded("encoding", () => checkEncoding(view, kind, names));
  const schema = guarded("schema", () => checkSchema(view, kind, matches.length > 1));
  let signature: SignatureOutcome;
  try {
    signature = checkSignature(view, kind, options.trust);
  } catch (cause) {
    signature = { result: failed("signature", [{ code: "check-threw", detail: describeError(cause) }]), verifiedSigners: [] };
  }
  let trustBinding: CheckResult<"trust-binding">;
  try {
    trustBinding = await checkTrustBinding(view, kind, signature, options.trust);
  } catch (cause) {
    trustBinding = failed("trust-binding", [{ code: "check-threw", detail: describeError(cause) }]);
  }

  const checks = [digestCheck, encoding, schema, signature.result, trustBinding];
  const report: RecordReport = {
    digest,
    kind: kindId,
    ...(kind === undefined ? {} : { family: kind.family }),
    ...(names === undefined ? {} : { names }),
    outcome: outcomeOf(checks, kind),
    checks,
  };
  return { report, view, ...(kind === undefined ? {} : { kind }) };
}

/**
 * Checks one record by the spec's rules: its digest, its exact encoding, the schema of the type it
 * names, its signatures, and whether a trust record ties a signing key to the identity it claims.
 * A bad record never throws: every outcome is in the report, and what did not run says `skipped`.
 */
export async function checkRecord(bytes: Uint8Array, options: CheckRecordOptions = {}): Promise<RecordReport> {
  return (await inspectRecord(bytes, options)).report;
}
