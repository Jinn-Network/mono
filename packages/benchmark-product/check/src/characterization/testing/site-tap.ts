// SPDX-License-Identifier: Apache-2.0

/**
 * Pass-through wrappers around the checker's own code. Three of the five signature checks are
 * private to `verify.ts`, so the only way to reach the real code is to stand at the seam it is
 * handed across. Each wrapper calls the real code, runs the package beside it on the same input,
 * records the two outcomes, and returns the real answer, so a corpus case runs exactly as it does
 * in the characterization suite.
 */

import { createHash, createPublicKey, KeyObject } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { VerifyEvidenceNativePortableBundleInput } from "@jinn-network/benchmarking-evidence";
import {
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyBytesFromDidKey,
  ed25519PublicKeyFromDidKey,
} from "@jinn-network/verify";
import { parseDsseEnvelope } from "@jinn-network/trust-core";
import { BundleV4TrustSchema } from "../../schema.js";
import type { BinaryJudgmentAdmissionClosurePorts } from "../../admission/verification.js";
import type { EvaluateIntegrityAnchorsInput } from "../../anchor/check.js";
import {
  authoritySignature,
  didKeyKeepingPinnedOutput,
  evidenceNativeSignature,
  integrityAnchors,
  keyFingerprint,
  reportEnvelopeSignatures,
  resolveAgent,
  reviewerSignature,
  type AdmissionKeys,
} from "./package-sites.js";

export const SITES = {
  evidenceNative: "verify.ts verifyEvidenceNativeSignature",
  reviewer: "verify.ts verifyReviewerSignature",
  authority: "verify.ts verifyAuthoritySignature",
  reportEnvelope: "profile/signing.ts verifyReportEnvelopeSignatures",
  evaluatorClaim: "profile/assembly-ports.ts resolveEvaluatorClaim",
  didKeyDerivation: "profile/signing.ts didKeyFromEd25519PublicKey, package alone",
  didKeyDerivationKept: "profile/signing.ts didKeyFromEd25519PublicKey, kept wrapper",
  didKeyBytes: "identity/did-key.ts ed25519PublicKeyBytesFromDidKey",
  didKeyObject: "identity/did-key.ts ed25519PublicKeyFromDidKey",
  didKeyFingerprint: "identity/did-key.ts keyFingerprintFromDidKey",
  anchors: "anchor/check.ts evaluateIntegrityAnchors",
} as const;

export type SiteId = (typeof SITES)[keyof typeof SITES];

export type Outcome =
  | { readonly returned: unknown }
  | { readonly threw: { readonly name: string; readonly message: string } };

export interface Difference {
  readonly site: SiteId;
  readonly local: Outcome;
  readonly package: Outcome;
}

export interface Tally {
  calls: number;
  /** Calls that said yes: a valid signer, a resolved claim, a decoded key, no invalid anchor. */
  accepted: number;
  refused: number;
}

/** A key the checker holds, as every signature check takes it. */
export interface HeldKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

/** The admission ports of one bundle's run, still bound to that bundle's keys. */
export interface CapturedAdmission {
  readonly ports: BinaryJudgmentAdmissionClosurePorts;
  readonly keys: AdmissionKeys;
}

/** Everything the sites saw, so every site can be run over all of it. */
export interface Seen {
  readonly envelopes: Map<string, Uint8Array>;
  readonly keys: Map<string, HeldKey>;
  readonly didKeys: Set<string>;
  readonly anchorInputs: EvaluateIntegrityAnchorsInput[];
}

let bundleDir: string | undefined;
let differences: Difference[] = [];
let tallies = new Map<SiteId, Tally>();
let admission: CapturedAdmission | undefined;
let verifySignature: VerifyEvidenceNativePortableBundleInput["verifySignature"] | undefined;
const seen: Seen = { envelopes: new Map(), keys: new Map(), didKeys: new Set(), anchorInputs: [] };

