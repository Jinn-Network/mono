import { readFileSync } from "node:fs";
import { SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import { summarizeVerificationOutcome } from "./outcome.js";
import { verifyPublicBundle, type PublicBundleVerificationResult, type VerifyPublicBundleDeps } from "./verify.js";
import type {
  AnchorSubjectReport,
  AnchorVerificationEntry,
  IntegrityAnchorsReport,
  PublicBundleAnchorTrustMaterial,
} from "./anchor/check.js";
import type { PublicBundleSigner, PublicBundleSignerRole } from "./signers.js";
import { VERIFIER_VERSION } from "./version.js";

export { VERIFIER_VERSION } from "./version.js";

export interface VerifierCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerifierCliDeps {
  readonly verify?: (
    bundleDir: string,
    options?: VerifyPublicBundleDeps,
  ) => Promise<PublicBundleVerificationResult>;
  /** Test seam for the trust-material files the flags name. Defaults to the real filesystem. */
  readonly readFile?: (path: string) => Uint8Array;
}

function usage(): string {
  return "Usage: colophon-verify <bundle> [--json] [--tsa-root <file>]... [--ots-headers <file>]...\n"
    + "  --tsa-root     RFC 3161 trust anchor, DER or PEM. Repeatable.\n"
    + "  --ots-headers  Bitcoin block headers, one \"<height>:<80-byte-hex>\" per line. Repeatable.\n"
    + "Trust material is yours, not the bundle's: with none supplied a well-formed anchor reports\n"
    + "present rather than verified, and none ships with this tool.\n"
    + "Exit 0: valid bundle; 1: invalid bundle; 2: usage or operational failure.\n"
    + "Identifiers inside record files are internal names: they name https://spec.jinn.network/\u2026,\n"
    + "and that origin is not hosted yet. Checking uses the exact code installed from npm and\n"
    + "fetches nothing from the web.\n";
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

function anchoredValue(entry: AnchorVerificationEntry): string | undefined {
  const facts = entry.facts as
    | { readonly genTime?: unknown; readonly blockHeight?: unknown }
    | undefined;
  if (typeof facts?.genTime === "string") return facts.genTime;
  if (typeof facts?.blockHeight === "number") return `block ${facts.blockHeight}`;
  return undefined;
}

/** What THIS reader did about the time basis, stated separately from what the bytes say. §8: the
 * verifier's own report always adds its evaluation — whose material validated the time basis, or
 * that none was supplied. */
function evaluationNote(entry: AnchorVerificationEntry): string {
  if (entry.status === "verified") {
    // The evaluated instant is reported only where it adds something the head line does not: for a
    // chain-time proof it is the block's own time, which the height alone never gives.
    const evaluated = entry.time !== undefined && entry.time !== anchoredValue(entry)
      ? ` — ${entry.time}`
      : "";
    return `time basis evaluated against trust material you supplied${evaluated}`;
  }
  if (entry.status === "pending") return entry.reason ?? "no chain attestation yet";
  if (entry.status === "invalid") return entry.reason ?? "the proof does not verify";
  // Exhaustive over the four proof statuses: `present` is the only one left. A fifth member of
  // ANCHOR_PROOF_STATUSES fails here rather than silently inheriting this note.
  entry.status satisfies "present";
  // `present` with material supplied is a different disclosure from `present` with none: this
  // reader did have material for the profile, and it did not carry this anchor to `verified`.
  return entry.trustMaterial === "supplied"
    ? "time basis not evaluated: the trust material you supplied does not verify this anchor"
    : "time basis not evaluated: no trust material supplied";
}

function renderAnchor(entry: AnchorVerificationEntry): string {
  const value = anchoredValue(entry);
  const head = [
    `  ${entry.subject ?? "unresolved"} anchor`,
    entry.timeBasis ?? "unknown time basis",
    entry.status,
    ...(value === undefined ? [] : [value]),
  ].join(" · ");
  return `${head}\n    ${evaluationNote(entry)}\n    record ${entry.recordSha256}`;
}

function renderSubject(subject: AnchorSubjectReport): string {
  if (subject.outcome === "declared-but-absent") {
    return `  ${subject.subject}: declared-but-absent — this run declared `
      + `${subject.declaredProfiles?.join(", ") ?? "an anchor provider"} and the bundle carries no matching anchor`;
  }
  if (subject.outcome === "absent") return `  ${subject.subject}: absent — no anchor was carried and none was declared`;
  return `  ${subject.subject}: anchored`;
}

function renderAnchorReport(report: IntegrityAnchorsReport): string {
  const anchors = report.anchors.length === 0
    ? "  no anchor records carried"
    : report.anchors.map(renderAnchor).join("\n");
  return `\nAnchors\n${anchors}\n\nAnchor subjects\n${report.subjects.map(renderSubject).join("\n")}\n`;
}

const SIGNER_ROLE_NAMES: Record<PublicBundleSignerRole, string> = {
  publisher: "publisher",
  "automated-grader": "automated grader",
  "human-reviewer": "human reviewer",
  "label-admission": "label admission",
};

/** The role in plain words. `urn:`/`did:key` identifiers stay in `--json`, where they are the join
 * key a reader actually needs them for; on this surface they are noise a reader has to decode.
 * Undeclared custody is stated rather than left blank: a reader who has seen the same-operator
 * suffix elsewhere would otherwise read its absence as an independence claim, which no bundle
 * format can establish. The publisher takes no suffix -- it *is* the operator the others are
 * measured against. */
function renderSignerGroup(role: PublicBundleSignerRole, custody: PublicBundleSigner["custody"], count: number): string {
  const suffix = role === "publisher"
    ? ""
    : custody === "same-operator" ? " \u2014 same operator" : " \u2014 custody not declared";
  return `  ${SIGNER_ROLE_NAMES[role]}${suffix} \u00b7 ${count} ${count === 1 ? "key" : "keys"}`;
}

function renderSigners(signers: readonly PublicBundleSigner[]): string {
  const counts = new Map<string, { role: PublicBundleSignerRole; custody: PublicBundleSigner["custody"]; count: number }>();
  for (const signer of signers) {
    const key = `${signer.role} ${signer.custody}`;
    const group = counts.get(key);
    if (group === undefined) counts.set(key, { role: signer.role, custody: signer.custody, count: 1 });
    else group.count += 1;
  }
  // The role-name record's own key order is the print order; a second parallel list would drift.
  const order = Object.keys(SIGNER_ROLE_NAMES) as PublicBundleSignerRole[];
  const groups = [...counts.values()]
    .sort((left, right) => order.indexOf(left.role) - order.indexOf(right.role));
  return `\nSigned by\n${groups.map((group) => renderSignerGroup(group.role, group.custody, group.count)).join("\n")}\n`;
}

/**
 * One plain-language line per named check, so a reader who has never read the bundle format can
 * tell what each result covers. The names themselves stay -- they are the join key to `--json`,
 * the report page's "Named checks" list, and every refusal message -- and the gloss is additive.
 * The record spans both closure families: the six classic checks plus `integrity-anchors`, and
 * the evidence-native v5 pair. A name with no entry renders bare rather than throwing: the
 * renderer must never be the reason a valid bundle cannot be reported. A `Map` rather than an
 * object literal so a check named `toString` or `constructor` misses instead of rendering an
 * inherited `Object.prototype` member.
 */
const CHECK_GLOSSES = new Map<string, string>([
  ["manifest", "every file the bundle lists is present and matches its recorded digest"],
  ["evidence-closure", "every record the results depend on is carried inside the bundle"],
  ["artifact-integrity", "each stored artifact hashes to the digest its record names"],
  // "the signatures verify", not "each signature verifies": the result-evaluation and
  // execution-verification families require every listed signature (`verifyDsseSignatures`), but
  // a HumanLabelResolution record is accepted on `signatures.some(Boolean)`. A per-signature
  // quantifier would overclaim on that third family.
  ["signature-validity", "the signatures verify against the keys their records name"],
  // Not "signatures verify": the `trust` check derives and cross-checks the declared key set and
  // stops there. The verdict and report signatures are verified under `matrix-rederivation` and
  // `report-verification`. Naming the wrong thing here would reintroduce the overclaim this
  // surface just removed.
  ["trust", "the declared keys are internally consistent and cover exactly the evaluators the results cite"],
  ["matrix-rederivation", "the per-cell outcomes recompute to the sealed matrix"],
  ["report-verification", "the report's numbers recompute from that sealed matrix"],
  ["claim-consistency", "the published claim repeats the report without drift"],
  ["integrity-anchors", "each carried time anchor is well-formed and covers what it names"],
]);

/**
 * Format-specific corrections to {@link CHECK_GLOSSES}. A check name can be produced by more than
 * one implementation, and a single format-independent sentence would then be true of only some of
 * them. Bundle format v5 is evidence-native: `verifyEvidenceNativeReport` parses the DSSE
 * envelope, checks the payload type, and asserts the report names the sealed matrix as its
 * subject. It consults no method registry and recomputes nothing — `report.results` is an opaque
 * JSON value there — so the legacy recompute sentence would state a proof this path never
 * performed. Legacy formats keep it because `verifyReport` really does recompute and compare.
 */
const EVIDENCE_NATIVE_CHECK_GLOSSES = new Map<string, string>([
  ["report-verification", "the sealed report is signed and bound to that sealed matrix"],
]);

export function renderVerifiedBundle(result: PublicBundleVerificationResult): string {
  // A metadata-first bundle carries artifact digests without their bytes. Printing "passed" for a
  // check that read nothing would be the one claim this format cannot afford, so the deferred check
  // prints as not fetched and is counted out of the passed total.
  const outcome = summarizeVerificationOutcome(result);
  const artifactContent = outcome.artifactContent;
  const evidenceNative = result.format === "benchmark-product-public-bundle/5";
  const checks = outcome.outcomes
    .map(({ check, state }) => {
      // A gloss states what a check proved, so only a check that ran gets one. A deferred check
      // read nothing, and printing what it would have proved beside "not fetched" would restate
      // the overclaim the deferred state exists to refuse.
      if (state !== "passed") return `${check.padEnd(24)}${state}`;
      const gloss = (evidenceNative ? EVIDENCE_NATIVE_CHECK_GLOSSES.get(check) : undefined)
        ?? CHECK_GLOSSES.get(check);
      return `${check.padEnd(24)}${state}${gloss === undefined ? "" : ` — ${gloss}`}`;
    })
    .join("\n");
  const totalChecks = outcome.total;
  const identity = result.identity.startsWith("sha256:") ? result.identity : `sha256:${result.identity}`;
  const anchors = "anchors" in result && result.anchors !== undefined
    ? renderAnchorReport(result.anchors)
    : "";
  const signers = result.signers === undefined || result.signers.length === 0
    ? ""
    : renderSigners(result.signers);
  // Naming the digests is what makes the deferred check completable: they are the addresses to
  // fetch and the expectations to check the fetched bytes against. Adding a body to this directory
  // is not the completion path -- it would break the manifest closure the bundle is identified by,
  // so the reader is pointed at the full-evidence bundle instead.
  const artifactContentReport = artifactContent === undefined
    ? ""
    : `\nArtifact content\n  ${artifactContent.notFetched} artifact ${artifactContent.notFetched === 1 ? "body was" : "bodies were"} not fetched. This bundle carries their\n  exact digests, not their bytes:\n${artifactContent.notFetchedDigests.map((digest) => `    sha256:${digest}`).join("\n")}\n  Check fetched bytes against those digests yourself, or verify the\n  full-evidence bundle, which carries them.\n`;
  const artifactContentLimit = artifactContent === undefined
    ? ""
    : "\nEverything above was checked against the bytes this bundle carries. The artifact\ncontents themselves were not read, so nothing here says what they contain.";
  const anchorLimits = anchors === ""
    ? ""
    : "\nAn anchor dates the bytes it covers and says nothing else about the run: not\nthat results were produced after it, and not that the anchoring authority is\nindependent of the bundle's owner.";
  // "Checked", not "Verified" (#3022): the headline states what this tool did, and the passed
  // count is what it found. A deferred check is disclosed beside that count, never inside it.
  const verdictLine = outcome.notFetched === 0
    ? `Checked: ${outcome.passed} of ${totalChecks} checks passed`
    : `Checked: ${outcome.passed} of ${totalChecks} checks passed, ${outcome.notFetched} not fetched`;
  return `${verdictLine}
Bundle: ${identity}
Format: ${result.format}

${checks}
${signers}${artifactContentReport}${anchors}
Checking opens no network connection, reads no account or API credential, and
uploads nothing. It checks the bundle's integrity, evidence closure,
calculations, report, and claim consistency. It does not prove that the
producing machine was honest or that the compared identities are independent
parties.${artifactContentLimit}${anchorLimits}
`;
}

// ---------------------------------------------------------------------------
// Verifier-side trust material (anchor-evidence design §8 step 3)
// ---------------------------------------------------------------------------

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g;

/** Accepts a DER file as-is, or one or more PEM blocks. Nothing here validates the certificate;
 * that is the chain verifier's job, and an operator naming a file they chose is not an assertion
 * this tool second-guesses. */
function readTrustAnchors(bytes: Uint8Array): readonly Uint8Array[] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const blocks = [...text.matchAll(PEM_BLOCK)];
  if (blocks.length === 0) return [bytes];
  return blocks.map((block) => new Uint8Array(Buffer.from(block[1]!.replace(/\s+/g, ""), "base64")));
}

const HEADER_LINE = /^([0-9]+):([0-9a-fA-F]{160})$/;

function readBlockHeaders(bytes: Uint8Array, path: string): readonly { height: number; header: Uint8Array }[] {
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    .split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  return lines.map((line) => {
    const match = HEADER_LINE.exec(line);
    if (match === null) {
      throw new Error(`${path}: expected "<height>:<160 hex characters>" per line, got "${line}"`);
    }
    return {
      height: Number.parseInt(match[1]!, 10),
      header: new Uint8Array(Buffer.from(match[2]!.toLowerCase(), "hex")),
    };
  });
}

/** `urn:…` and `did:key:z…` as they appear inside a refusal message. The base58btc class stops a
 * `did:key` match before a trailing `:reason` suffix the message appended. */
const RAW_IDENTIFIER = /urn:[^\s,;)"']+|did:key:z[1-9A-HJ-NP-Za-km-z]+/gu;

/** A refusal names the signer it refused, and on the machine surface that identifier is the whole
 * point. On the human surface it is a string a reader cannot act on, so the same rule as the
 * verified report applies: the identifier lives in `--json` (issue #3024). What failed, and where,
 * is untouched. */
function withoutRawIdentifiers(message: string): string {
  return message.replace(RAW_IDENTIFIER, "<identifier: see --json>");
}

interface ParsedArguments {
  readonly bundleDir: string;
  readonly json: boolean;
  readonly tsaRoots: readonly string[];
  readonly otsHeaders: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments | undefined {
  const positional: string[] = [];
  const tsaRoots: string[] = [];
  const otsHeaders: string[] = [];
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--tsa-root" || arg === "--ots-headers") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      (arg === "--tsa-root" ? tsaRoots : otsHeaders).push(value);
      index += 1;
    } else if (arg.startsWith("--")) {
      return undefined;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return undefined;
  return { bundleDir: positional[0]!, json, tsaRoots, otsHeaders };
}

function buildAnchorTrust(
  parsed: ParsedArguments,
  readFile: (path: string) => Uint8Array,
): PublicBundleAnchorTrustMaterial | undefined {
  const trustAnchorsDer = parsed.tsaRoots.flatMap((path) => readTrustAnchors(readFile(path)));
  const blockHeaders = parsed.otsHeaders.flatMap((path) => readBlockHeaders(readFile(path), path));
  if (trustAnchorsDer.length === 0 && blockHeaders.length === 0) return undefined;
  return {
    ...(trustAnchorsDer.length === 0 ? {} : { rfc3161: { trustAnchorsDer } }),
    ...(blockHeaders.length === 0 ? {} : { opentimestamps: { blockHeaders } }),
  };
}

export async function runVerifierCli(
  args: readonly string[],
  deps: VerifierCliDeps = {},
): Promise<VerifierCliResult> {
  const parsed = parseArguments(args);
  if (parsed === undefined) return { exitCode: 2, stdout: "", stderr: usage() };

  let anchorTrust: PublicBundleAnchorTrustMaterial | undefined;
  try {
    anchorTrust = buildAnchorTrust(
      parsed,
      deps.readFile ?? ((path) => new Uint8Array(readFileSync(path))),
    );
  } catch (cause) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `colophon-verify: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    };
  }

  try {
    const result = await (deps.verify ?? verifyPublicBundle)(
      parsed.bundleDir,
      anchorTrust === undefined ? {} : { anchorTrust },
    );
    const stdout = parsed.json
      ? `${JSON.stringify({ ok: true, verifierVersion: VERIFIER_VERSION, supportedFormats: SUPPORTED_BUNDLE_FORMATS, ...result })}\n`
      : renderVerifiedBundle(result);
    return { exitCode: 0, stdout, stderr: "" };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const code = (cause !== null && typeof cause === "object" && "code" in cause)
      ? String((cause as { code?: unknown }).code) : "environment";
    const stdout = parsed.json
      ? `${JSON.stringify({ ok: false, verifierVersion: VERIFIER_VERSION, supportedFormats: SUPPORTED_BUNDLE_FORMATS, code, message: error.message })}\n`
      : "";
    const stderr = parsed.json ? "" : `colophon-verify: ${withoutRawIdentifiers(error.message)}\n`;
    return { exitCode: code === "record-integrity" ? 1 : 2, stdout, stderr };
  }
}
