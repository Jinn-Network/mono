import { readFileSync } from "node:fs";
import { SUPPORTED_BUNDLE_FORMATS } from "./manifest.js";
import {
  bundleIdentityLabel,
  describeRecomputedChecks,
  summarizeVerificationOutcome,
  type VerificationCheckName,
} from "./outcome.js";
import { verifyPublicBundle, type PublicBundleVerificationResult, type VerifyPublicBundleDeps } from "./verify.js";
import { verifyFreezeRepo, type FreezeRepoVerificationResult } from "./freeze-repo.js";
import type {
  AnchorSubjectReport,
  AnchorVerificationEntry,
  IntegrityAnchorsReport,
  PublicBundleAnchorTrustMaterial,
} from "./anchor/check.js";
import type { PublicBundleSigner, PublicBundleSignerRole } from "./signers.js";
import { refuse } from "./profile/errors.js";
import { verifyDomainBinding, type VerifiedDomainBinding } from "./identity/domain-binding.js";
import { publisherIdentityLines, publisherIdentitySentence } from "./identity/report-face.js";
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
  /** Test seam for the freeze-repository comparison. Defaults to the real one. */
  readonly freezeRepo?: (bundleDir: string, repoDir: string) => Promise<FreezeRepoVerificationResult>;
}

/**
 * Protocol namespaces that do not resolve for this reader. URL candidates are classified in the
 * replacer so an actionable third-party URL remains intact, while scheme-prefixed Jinn names and
 * the bare extension/method namespaces are treated the same way.
 */
const PROTOCOL_IDENTIFIER_CANDIDATE =
  /https?:\/\/[^\s,;)"']*|jinn\.(?:network|benchmarking)[^\s,;)"']*/gu;