/** Names the bundle the next calls belong to, for the sites that read keys from its trust file. */
export function enterBundle(directory: string | undefined): void {
  bundleDir = directory;
}

/** The differences recorded since the last call. */
export function takeDifferences(): readonly Difference[] {
  const taken = differences;
  differences = [];
  return taken;
}

/** The tally since the last call. */
export function takeTallies(): ReadonlyMap<SiteId, Tally> {
  const taken = tallies;
  tallies = new Map();
  return taken;
}

export function seenSoFar(): Seen {
  return seen;
}

export function capturedAdmission(): CapturedAdmission | undefined {
  return admission;
}

export function capturedEvidenceNativeCheck(): VerifyEvidenceNativePortableBundleInput["verifySignature"] | undefined {
  return verifySignature;
}

function comparable(value: unknown): unknown {
  return value instanceof KeyObject
    ? { spkiDerBase64: value.export({ format: "der", type: "spki" }).toString("base64") }
    : value;
}

function describeThrown(cause: unknown): { readonly name: string; readonly message: string } {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { name: "thrown", message: String(cause) };
}

function saidYes(outcome: Outcome): boolean {
  if (!("returned" in outcome)) return false;
  const { returned } = outcome;
  if (returned === undefined || returned === false || returned === "unresolved") return false;
  if (typeof returned !== "object" || returned === null) return true;
  const { validSignerKeyids, invalid } = returned as {
    readonly validSignerKeyids?: readonly string[];
    readonly invalid?: readonly unknown[];
  };
  if (validSignerKeyids !== undefined) return validSignerKeyids.length > 0;
  return invalid === undefined || invalid.length === 0;
}

function note(site: SiteId, local: Outcome, mapped: Outcome): void {
  const tally = tallies.get(site) ?? { calls: 0, accepted: 0, refused: 0 };
  tally.calls += 1;
  if (saidYes(local)) tally.accepted += 1;
  else tally.refused += 1;
  tallies.set(site, tally);
  // The second comparison is the one a reader of the output makes: key order and all.
  const same = isDeepStrictEqual(local, mapped) && JSON.stringify(local) === JSON.stringify(mapped);
  if (!same) differences.push({ site, local, package: mapped });
}

function outcomeOf(run: () => unknown): Outcome {
  try {
    return { returned: comparable(run()) };
  } catch (cause) {
    return { threw: describeThrown(cause) };
  }
}

async function outcomeOfAsync(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { returned: comparable(await run()) };
  } catch (cause) {
    return { threw: describeThrown(cause) };
  }
}

function compared<T>(site: SiteId, local: () => T, mapped: () => unknown): T {
  let result: T;
  try {
    result = local();
  } catch (cause) {
    note(site, { threw: describeThrown(cause) }, outcomeOf(mapped));
    throw cause;
  }
  note(site, { returned: comparable(result) }, outcomeOf(mapped));
  return result;
}

async function comparedAsync<T>(site: SiteId, local: () => T | Promise<T>, mapped: () => Promise<unknown>): Promise<T> {
  let result: T;
  try {
    result = await local();
  } catch (cause) {
    note(site, { threw: describeThrown(cause) }, await outcomeOfAsync(mapped));
    throw cause;
  }
  note(site, { returned: comparable(result) }, await outcomeOfAsync(mapped));
  return result;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function seeEnvelope(bytes: Uint8Array): void {
  seen.envelopes.set(digestOf(bytes), bytes);
}

function seeKey(key: HeldKey): void {
  const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  seen.keys.set(`${key.keyId} ${spki}`, key);
}

function heldKey(spkiDerBase64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiDerBase64, "base64"), format: "der", type: "spki" });
}

function isEnvelope(bytes: Uint8Array): boolean {
  try {
    parseDsseEnvelope(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes in what a bundle carries, whether or not its run reaches the sites: most tampered bundles
 * are refused long before any signature, and every site still has to answer for their contents.
 */
export function seeBundle(directory: string): void {
  const records = join(directory, "records");
  const paths = [
    join(directory, "report-envelope.json"),
    ...(existsSync(records) ? readdirSync(records).map((name) => join(records, name)) : []),
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const bytes = new Uint8Array(readFileSync(path));
    if (isEnvelope(bytes)) seeEnvelope(bytes);
  }
  try {
    const { report, evaluators } = JSON.parse(readFileSync(join(directory, "trust/public-keys.json"), "utf8")) as {
      readonly report: { readonly keyId: string; readonly didKey: string; readonly author: string; readonly spkiDerBase64: string };
      readonly evaluators: readonly { readonly keyId: string; readonly spkiDerBase64: string }[];
    };
    for (const identifier of [report.keyId, report.didKey, report.author]) seen.didKeys.add(identifier);
    for (const { keyId, spkiDerBase64 } of [report, ...evaluators]) seeKey({ keyId, publicKey: heldKey(spkiDerBase64) });
  } catch {
    // A tampered trust file holds no keys to take in. The corpus case itself pins what it says.
  }
}

/** What `verifyPublicBundleSnapshot` derives from a qualifying bundle's trust file. */
function admissionKeys(): AdmissionKeys {
  if (bundleDir === undefined) throw new Error("an admission port ran outside a bundle");
  const trust = BundleV4TrustSchema.parse(
    JSON.parse(readFileSync(join(bundleDir, "trust/public-keys.json"), "utf8")),
  );
  return {
    reportKey: heldKey(trust.report.spkiDerBase64),
    evaluatorKeys: new Map(trust.evaluators.map((entry) => [
      entry.evaluator,
      { keyId: entry.keyId, publicKey: heldKey(entry.spkiDerBase64) },
    ])),
    trust,
  };
}

type Signing = typeof import("../../profile/signing.js");

export function tapSigning(actual: Signing): Signing {
  return {
    ...actual,
    didKeyFromEd25519PublicKey: (publicKey) => {
      note(
        SITES.didKeyDerivationKept,
        outcomeOf(() => actual.didKeyFromEd25519PublicKey(publicKey)),
        outcomeOf(() => didKeyKeepingPinnedOutput(publicKey)),
      );
      return compared(
        SITES.didKeyDerivation,
        () => actual.didKeyFromEd25519PublicKey(publicKey),
        () => didKeyFromEd25519PublicKey(publicKey),
      );
    },
    verifyReportEnvelopeSignatures: (envelopeBytes, key) => {
      seeEnvelope(envelopeBytes);
      seeKey(key);
      return compared(
        SITES.reportEnvelope,
        () => actual.verifyReportEnvelopeSignatures(envelopeBytes, key),
        () => reportEnvelopeSignatures(envelopeBytes, key),
      );
    },
  };
}

type AssemblyPortsModule = typeof import("../../profile/assembly-ports.js");

export function tapAssemblyPorts(actual: AssemblyPortsModule): AssemblyPortsModule {
  return {
    ...actual,
    buildAssemblyPortsFromFacts: (input) => {
      for (const key of input.evaluatorKeys().values()) seeKey(key);
      const seeing = {
        ...input,
        resolveBytes: (digest: string) => {
          const bytes = input.resolveBytes(digest);
          seeEnvelope(bytes);
          return bytes;
        },
      };
      const ports = actual.buildAssemblyPortsFromFacts(seeing);
      return {
        ...ports,
        trust: {
          resolveAgent: (ref, at) => comparedAsync(
            SITES.evaluatorClaim,
            () => ports.trust.resolveAgent(ref, at),
            () => resolveAgent(seeing, ref, at),
          ),
        },
      };
    },
  };
}

type DidKeyModule = typeof import("../../identity/did-key.js");

export function tapDidKey(actual: DidKeyModule): DidKeyModule {
  return {
    ...actual,
    ed25519PublicKeyBytesFromDidKey: (keyId) => {
      seen.didKeys.add(keyId);
      return compared(
        SITES.didKeyBytes,
        () => actual.ed25519PublicKeyBytesFromDidKey(keyId),
        () => ed25519PublicKeyBytesFromDidKey(keyId),
      );
    },
    ed25519PublicKeyFromDidKey: (keyId) => {
      seen.didKeys.add(keyId);
      return compared(
        SITES.didKeyObject,
        () => actual.ed25519PublicKeyFromDidKey(keyId),
        () => ed25519PublicKeyFromDidKey(keyId),
      );
    },
    keyFingerprintFromDidKey: (keyId) => {
      seen.didKeys.add(keyId);
      return compared(
        SITES.didKeyFingerprint,
        () => actual.keyFingerprintFromDidKey(keyId),
        () => keyFingerprint(keyId),
      );
    },
  };
}

type AnchorCheckModule = typeof import("../../anchor/check.js");

export function tapAnchorCheck(actual: AnchorCheckModule): AnchorCheckModule {
  return {
    ...actual,
    evaluateIntegrityAnchors: (input) => {
      seen.anchorInputs.push(input);
      return compared(
        SITES.anchors,
        () => actual.evaluateIntegrityAnchors(input),
        () => integrityAnchors(input),
      );
    },
  };
}

type AdmissionModule = typeof import("../../admission/verification.js");

export function tapAdmission(actual: AdmissionModule): AdmissionModule {
  return {
    ...actual,
    verifyBinaryJudgmentAdmissionClosure: (input, ports) => {
      const keys = admissionKeys();
      admission = { ports, keys };
      return actual.verifyBinaryJudgmentAdmissionClosure(input, {
        ...ports,
        verifyReviewerSignature: (signed) => {
          seeEnvelope(signed.envelopeBytes);
          return compared(
            SITES.reviewer,
            () => ports.verifyReviewerSignature(signed),
            () => reviewerSignature(signed, keys),
          );
        },
        verifyAuthoritySignature: (signed) => {
          seeEnvelope(signed.envelopeBytes);
          return compared(
            SITES.authority,
            () => ports.verifyAuthoritySignature(signed),
            () => authoritySignature(signed, keys),
          );
        },
      });
    },
  };
}

type EvidenceModule = typeof import("@jinn-network/benchmarking-evidence");

export function tapEvidence(actual: EvidenceModule): EvidenceModule {
  return {
    ...actual,
    verifyEvidenceNativePortableBundle: (input) => {
      verifySignature = input.verifySignature;
      return actual.verifyEvidenceNativePortableBundle({
        ...input,
        verifySignature: (signature) => comparedAsync(
          SITES.evidenceNative,
          () => input.verifySignature(signature),
          async () => evidenceNativeSignature(signature),
        ),
      });
    },
  };
}

/** Runs the real evidence-native check and the package on one input, outside any bundle. */
export function compareEvidenceNative(
  input: Parameters<VerifyEvidenceNativePortableBundleInput["verifySignature"]>[0],
): Promise<boolean> {
  const local = verifySignature;
  if (local === undefined) throw new Error("no bundle has reached the evidence-native check yet");
  return comparedAsync(SITES.evidenceNative, () => local(input), async () => evidenceNativeSignature(input));
}

/** Runs the real reviewer check and the package on one input, outside any bundle. */
export function compareReviewer(
  captured: CapturedAdmission,
  input: Parameters<BinaryJudgmentAdmissionClosurePorts["verifyReviewerSignature"]>[0],
): boolean {
  return compared(
    SITES.reviewer,
    () => captured.ports.verifyReviewerSignature(input),
    () => reviewerSignature(input, captured.keys),
  );
}

/** Runs the real authority check and the package on one input, outside any bundle. */
export function compareAuthority(
  captured: CapturedAdmission,
  input: Parameters<BinaryJudgmentAdmissionClosurePorts["verifyAuthoritySignature"]>[0],
): boolean {
  return compared(
    SITES.authority,
    () => captured.ports.verifyAuthoritySignature(input),
    () => authoritySignature(input, captured.keys),
  );
}