const INTERNAL_PROTOCOL_URL =
  /^https?:\/\/(?:[^/?#]*\.)?jinn\.(?:network|benchmarking)(?::[0-9]+)?(?:[/?#]|$)/u;
const RAW_IDENTIFIER = /urn:[^\s,;)"']+|did:key:z[1-9A-HJ-NP-Za-km-z]+/gu;
const IDENTIFIER_ALIAS = "<identifier: see --json>";

function aliasIdentifier(match: string): string {
  return match.endsWith(".") ? `${IDENTIFIER_ALIAS}.` : IDENTIFIER_ALIAS;
}

/** Removes only Jinn's unresolvable protocol namespaces, preserving actionable outside URLs. */
function withoutInternalProtocolIdentifiers(message: string): string {
  return message.replace(PROTOCOL_IDENTIFIER_CANDIDATE, (match) => {
    if (match.startsWith("http") && !INTERNAL_PROTOCOL_URL.test(match)) return match;
    return aliasIdentifier(match);
  });
}

/** Refusal details keep raw identifiers in `--json`; the human error surface aliases them. */
function withoutHumanIdentifiers(message: string): string {
  return withoutInternalProtocolIdentifiers(message).replace(RAW_IDENTIFIER, aliasIdentifier);
}

/**
 * What this tool does to the platform bytes, stated identically wherever it is stated. The verdict
 * surface said one thing and the usage block another -- "Verification uses …", the noun #2982 ruled
 * overclaims -- because the sentence was written twice (issue #3675).
 */
const PLATFORM_BYTES_SENTENCE = "Checks run against the exact platform bytes installed from npm." as const;

/** The host gap, stated without handing a reader an unresolvable origin to visit. */
const IDENTIFIER_DISCLOSURE =
  "Protocol identifiers are names, not addresses — this verifier fetches nothing\n"
  + `from them. ${PLATFORM_BYTES_SENTENCE}`;

function usage(): string {
  return "Usage: colophon-verify <bundle> [--json] [--tsa-root <file>]... [--ots-headers <file>]...\n"
    + "                        [--freeze-repo <dir>] [--identity-binding <file>]\n"
    + "  --tsa-root     RFC 3161 trust anchor, DER or PEM. Repeatable.\n"
    + "  --ots-headers  Bitcoin block headers, one \"<height>:<80-byte-hex>\" per line. Repeatable.\n"
    + "  --freeze-repo  Also check that this published freeze-artifact repository is exactly what\n"
    + "                 the bundle renders. The repository is a derived artifact, never the claim\n"
    + "                 of record; a drifted tree exits 1.\n"
    + "  --identity-binding  A colophon-domain-binding/1 document binding one of this bundle's\n"
    + "                 signing keys to a domain. Checked offline as far as the bytes allow;\n"
    + "                 the lookup at the domain itself stays yours.\n"
    + "Trust material is yours, not the bundle's: with none supplied a well-formed anchor reports\n"
    + "present rather than verified, and none ships with this tool.\n"
    + "Exit 0: valid bundle; 1: invalid bundle, or a freeze repository that drifted from it;\n"
    + "     2: usage or operational failure, including a freeze repository that could not be\n"
    + "     rendered from the bundle — the bundle's own verdict is still reported.\n"
    + `${IDENTIFIER_DISCLOSURE}\n`;
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

/** Greedy wrap at the column the surrounding fixed prose is already written to. */
function wrap(text: string): string {
  const width = 76;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

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
  // A provider's free-form reason is authenticated report data, not CLI prose. Keep the exact value
  // in `--json`, but alias raw identifiers before this untrusted text enters the human report.
  if (entry.status === "pending") {
    return entry.reason === undefined ? "no chain attestation yet" : withoutHumanIdentifiers(entry.reason);
  }
  if (entry.status === "invalid") {
    return entry.reason === undefined ? "the proof does not verify" : withoutHumanIdentifiers(entry.reason);
  }
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

/** Keeps the declared provider's useful profile path while dropping its unresolvable host. */
function anchorProfileName(profile: string): string {
  return /^https?:\/\/[^/]+\/(?:[^/]+\/)*anchor-profiles\/(.+)$/u.exec(profile)?.[1] ?? profile;
}

function renderSubject(subject: AnchorSubjectReport): string {
  if (subject.outcome === "declared-but-absent") {
    return `  ${subject.subject}: declared-but-absent — this run declared `
      + `${subject.declaredProfiles?.map(anchorProfileName).join(", ") ?? "an anchor provider"} and the bundle carries no matching anchor`;
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

/**
 * Who published, on the line under the publisher group (issue #2983). One publisher key is the only
 * shape this names: a bundle with several would make "published by" ambiguous, and the honest answer
 * there is the group count already printed, not a domain picked from a list.
 */
function renderPublisherIdentity(
  signers: readonly PublicBundleSigner[],
  binding: VerifiedDomainBinding | undefined,
): string {
  const publishers = signers.filter((signer) => signer.role === "publisher");
  if (publishers.length !== 1) return "";
  return publisherIdentityLines(binding, publishers[0]!.keyFingerprint)
    .map((line) => `\n    ${line}`)
    .join("");
}

function renderSigners(
  signers: readonly PublicBundleSigner[],
  binding: VerifiedDomainBinding | undefined,
): string {
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
  const identity = renderPublisherIdentity(signers, binding);
  const lines = groups
    .map((group) => `${renderSignerGroup(group.role, group.custody, group.count)}${group.role === "publisher" ? identity : ""}`)
    .join("\n");
  return `\nSigned by\n${lines}\n`;
}

/**
 * The neighbouring limits paragraphs are hard-wrapped literals at 76 columns. This one is generated,
 * so it is wrapped here rather than in the shared sentence -- the words are the shared module's, the
 * column width is this surface's.
 */
function wrapParagraph(text: string | undefined, width = 76): string | undefined {
  if (text === undefined) return undefined;
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/**
 * The plain-language gloss printed beside each check name (reader-facing-vocabulary spec §4.2).
 * The check names themselves are **contract** -- sealed into `claim-package.json`'s
 * `verification.checks` and asserted by the external verification path -- so the spec rules them
 * *keep + gloss*: the reader gets the plain words on the same line, at zero contract cost.
 *
 * Each gloss is the proposition the check stands for, in the present tense, not a verdict on it.
 * That is what lets one gloss serve both states: beside `passed` it reads as what held, and beside
 * `not fetched` -- the one state a deferred check prints -- it reads as what was not established.
 * A past-tense gloss would claim, on the deferred row, exactly the thing that row exists to deny.
 *
 * Keyed by the check union so a closure that adds a check cannot print an unglossed name, the same
 * discipline `CHECK_SUBJECTS` uses in `outcome.ts`. Vocabulary follows the spec's §5 glossary:
 * *run*, *the result*, *the claim*, *evidence*, *fingerprint*, *timestamp proof*, *what was pinned*.
 */
const CHECK_GLOSSES: { readonly [C in VerificationCheckName]: string } = {
  "manifest": "every listed file is here, unaltered",
  "evidence-closure": "every run's evidence is carried here",
  "trust": "the signing keys match the identities",
  "matrix-rederivation": "the run tally follows from the evidence",
  "report-verification": "the result follows from the runs",
  "claim-consistency": "the claim agrees with the records here",
  "integrity-anchors": "the timestamp proofs are well formed",
  "disclosure-specification": "what was pinned is recorded and matches",
  "artifact-integrity": "each artifact matches its fingerprint",
  "signature-validity": "each signature matches its key",
};

/**
 * Wide enough for the longest check name (`disclosure-specification`, 24) plus a gutter. At 24 that
 * name rendered flush against its own state.
 */
const CHECK_NAME_COLUMN = 26;
/** Wide enough for the longest state (`not fetched`, 11) plus a gutter. */
const CHECK_STATE_COLUMN = 13;

export function renderVerifiedBundle(
  result: PublicBundleVerificationResult,
  binding?: VerifiedDomainBinding,
): string {
  // A metadata-first bundle carries artifact digests without their bytes. Printing "passed" for a
  // check that read nothing would be the one claim this format cannot afford, so the deferred check
  // prints as not fetched and is counted out of the passed total.
  const outcome = summarizeVerificationOutcome(result);
  const artifactContent = outcome.artifactContent;
  const checks = outcome.outcomes
    .map(({ check, state }) =>
      `${check.padEnd(CHECK_NAME_COLUMN)}${state.padEnd(CHECK_STATE_COLUMN)}${CHECK_GLOSSES[check]}`)
    .join("\n");
  const totalChecks = outcome.total;
  const identity = bundleIdentityLabel(result);
  const anchors = "anchors" in result && result.anchors !== undefined
    ? renderAnchorReport(result.anchors)
    : "";
  const signers = result.signers === undefined || result.signers.length === 0
    ? ""
    : renderSigners(result.signers, binding);
  // The limits of the binding, beside the other limits paragraphs rather than beside the name it
  // qualifies: a reader who takes the name at face value is exactly the reader this paragraph is
  // for, and it belongs where they finish reading.
  const identityLimits = wrapParagraph(publisherIdentitySentence(binding));
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
  // "Verified" is the most overloaded word in this market and claims more than this tool does: it
  // recomputes the arithmetic, closure, and consistency of bytes someone handed it, and reads
  // nothing about whether the recorded outcomes reflect real executions (issue #2982). The verdict
  // names the operation instead, and the limits of that operation print directly under it --
  // unconditionally, so no bundle shape can render a verdict with its caveats pushed off-screen.
  // The second sentence enumerates what this bundle's checks recomputed, derived from the same
  // outcome the denominator above comes from: an anchored or disclosed closure runs seven or eight
  // checks, and a fixed six-check list beneath an "of 8" verdict is a caveat that undercounts its
  // own subject (issue #3691). Wrapped here rather than hard-wrapped in the literal because the
  // enumeration's length now varies by format.
  const caveats = wrap("Not checked by this tool: whether the machine that produced this bundle was"
    + " honest, and whether the compared identities are independent parties. What is recomputed is "
    + `${describeRecomputedChecks(outcome)} — against the bytes the bundle carries, nothing else.`);
  const verdictLine = outcome.notFetched === 0
    ? `Recomputed: ${outcome.passed} of ${totalChecks} checks passed`
    : `Recomputed: ${outcome.passed} of ${totalChecks} checks passed, ${outcome.notFetched} not fetched`;
  return withoutInternalProtocolIdentifiers(`${verdictLine}
Bundle: ${identity}
Format: ${result.format}

${caveats}

${checks}
${signers}${artifactContentReport}${anchors}${artifactContentLimit}${anchorLimits}${identityLimits === undefined ? "" : `\n${identityLimits}`}
No files were uploaded.
${IDENTIFIER_DISCLOSURE}
`);
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

interface ParsedArguments {
  readonly bundleDir: string;
  readonly json: boolean;
  readonly tsaRoots: readonly string[];
  readonly otsHeaders: readonly string[];
  /** Present only when `--freeze-repo` was supplied (issue #2870). */
  readonly freezeRepoDir?: string;
  /** Present only when `--identity-binding` was supplied (issue #2983). */
  readonly identityBindingPath?: string;
}

function parseArguments(args: readonly string[]): ParsedArguments | undefined {
  const positional: string[] = [];
  const tsaRoots: string[] = [];
  const otsHeaders: string[] = [];
  let json = false;
  let freezeRepoDir: string | undefined;
  let identityBindingPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--tsa-root" || arg === "--ots-headers") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return undefined;
      (arg === "--tsa-root" ? tsaRoots : otsHeaders).push(value);
      index += 1;
    } else if (arg === "--freeze-repo") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || freezeRepoDir !== undefined) return undefined;
      freezeRepoDir = value;
      index += 1;
    } else if (arg === "--identity-binding") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || identityBindingPath !== undefined) return undefined;
      identityBindingPath = value;
      index += 1;
    } else if (arg.startsWith("--")) {
      return undefined;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return undefined;
  return {
    bundleDir: positional[0]!,
    json,
    tsaRoots,
    otsHeaders,
    ...(freezeRepoDir === undefined ? {} : { freezeRepoDir }),
    ...(identityBindingPath === undefined ? {} : { identityBindingPath }),
  };
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

/** The freeze-repository block of the human report: the pin, then every drifted member. */
function renderFreezeRepoCheck(check: FreezeRepoVerificationResult): string {
  const head = check.ok
    ? `\nfreeze repository: matches this bundle (${check.fileCount} files)`
    : `\nfreeze repository: DOES NOT match this bundle (${check.differences.length} of ${check.fileCount} members)`;
  const pin = `\n  commit ${check.commitId}`;
  const drift = check.differences.map((difference) => `\n  ${difference.kind}: ${difference.path}`).join("");
  // Naming which of the two it was: a claim about the reader's filesystem is only printed where the
  // probe established one, and a refused probe establishes nothing about it (issue #3604). A result
  // carrying no reason gets the bare sentence for the same rule — what was skipped, nothing more.
  const modes = check.executableBitChecked
    ? ""
    : check.executableBitSkipped === "not-recorded"
      ? "\n  note: file modes were not checked (this filesystem does not record an executable bit)"
      : check.executableBitSkipped === "not-probed"
        ? "\n  note: file modes were not checked (the filesystem could not be probed)"
        : "\n  note: file modes were not checked";
  return withoutHumanIdentifiers(`${head}${pin}${modes}${drift}\n`);
}

export async function runVerifierCli(
  args: readonly string[],
  deps: VerifierCliDeps = {},
): Promise<VerifierCliResult> {
  const parsed = parseArguments(args);
  if (parsed === undefined) return { exitCode: 2, stdout: "", stderr: withoutHumanIdentifiers(usage()) };

  const readFile = deps.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)));
  let anchorTrust: PublicBundleAnchorTrustMaterial | undefined;
  try {
    anchorTrust = buildAnchorTrust(parsed, readFile);
  } catch (cause) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: withoutHumanIdentifiers(
        `colophon-verify: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      ),
    };
  }

  let result: Awaited<ReturnType<typeof verifyPublicBundle>>;
  try {
    result = await (deps.verify ?? verifyPublicBundle)(
      parsed.bundleDir,
      anchorTrust === undefined ? {} : { anchorTrust },
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const code = (cause !== null && typeof cause === "object" && "code" in cause)
      ? String((cause as { code?: unknown }).code) : "environment";
    const stdout = parsed.json
      ? `${JSON.stringify({ ok: false, verifierVersion: VERIFIER_VERSION, supportedFormats: SUPPORTED_BUNDLE_FORMATS, code, message: error.message })}\n`
      : "";
    const stderr = parsed.json ? "" : `colophon-verify: ${withoutHumanIdentifiers(error.message)}\n`;
    return { exitCode: code === "record-integrity" ? 1 : 2, stdout, stderr };
  }

  // A supplied binding is resolved only after the bundle verifies, for the same reason the freeze
  // repository is: the check needs the signer set, and a bundle that does not verify has no signer
  // set worth attributing. Its failures are scoped to it too -- a binding that does not check out
  // says nothing about the bundle, whose own verdict is reported either way.
  let identity: VerifiedDomainBinding | undefined;
  let identityFailure: { readonly code: string; readonly message: string } | undefined;
  if (parsed.identityBindingPath !== undefined) {
    try {
      // Only the publisher's key, and only when there is exactly one. A binding answers "who
      // published this", so a binding for a grader or reviewer key names a party the reader is
      // MEASURING, not the one publishing -- and accepting it would caption the bundle with that
      // party's domain while suppressing the real publisher's fingerprint. A bundle with no single
      // publisher has no "published by" to render at all, so there is nothing for a binding to
      // qualify. Both cases refuse here, which is also what keeps the limits paragraph and the
      // identity line inseparable: neither exists without a resolved `identity`.
      const publishers = (result.signers ?? []).filter((signer) => signer.role === "publisher");
      if (publishers.length !== 1) {
        refuse(
          "conflict",
          "domain-binding",
          `this bundle names ${publishers.length} publisher keys, so it has no single published-by identity a binding can qualify`,
        );
      }
      identity = verifyDomainBinding(
        readFile(parsed.identityBindingPath),
        [publishers[0]!.keyId],
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      identityFailure = {
        code: (cause !== null && typeof cause === "object" && "code" in cause)
          ? String((cause as { code?: unknown }).code)
          : "environment",
        message: error.message,
      };
    }
  }

  // The freeze repository is checked only after the bundle itself verifies: a tree derived from
  // records that do not verify has nothing to be consistent with. Its own failures are scoped to
  // it: a bundle that cannot be RENDERED as a freeze repository — no licence declared, a licence
  // that is not an SPDX short identifier, an unreadable repository directory — is not thereby an
  // invalid bundle, and the bundle verdict already computed above is reported either way.
  let freezeRepo: FreezeRepoVerificationResult | undefined;
  let freezeRepoFailure: { readonly code: string; readonly message: string } | undefined;
  if (parsed.freezeRepoDir !== undefined) {
    try {
      freezeRepo = await (deps.freezeRepo ?? verifyFreezeRepo)(parsed.bundleDir, parsed.freezeRepoDir);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      freezeRepoFailure = {
        code: (cause !== null && typeof cause === "object" && "code" in cause)
          ? String((cause as { code?: unknown }).code)
          : "environment",
        message: error.message,
      };
    }
  }

  const stdout = parsed.json
    ? `${JSON.stringify({
      ok: freezeRepoFailure === undefined && identityFailure === undefined && (freezeRepo?.ok ?? true),
      verifierVersion: VERIFIER_VERSION,
      supportedFormats: SUPPORTED_BUNDLE_FORMATS,
      ...result,
      ...(freezeRepo === undefined ? {} : { freezeRepo }),
      ...(freezeRepoFailure === undefined ? {} : { freezeRepo: { ok: false, ...freezeRepoFailure } }),
      // NOT `identity`: `result.identity` is the bundle's own SHA-256, and a key that shadowed it
      // would hand a pinning consumer a binding object where it expected a digest.
      ...(identity === undefined ? {} : { identityBinding: { ok: true, ...identity } }),
      ...(identityFailure === undefined ? {} : { identityBinding: { ok: false, ...identityFailure } }),
    })}\n`
    : `${renderVerifiedBundle(result, identity)}${freezeRepo === undefined ? "" : renderFreezeRepoCheck(freezeRepo)}`;
  // Both notes are emitted, because a reader who supplied two flags is owed the outcome of both.
  const notes = parsed.json
    ? ""
    : [
      ...(freezeRepoFailure === undefined ? [] : [`freeze repository not checked: ${freezeRepoFailure.message}`]),
      ...(identityFailure === undefined ? [] : [`domain binding not applied: ${identityFailure.message}`]),
    ].map((note) => withoutHumanIdentifiers(`colophon-verify: ${note}\n`)).join("");
  // A drifted freeze repository is a verdict about the artifact and takes precedence: exit 1 is
  // what the usage text promises for it, and an operational failure on a different flag must not
  // silently re-code that verdict as 2.
  if (freezeRepo !== undefined && !freezeRepo.ok) return { exitCode: 1, stdout, stderr: notes };
  if (freezeRepoFailure !== undefined || identityFailure !== undefined) {
    return { exitCode: 2, stdout, stderr: notes };
  }
  return { exitCode: 0, stdout, stderr: "" };
}
