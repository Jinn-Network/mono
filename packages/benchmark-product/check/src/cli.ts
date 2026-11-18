import { readFileSync } from "node:fs";
import type { VerificationFailureReason } from "@jinn-network/trust-core";
import { SUPPORTED_BUNDLE_FORMATS, type VerifiedBundleSnapshot } from "./manifest.js";
import {
  bundleIdentityLabel,
  describeRecomputedChecks,
  summarizeVerificationOutcome,
  type VerificationCheckName,
} from "./outcome.js";
import {
  verifyPublicBundleSnapshot,
  type PublicBundleVerificationResult,
  type VerifiedPublicBundleSnapshot,
  type VerifyPublicBundleDeps,
} from "./verify.js";
import { verifyFreezeRepoSnapshot, type FreezeRepoVerificationResult } from "./freeze-repo.js";
import type {
  AnchorSubjectReport,
  AnchorVerificationEntry,
  IntegrityAnchorsReport,
  PublicBundleAnchorTrustMaterial,
} from "./anchor/check.js";
import type { ClaimAnchorSubject } from "./profile/anchor-claims.js";
import type { PublicBundleSigner, PublicBundleSignerRole } from "./signers.js";
import { refuse } from "./profile/errors.js";
import { verifyDomainBinding, type VerifiedDomainBinding } from "./identity/domain-binding.js";
import { publisherIdentityLines, publisherIdentitySentence } from "./identity/report-face.js";
import { rewriteInternalProtocolIdentifiers } from "./identifier-presentation.js";
import { VERIFIER_VERSION } from "./version.js";

export { VERIFIER_VERSION } from "./version.js";

export interface VerifierCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface VerifierCliDeps {
  /**
   * Returns the verification AND the authenticated snapshot it was computed from, because
   * `--freeze-repo` renders its tree from that same snapshot. The alternative — verifying once for
   * the verdict and again inside the freeze check — ran the second pass without the `--tsa-root` /
   * `--ots-headers` material the caller supplied, so its anchor outcomes could differ from the
   * reported ones with nothing saying so.
   */
  readonly verify?: (
    bundleDir: string,
    options?: VerifyPublicBundleDeps,
  ) => Promise<VerifiedPublicBundleSnapshot>;
  /** Test seam for the trust-material files the flags name. Defaults to the real filesystem. */
  readonly readFile?: (path: string) => Uint8Array;
  /**
   * Test seam for the freeze-repository comparison. Defaults to the real one, which renders from
   * the snapshot `verify` already returned rather than re-reading the bundle directory.
   */
  readonly freezeRepo?: (
    snapshot: VerifiedBundleSnapshot,
    repoDir: string,
  ) => FreezeRepoVerificationResult | Promise<FreezeRepoVerificationResult>;
}

const RAW_IDENTIFIER = /urn:[^\s,;)"']+|did:key:z[1-9A-HJ-NP-Za-km-z]+/gu;
const IDENTIFIER_ALIAS = "<identifier: see --json>";

/** Reasons a trust failure appends to its signer (`<key>:<reason>`); `unknown` is aggregate's
 * fallback. Typed as a total record so a new trust-core reason is a compile error here. */
const TRUST_FAILURE_REASONS: Readonly<Record<VerificationFailureReason | "unknown", true>> = {
  "envelope-signature-invalid": true,
  "binding-not-resolved": true,
  "ceremony-verification-failed": true,
  "window-violation": true,
  "scope-violation": true,
  "consent-chain-violation": true,
  revoked: true,
  "policy-rejected": true,
  unknown: true,
};

/** Keeps a trailing `:<reason>` a urn-shaped signer swallowed, so the failure stays legible. The
 * reason is kept on any urn, trust failure or not; only the closed set of reason words survives. */
function aliasIdentifier(match: string): string {
  const dot = match.endsWith(".") ? "." : "";
  const body = dot === "" ? match : match.slice(0, -1);
  const colon = body.lastIndexOf(":");
  const reason = body.slice(colon + 1);
  return colon > 0 && Object.hasOwn(TRUST_FAILURE_REASONS, reason)
    ? `${IDENTIFIER_ALIAS}:${reason}${dot}`
    : `${IDENTIFIER_ALIAS}${dot}`;
}

/** Removes only Jinn's unresolvable protocol namespaces, preserving actionable outside URLs. */
function withoutInternalProtocolIdentifiers(message: string): string {
  return rewriteInternalProtocolIdentifiers(message, aliasIdentifier);
}

/** Refusal details keep raw identifiers in `--json`; the human error surface aliases them. */
function withoutHumanIdentifiers(message: string): string {
  return withoutInternalProtocolIdentifiers(message).replace(RAW_IDENTIFIER, aliasIdentifier);
}

/**
 * Refusals that embed a publisher-chosen name, which the schema constrains to a non-empty string
 * and nothing more, so the name is aliased by the fixed wording around it. Tied to `verify.ts`:
 * `publicKey`'s two messages for `trust.evaluators.<name>`, the two admission reviewer refusals,
 * and the evaluator keyId refusal. A name may hold any character, line breaks and suffix text
 * included, so it runs from the first prefix to the LAST suffix after it.
 */
const PUBLISHER_NAMED = [
  { prefix: "evaluator ", suffixes: [" keyId is not derived from its SPKI"] },
  { prefix: "reviewer ", suffixes: [" has no signer key id", " uses more than one key"] },
  { prefix: "trust.evaluators.", suffixes: [" is not a valid SPKI public key", " is not an Ed25519 public key"] },
] as const;

const WORD_CHARACTER = /\w/u;

/**
 * Replaces everything between the first `prefix` at a word boundary and the last following suffix.
 * `refuse` throws one message per refusal, so a message holds at most one instance of a template;
 * ending at the last suffix over-redacts at worst, never leaks. Each search is one linear scan.
 */
function aliasPublisherNames(text: string, prefix: string, suffixes: readonly string[]): string {
  let start = text.indexOf(prefix);
  while (start > 0 && WORD_CHARACTER.test(text[start - 1]!)) start = text.indexOf(prefix, start + 1);
  if (start < 0) return text;
  const nameStart = start + prefix.length;
  const end = Math.max(...suffixes.map((suffix) => text.lastIndexOf(suffix)));
  // A suffix that starts at `nameStart` would leave the name empty, which the schema rules out.
  if (end <= nameStart) return text;
  return `${text.slice(0, nameStart)}${IDENTIFIER_ALIAS}${text.slice(end)}`;
}

/** A field path a refusal leads with (`screeningTable.rows`, `resolutions.0.reviews.1.packet`). It
 * holds no space, so no publisher prose can stand in for one. */
const FIELD_PATH = String.raw`[A-Za-z][\w-]*(?:\.[\w-]+|\[\d+\])*`;

/** A rule for an admission replay refusal: the replay's lead and the field paths it prefixes are
 * kept as written (`$1`), and `tail`, the refusing module's fixed words, is reworded. */
function admissionRefusal(tail: string, wording: string): readonly [RegExp, string] {
  return [new RegExp(`^((?:binary admission replay failed: )?(?:${FIELD_PATH}: )+)${tail}$`, "u"), `$1${wording}`];
}

/** A code or check label a platform refusal leads with (`binary-record-malformed`): no space. */
const LABEL = String.raw`[a-z]+(?:-[a-z]+)*`;

/** A platform method-input refusal as the result's recomputation carries it:
 * `report-recompute: MethodInputError: <code>: <record>: `. */
const METHOD_INPUT = String.raw`report-recompute: MethodInputError: ${LABEL}: \S+: `;

/** A rule for a method-input refusal: the lead, the code and the record are kept as written
 * (`$1`), and `tail`, the platform module's fixed words, is reworded. */
function methodInputRefusal(tail: string, wording: string): readonly [RegExp, string] {
  return [new RegExp(`^(${METHOD_INPUT})${tail}$`, "u"), `$1${wording}`];
}

/** The same for the binary-instrument reduction: `report-recompute: BinaryInstrumentReductionError: <code>: `. */
function reductionRefusal(tail: string, wording: string): readonly [RegExp, string] {
  return [new RegExp(`^(report-recompute: BinaryInstrumentReductionError: ${LABEL}: )${tail}$`, "u"), `$1${wording}`];
}

/**
 * A rule for one item of a list a refusal joins with `; ` (a validation's issues, a parse failure's
 * issues), reworded wherever it appears in the list, as often as it appears. The first match must
 * start the message with `lead`; each later one must start where the one before ended (`y`), at the
 * `; ` after it, so the rule rewrites only inside a list a message starts with. The items between
 * (`$2`) are kept as written, and the item's own captures start at `$3`. An item holds no `;`, so the
 * matches together scan the message once.
 */
function listItem(lead: string, item: string, wording: string): readonly [RegExp, string] {
  return [new RegExp(`(^${lead}|(?<=.); )((?:[^;]*; )*?)${item}(?=; |$)`, "guy"), `$1$2${wording}`];
}

/**
 * The reader-facing vocabulary spec's refusal-lines row (section 4.2, #5251): the human line names
 * each concept by its section 5 name, while `--json` keeps the refusing module's `message` byte for
 * byte, because the conformance kit's `expectedMessagePattern` pins it. So the words change here,
 * on the human line only, after publisher-chosen names are aliased. Every rule is anchored at the
 * start of the message, so it rewrites the refusing module's fixed wording and never text a
 * publisher chose. The two admission-reviewer rules start from the review path the admission replay
 * prefixes (`resolutions.<n>.reviews.<n>: ` or `replacementLedger.entries.<n>.reviews.<n>: `,
 * optionally after `binary admission replay failed: `). Paths, fingerprints, identifiers and check
 * labels (`matrix-rederivation:`) are printed as written. Applied in order: the timestamp-proof lead
 * is renamed before its reasons, and a label (`sealed Report: `, `claim package: `) before the
 * rules that read what follows it.
 *
 * The rules below the `Issue #5299` comment rule the refusal templates the characterization suite
 * does not reach. The glossary conformance test reads every template the reader's modules write,
 * from their source, and fails on one whose human line still carries a word section 5 hides or
 * renames unless a rule here rewords it or the test records why it stays. The admission replay's
 * rules (`admissionRefusal`) start from the field paths the replay prefixes, which hold no space,
 * and a rule that leads with a run's `cellKey` starts from the fingerprint that opens it.
 *
 * The rules below the `Issue #5373` comment do the same for text the `@jinn-network/*` platform
 * packages write and for the check package's own schema issue messages, where the inventory reaches
 * a refusal line with them. The platform packages' messages are not edited: their words are contract
 * in `--json` and in the errors their callers catch, so the reader rewords them here, at its own
 * boundary. A rule for a method input or the binary reduction starts from the lead the result's
 * recomputation prints (`methodInputRefusal`, `reductionRefusal`), and a rule for one item of a list
 * a refusal joins with `; ` (`listItem`) rewords that item wherever it stands, but only inside a
 * list the message starts with.
 */
const READER_WORDING: readonly (readonly [RegExp, string])[] = [
  [/^Matrix v2 failed deterministic assembly-3\.0 replay$/u,
    "the runs do not follow from a deterministic assembly-3.0 replay of the evidence"],
  [/^carried anchor is invalid: /u, "carried timestamp proof is invalid: "],
  [/^(carried timestamp proof is invalid: )the anchored digest ([0-9a-f]{64}) is neither this bundle's sealed Run nor its sealed Matrix$/u,
    "$1the fingerprint it covers, $2, is neither this bundle's sealed run.json nor its sealed matrix.json"],
  [/^(carried timestamp proof is invalid: subject\.kind is [\s\S]*), but its digest resolves to this bundle's sealed Run$/u,
    "$1, but the fingerprint it covers is this bundle's sealed run.json"],
  [/^(carried timestamp proof is invalid: subject\.kind is [\s\S]*), but its digest resolves to this bundle's sealed Matrix$/u,
    "$1, but the fingerprint it covers is this bundle's sealed matrix.json"],
  [/^(carried timestamp proof is invalid: )an authority-time lock anchor carries no comparable genTime$/u,
    "$1an authority-time lock timestamp proof carries no comparable genTime"],
  [/^(carried timestamp proof is invalid: )no proof verifier implements the anchor profile /u,
    "$1no proof verifier implements the profile "],
  [/^anchor record digest mismatch$/u, "timestamp proof fingerprint mismatch"],
  [/^evidence record digest mismatch$/u, "evidence file fingerprint mismatch"],
  [/^digest mismatch for ("[\s\S]*")$/u, "fingerprint mismatch for $1"],
  [/^matrix-rederivation: re-derived digest /u, "matrix-rederivation: re-derived fingerprint "],
  [/^verdict catalog does not match Matrix verdict closure$/u,
    "verdicts.json does not list exactly the verdicts the runs reference"],
  [/^verdict ([0-9a-f]{64}) evaluator mismatch$/u, "verdict $1 judge mismatch"],
  [/^evaluator trust set must exactly equal Matrix-referenced evaluators$/u,
    "the trusted judges must be exactly the judges the runs reference"],
  [/^evaluator <identifier: see --json> keyId is not derived from its SPKI$/u,
    "judge <identifier: see --json> keyId is not derived from its SPKI"],
  [/^((?:binary admission replay failed: )?(?:resolutions|replacementLedger\.entries)\.\d+\.reviews\.\d+: )?reviewer signature or evaluator\/key binding is invalid$/u,
    "$1reviewer signature or judge/key binding is invalid"],
  [/^((?:binary admission replay failed: )?(?:resolutions|replacementLedger\.entries)\.\d+\.reviews\.\d+: )?review verdict must be one Result Evaluation envelope with one signature$/u,
    "$1review verdict must be one DSSE-signed Result Evaluation with one signature"],
  [/^report-envelope: invalid DSSE envelope: (?:TrustCoreError: )?(?:DSSE envelope )?/u,
    "report-envelope: the signed result is not valid DSSE: "],
  [/^Report author\/keyId\/didKey are not derived from the bundled Report SPKI$/u,
    "the result's author/keyId/didKey are not derived from its bundled signing SPKI"],
  [/^report-recompute: recomputed results do not match the sealed Report results$/u,
    "report-recompute: the recomputed result does not match the sealed result"],
  [/^claim package ([\s\S]+) is not the exact projection of verified facts$/u,
    "the claim's field $1 does not agree with the records here"],

  // Issue #5299. Labels first: the page builder names the record it reads, the claim builder itself.
  [/^sealed Report: /u, "report.json: "],
  [/^stored claim package: /u, "claim-package.json: "],
  [/^claim package: /u, "the claim: "],
  [/^((?:report|claim-package)\.json: )method ("[\s\S]*") has no bundle-asset projection$/u,
    "$1method $2 has no presentation on the bundle's pages"],
  [/^((?:report|claim-package)\.json: |the claim: )expected exactly one (?:Report )?subject \(this product's single-Matrix Report shape\)$/u,
    "$1expected results over exactly one matrix.json (this product's shape)"],
  [/^((?:report|claim-package)\.json: )arm ([\s\S]+) lacks exact wilson@1 facts$/u, "$1configuration $2 lacks exact wilson@1 facts"],
  [/^the claim: Report results do not carry /u, "the claim: the result does not carry "],
  [/^the claim: method ("[\s\S]*") has no claim-package projection$/u, "the claim: no claim can be derived for method $1"],
  [/^the claim: only the anchored binary-qualification closure carries a disclosure section — this projection has no qualification, and no other closure version expresses one$/u,
    "the claim: only the anchored binary-qualification closure carries a section on what was pinned — this claim has no qualification, and no other closure version expresses one"],

  // The admission replay.
  admissionRefusal("record digest is not canonical sha256", "record fingerprint is not in canonical form"),
  admissionRefusal("authority evidence is not an exact compact DSSE envelope", "authority evidence is not exact compact DSSE"),
  admissionRefusal("review verdict is not an exact compact DSSE envelope", "review verdict is not exact compact DSSE"),
  admissionRefusal(String.raw`v2 table must cover all (\d+) pool item digests in sorted order`,
    "v2 table must cover all $2 pool item fingerprints in sorted order"),
  admissionRefusal("reviewers must have distinct evaluator identities and keys", "reviewers must have distinct judge identities and keys"),
  admissionRefusal("roster does not bind the exact reviewer evaluator/key pairs", "roster does not bind the exact reviewer judge/key pairs"),
  admissionRefusal("two-human ledger entry is missing its required review evidence digests",
    "two-human ledger entry is missing its required review evidence fingerprints"),

  // Timestamp proofs, as the claim's anchors are projected.
  [/^anchor record is not the exact sealed encoding of a conforming AnchorEvidence: /u,
    "the timestamp proof is not the exact sealed encoding of a conforming AnchorEvidence: "],
  [/^anchor covers ((?:sha256:)?[0-9a-f]{64}), which is neither this bundle's sealed Run nor its sealed Matrix$/u,
    "the timestamp proof covers $1, which is neither this bundle's sealed run.json nor its sealed matrix.json"],
  [/^anchor names subject kind ([\s\S]+), but the record its digest resolves to is ([\s\S]+)$/u,
    "the timestamp proof's subject.kind is $1, but the record it covers is $2"],
  [/^no proof verifier implements the anchor profile /u, "no proof verifier implements the profile "],

  // Fingerprints.
  [/^(Task|solve output) has an invalid digest$/u, "$1 has an invalid fingerprint"],
  [/^((?:binary|[0-9a-f]{64}\/[\s\S]+\/\d+) Task has no EvaluationSpec )digest$/u, "$1fingerprint"],
  [/^([0-9a-f]{64}\/[\s\S]+\/\d+ final solve Submission )digest disagrees$/u, "$1fingerprint disagrees"],

  // Runs (a Matrix cell).
  [/^comparison cell ([\s\S]+) (is absent from the verified assembly|names an unknown Task)$/u, "comparison run $1 $2"],
  [/^assembly does not cover every expected cell$/u, "assembly does not cover every expected run"],
  [/^((?:solve|evaluation) (?:Submission|Delivery) (?:sha256:)?[0-9a-f]{64} names an unknown )cell$/u, "$1run"],
  [/^(solve (?:Submission|Delivery) (?:sha256:)?[0-9a-f]{64} (?:dispatch is outside its|is outside its exact) )cell( lineage)$/u, "$1run$2"],
  [/^(solve Delivery (?:sha256:)?[0-9a-f]{64} does not bind its )cell( Task\/attempt)$/u, "$1run's$2"],
  [/^(evaluation Submission (?:sha256:)?[0-9a-f]{64} is outside its )cell\/evaluator( domain)$/u, "$1run/judge$2"],
  [/^evaluation graph names an unknown cell$/u, "evaluation graph names an unknown run"],
  [/^terminal evaluation is outside its exact cell\/index lineage$/u, "terminal evaluation is outside its exact run/index lineage"],
  [/^evaluation graph contains a successful lineage not consumed by an exact cell verdict$/u,
    "evaluation graph contains a successful lineage not consumed by an exact run verdict"],
  [/^verdict ((?:sha256:)?[0-9a-f]{64}) cell references do not match Matrix$/u, "verdict $1 run references do not match matrix.json"],
  [/^external-import\.json names a cellKey more than once$/u, "external-import.json names a run more than once"],
  [/^external-import\.json rows are not exactly the sealed Matrix cell keys$/u,
    "external-import.json rows are not exactly the runs in the sealed matrix.json"],
  [/^separate Inspect assurance contains an embedded Matrix vote$/u, "separate Inspect assurance contains an embedded vote on the runs"],

  // Configurations (an arm).
  [/^qualification does not exactly cover the Run arm set$/u, "qualification does not exactly cover the sealed Run's configurations"],
  [/^Run arm ([\s\S]+) instrument pin differs$/u, "Run configuration $1 judge pin differs"],
  [/^Run arm ([\s\S]+) has no exact judge-instrument pin$/u, "Run configuration $1 has no exact judge pin"],
  [/^binary runtime selection arms differ from qualification and Run pins$/u,
    "binary runtime selection configurations differ from qualification and Run pins"],
  [/^snapshot-serving probe model is not the model of any bound arm$/u,
    "snapshot-serving probe model is not the model of any bound configuration"],
  [/^Inspect Delivery has no exact selected arm configuration$/u, "Inspect Delivery has no exact selected configuration"],
  [/^credential-free Inspect arm carries provider evidence$/u, "credential-free Inspect configuration carries provider evidence"],
  [/^Inspect provider evidence differs from the sealed arm\/runtime selection$/u,
    "Inspect provider evidence differs from the sealed configuration/runtime selection"],
  [/^the screening instrument is reused as a run judge arm$/u, "the screening instrument is reused as a run judge configuration"],

  // Judges (an instrument or evaluator).
  [/^instrument ((?:sha256:)?[0-9a-f]{64}) is (missing$|invalid: )/u, "judge $1 is $2"],
  [/^instrument is not exact canonical profile bytes$/u, "the judge record is not exact canonical profile bytes"],
  [/^same-execution Inspect score carries false separate-evaluator lineage$/u,
    "same-execution Inspect score carries false separate-judge lineage"],
  [/^pre-evaluation terminal cannot claim an evaluator identity$/u, "pre-evaluation terminal cannot claim a judge identity"],
  [/^partial evaluation lineage must name its evaluator and exact Task$/u, "partial evaluation lineage must name its judge and exact Task"],

  // The result (a Report) and its limitations.
  [/^a Report carrying /u, "a result carrying "],
  [/^(bundle format [\s\S]+ declares a (?:non-)?qualifying closure, but its sealed )Report( declares method [\s\S]+)$/u,
    "$1report.json$2"],
  [/^(a \S+(?: "[^"\s]+")? bundle must carry \S+ on its )Report$/u, "$1report.json"],
  [/^the bundle does not carry the disclosure-specification record its Report names$/u,
    "the bundle does not carry the disclosure-specification record its report.json names"],
  [/^verified Report payload does not match report\.json$/u, "the verified result's payload does not match report.json"],
  [/^verified Report identity is absent$/u, "the verified result's identity is absent"],
  [/^report trust keyId must equal didKey$/u, "the result's signing keyId must equal its didKey"],
  [/^Report limitations carry the /u, "the result's limitations carry the "],
  [/^Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history$/u,
    "the result's limitations are not exactly the ones derived from the sealed Run and rehearsal history"],
  [/^claim rehearsal and verified Report disclosure disagree$/u, "the claim's rehearsal and the verified result's limitations disagree"],
  [/^(a bundle declaring owner-controlled-publication must seal the publication-source sentence in its )Report limitations, right after the venue sentences$/u,
    "$1result's limitations, right after the sentences on where it ran"],
  [/^(a bundle declaring terminal-bench-2-1-comparability must seal the comparability sentence once in its )Report limitations, right after the venue and binary-instrument lines$/u,
    "$1result's limitations, right after the lines on where it ran and the binary-instrument lines"],
  [/^(the sealed Run declares task selection "[\s\S]*", but this bundle does not declare the "task-selection" capability that states it on )the report face(; a bundle cannot pass while hiding who chose its tasks)$/u,
    "$1the bundle's pages$2"],

  // Records a module names by a hidden noun: the catalog, a projection, an envelope, a declaration.
  [/^the bundle's evidence catalog (does not match the pinned v4 grammar|assigns no freeze-artifact role)$/u, "the bundle's evidence.json $1"],
  [/^evidence catalog contains missing or unreachable records$/u, "evidence.json lists missing or unreachable records"],
  [/^EvaluationSpec ((?:sha256:)?[0-9a-f]{64}) is not in the catalog$/u,
    "EvaluationSpec $1 is not among the EvaluationSpecs read for the runs' Tasks"],
  [/^static bundle is not the exact platform metadata projection$/u,
    "static-bundle.json is not exactly the platform metadata derived from matrix.json and report.json"],
  [/^qualification admission projection differs from portable replay$/u, "qualification.json's admission fields differ from the portable replay"],
  [/^(a \S+ bundle's )qualification document must keep its frozen (\S+) projection literal$/u,
    "$1qualification.json must keep claimSchema at its frozen $2 value"],
  [/^(\S+) is not the exact projection of verified public facts$/u, "$1 is not exactly the file rebuilt from the verified public facts"],
  [/^claim externalImport section is not the exact projection of the authenticated marker$/u,
    "the claim's externalImport section does not agree with the authenticated marker"],
  [/^Inspect summary measurement count differs from the sealed projections$/u,
    "Inspect summary measurement count differs from the sealed scoring.projections"],
  [/^Inspect summary measurement differs from its sealed projection$/u,
    "Inspect summary measurement differs from its sealed scoring.projections entry"],
  [/^Inspect summary differs from its sealed scorer projections$/u, "Inspect summary differs from its sealed scoring.projections"],
  [/^verdict envelope (payloadType|payload) /u, "the signed verdict's $1 "],
  [/^verdict envelope carries /u, "the signed verdict carries "],
  [/^(this bundle declares the "task-selection" capability, but its sealed Run carries no task-selection\/v1) declaration( for it to state)$/u,
    "$1$2"],

  // Issue #5373. Text the platform packages write and the check package's own schema issue
  // messages, where the inventory reaches a refusal line with them: bare, inside the wrapper that
  // carries them (`carried timestamp proof is invalid: `), or as the detail the result's
  // recomputation reports (`report-recompute: <error class>: `). Paths, codes, fingerprints and
  // identifiers are printed as written.

  // DSSE-signed records, as trust-core's decoder refuses them.
  [new RegExp(String.raw`^((?:report-recompute: (?:MethodInputError: ${LABEL}: \S+: )?TrustCoreError: )?)(?:A )?DSSE envelope (must |requires )`, "u"), "$1the DSSE-signed record $2"],
  [new RegExp(String.raw`^((?:report-recompute: (?:MethodInputError: ${LABEL}: \S+: )?TrustCoreError: )?)DSSE envelope (payloadType |payload |signature |bytes )`, "u"), "$1the DSSE-signed record's $2"],
  [/^(report-envelope: the signed result is not valid DSSE: )A DSSE envelope requires at least one signature\.$/u, "$1it carries no signature."],

  // Timestamp proofs, as trust-core's encoding check and proof verifiers refuse them.
  [/^((?:carried timestamp proof is invalid: not the exact sealed encoding of a conforming AnchorEvidence record|the timestamp proof is not the exact sealed encoding of a conforming AnchorEvidence): )Anchor-evidence bytes /u,
    "$1its bytes "],
  [/^(carried timestamp proof is invalid: (?:ESSCertIDv2\.hashAlgorithm|SignerInfo\.digestAlgorithm) names )digest algorithm /u, "$1hash algorithm "],
  [/^(carried timestamp proof is invalid: RSASSA-PSS carries no parameters, so its )digest( defaults to SHA-1 )/u, "$1hash$2"],
  [/^(carried timestamp proof is invalid: The file )digest( operation is )/u, "$1hash$2"],
  [/^(carried timestamp proof is invalid: The messageDigest attribute is not the )digest( of eContent )/u, "$1hash$2"],
  [/^(carried timestamp proof is invalid: TSTInfo\.tsa is not among the )signer certificate's subject names /u,
    "$1names the signer certificate is issued to "],
  [/^(carried timestamp proof is invalid: The proof is detached from \S+, not from )the subject /u, "$1the covered record's fingerprint "],
  [/^(carried timestamp proof is invalid: )The subject digest is not 64 hex characters\.$/u, "$1The covered record's fingerprint is not 64 hex characters."],
  [/^(carried timestamp proof is invalid: messageImprint\.hashAlgorithm is \S+; )the caller's subject digest is a SHA-256( and cannot be compared to it )/u,
    "$1the covered record's fingerprint is a SHA-256 hash$2"],
  [/^(carried timestamp proof is invalid: messageImprint\.hashedMessage is not )the subject digest /u, "$1the covered record's fingerprint "],

  // A run's key and the expected runs, as the records package reads them.
  [/^(malformed cellKey )task digest( \(must be 64 lowercase hex digits\): )/u, "$1task fingerprint$2"],
  [/^(malformed cellKey )replicate( \(must be )/u, "$1repeat$2"],
  [/^expected cell set exceeds MAX_MATERIALIZED_CELLS \((\S+?)\): /u, "the expected set of runs exceeds the cap of $1 runs: "],
  [/^expected cell cardinality exceeds (Number\.MAX_SAFE_INTEGER: )/u, "the expected number of runs exceeds $1"],
  [/^(Benchmark item's task descriptor lacks )a sha256 digest( \(schema invariant violated\))$/u, "$1a fingerprint$2"],

  // Evidence-native bundles (`claim-package/3`), as the evidence package checks them.
  [/^(\S+) digest does not match its exact descriptor$/u, "$1 fingerprint does not match its exact descriptor"],
  [/^claim-package\/3 evidence closure differs from records\/$/u, "the claim's evidence closure differs from records/"],
  [/^claim-package\/3 is inconsistent with the exact evidence-native chain$/u, "the claim is inconsistent with the exact evidence-native chain"],
  [/^report\.json differs from the signed Report v3 payload$/u, "report.json differs from the signed v3 result's payload"],
  [/^Report v3 signature is invalid or unbound$/u, "the v3 result's signature is invalid or unbound"],
  [/^Report v3 envelope has the wrong payload type$/u, "the signed v3 result has the wrong payload type"],
  [/^Report v2 must subject the exact Matrix v2 bytes$/u, "the v2 result must name the exact v2 matrix.json bytes as its input"],

  // The runs re-derived, and the run checks, as the run package reports them.
  [/^(matrix-rederivation: )exact matrix bytes are required for verifyMatrix$/u, "$1the exact bytes of matrix.json are required for verifyMatrix"],
  [/^(matrix-rederivation: )re-derived matrix bytes diverge (at offset \d+|in length)$/u,
    "$1the runs re-derived from the evidence diverge from matrix.json $2"],
  [/^(evaluator-independence: )evaluator Agent IRI is not distinct from solver$/u, "$1judge Agent IRI is not distinct from solver"],
  [/^(evaluator-independence: )solver or evaluator unresolved \(fail-closed\)$/u, "$1solver or judge unresolved (fail-closed)"],
  [/^(verdict-spec-match: verdict lacks a )digest-shaped evaluationSpecification and task has no pinned digest$/u,
    "$1fingerprint-shaped evaluationSpecification and task has no pinned fingerprint"],

  // The result, as the aggregate package verifies and recomputes it.
  [/^(report-authenticity: )Report envelope has no signer keyid to bind to author$/u, "$1the signed result has no signer keyid to bind to author"],
  [/^(report-envelope: )Report payload bytes are not the exact canonical encoding$/u, "$1the result's payload bytes are not the exact canonical encoding"],
  [/^(report-envelope: )invalid Report payload: /u, "$1invalid result payload: "],
  [/^(report-recompute: )exact subject bytes\/order do not match the sealed Report subjects$/u,
    "$1the exact matrix.json bytes, in order, do not match the runs the sealed result names"],
  [/^(disclosures-faithfulness: )recomputed per-subject disclosures do not match the exact subject bytes\/order$/u,
    "$1what was pinned, recomputed from the exact matrix.json bytes in order, does not match the sealed result"],
  [/^((?:report-recompute|disclosures-faithfulness): Error: )subject (\S+) is not a valid Matrix: /u, "$1matrix.json $2 is not valid: "],
  [/^((?:report-recompute|disclosures-faithfulness): Error: )subject (\S+) is not the exact canonical Matrix encoding$/u,
    "$1matrix.json $2 is not in exact canonical encoding"],
  [/^(benchmark-comparability: )subjects resolve to distinct Benchmark digests: /u, "$1the result's runs resolve to distinct Benchmark fingerprints: "],
  [/^(benchmark-comparability: version-robust result does not disclose exact paired Task )digests$/u, "$1fingerprints"],
  [/^(benchmark-comparability: version-robust cross-Benchmark result has no exact shared Task-)digest( pairing)$/u, "$1fingerprint$2"],
  [/^(benchmark-comparability: version-robust cross-Benchmark results must disclose one identical Task-)digest pairing per subject$/u,
    "$1fingerprint pairing for each set of runs"],
  [/^(benchmark-comparability: version-robust pairing includes a Task )digest not shared by every subject$/u,
    "$1fingerprint not shared by every set of runs"],
  [/^(report-recompute: Error: method subjectSha256 is not an exact )lowercase sha256: /u, "$1fingerprint in lowercase hex: "],
  [/^(report-recompute: Error: method subjectSha256 \S+ does not match )canonical Matrix digest /u, "$1the canonical matrix.json fingerprint "],
  [/^(report-recompute: Error: )method subject identity is duplicated: /u, "$1the method is given the same matrix.json twice: "],
  [/^(report-recompute: Error: clean-subset@1: delegate did not preserve the )restricted subject identity$/u, "$1identity of the restricted runs"],
  [new RegExp(String.raw`^(report-recompute: (?:MethodInputError: ${LABEL}: \S+: )?Error: entry previous must be null or an exact )lowercase sha256 digest$`, "u"), "$1fingerprint in lowercase hex"],
  [new RegExp(String.raw`^(report-recompute: (?:MethodInputError: ${LABEL}: \S+: )?Error: signed entry does not announce the requested Benchmark )digest$`, "u"), "$1fingerprint"],
  [/^(report-recompute: Error: )instrument arm ids must be unique$/u, "$1the judges' configuration ids must be unique"],
  [/^(report-recompute: Error: )invalid instrument digest for /u, "$1invalid judge fingerprint for configuration "],
  listItem(String.raw`report-recompute: (?:Error: )?invalid (?:\S+ )?parameters: `,
    `parameters "baseline" and "candidate" must name distinct arms`, `parameters "baseline" and "candidate" must name distinct configurations`),
  listItem(String.raw`(?:report|claim-package)\.json: invalid binary qualification: `,
    "qualification cell keys must be unique across item groups", "qualification runs must be unique across item groups"),
  listItem(String.raw`(?:report|claim-package)\.json: invalid binary qualification: `,
    String.raw`qualification task (\S+) must carry exactly one group for every arm`, "qualification task $3 must carry exactly one group for every configuration"),
  listItem(String.raw`(?:report|claim-package)\.json: invalid binary qualification: `,
    String.raw`qualification\.arms must bind distinct instruments per arm`, "qualification.arms must bind a distinct judge for each configuration"),
  listItem(String.raw`(?:report|claim-package)\.json: invalid binary qualification: `,
    String.raw`qualification\.arms must contain two or more arms`, "qualification.arms must contain two or more configurations"),
  listItem(String.raw`(?:report|claim-package)\.json: invalid binary qualification: `,
    String.raw`qualification\.conflicted contains an unknown cell key`, "qualification.conflicted contains an unknown run"),

  // Method inputs, as the binary-instrument method resolves them for the recomputation.
  methodInputRefusal("resolver returned no exact signed Discovery Entry envelope bytes", "resolver returned no exact DSSE-signed Discovery Entry bytes"),
  methodInputRefusal("verification proof does not bind the exact source, entry chain, head anchor, and derived time",
    "verification proof does not bind the exact source, entry chain, timestamp proof of the head, and derived time"),
  methodInputRefusal("Result Evaluation does not bind the exact Matrix Task", "Result Evaluation does not bind the exact Task its run names"),
  methodInputRefusal("parser-invalid output does not match the sealed instrument policy",
    "the decision on an answer that could not be read does not match the sealed judge record's policy"),
  methodInputRefusal("signed instrument drifts from the Run arm pin", "the signed judge drifts from the Run configuration's judge pin"),
  methodInputRefusal(String.raw`sole Result Evaluation is reused across Matrix cells (\S+) and (\S+)`, "sole Result Evaluation is reused across runs $2 and $3"),
  methodInputRefusal("EvaluationSpec drifts from the frozen binary evaluator contract", "EvaluationSpec drifts from the frozen binary judge contract"),
  methodInputRefusal("EvaluationSpec grader digest is not the frozen binary evaluator semantics",
    "EvaluationSpec grader fingerprint is not the frozen binary judge semantics"),
  methodInputRefusal("Run arms do not exactly cover Matrix arms", "the sealed Run's configurations do not exactly cover matrix.json's configurations"),
  methodInputRefusal("Task must remain arm-neutral and cannot pin an instrument", "Task must remain configuration-neutral and cannot pin a judge"),
  methodInputRefusal("binary-instrument@1 requires distinct instruments across arms", "binary-instrument@1 requires a distinct judge for each configuration"),
  methodInputRefusal("binary-instrument@1 requires two or more matching, distinct Run and Matrix arms",
    "binary-instrument@1 requires two or more distinct configurations, matching between the sealed Run and matrix.json"),
  methodInputRefusal("judge observation drifts from its exact Matrix cell or semantic request", "judge observation drifts from its exact run or semantic request"),
  methodInputRefusal("judge observation limitations are not the frozen per-profile disclosure",
    "judge observation limitations are not the frozen per-profile limitations"),
  methodInputRefusal("judge observation cannot resolve its instrument's declared model", "judge observation cannot resolve its judge record's declared model"),
  methodInputRefusal(String.raw`instrument generation drifts from the frozen (\S+) call policy`, "the judge record's generation drifts from the frozen $2 call policy"),
  methodInputRefusal("instrument identity does not match the Run arm", "the judge record's identity does not match its Run configuration"),
  methodInputRefusal(String.raw`instrument prompt digest does not match its message templates`, "the judge record's prompt fingerprint does not match its message templates"),
  [new RegExp(String.raw`^(${METHOD_INPUT})instrument (?=has |must )`, "u"), "$1the judge record "],
  [new RegExp(String.raw`^(${METHOD_INPUT})instrument (?=field |generation |literal |message |parser |prompt |response |invalidOutputDecision )`, "u"),
    "$1the judge record's "],
  [new RegExp(String.raw`^(${METHOD_INPUT})arm (\S+) instrument (?=bytes |requires |is not |must be |is outside )`, "u"), "$1configuration $2's judge record "],
  [new RegExp(String.raw`^(${METHOD_INPUT})Run arm (\S+) instrument pin (?=must be )`, "u"), "$1Run configuration $2's judge pin "],
  [new RegExp(String.raw`^(${METHOD_INPUT})analysis-context\.json digest (?=must carry |has an unsupported )`, "u"), "$1analysis-context.json's fingerprint field "],
  [new RegExp(String.raw`^(${METHOD_INPUT})invalid DSSE envelope: (?:TrustCoreError: )?(?:A )?(?:DSSE envelope )?`, "u"), "$1not valid DSSE: "],
  methodInputRefusal(String.raw`([^:]+?) must carry one lowercase sha256 digest`, "$2 must carry one fingerprint in lowercase hex"),
  methodInputRefusal(String.raw`([^:]+?) must carry one exact lowercase sha256 digest`, "$2 must carry one exact fingerprint in lowercase hex"),
  methodInputRefusal(String.raw`(\S+) must be a strictly sorted unique pair of sha256 digests`, "$2 must be a strictly sorted unique pair of fingerprints"),

  // The binary-instrument reduction, as the recomputation reports it.
  reductionRefusal("contexts must name every and only Matrix Task exactly once", "contexts must name every and only Task in matrix.json exactly once"),
  reductionRefusal(String.raw`Matrix repeats (\S+)`, "matrix.json repeats $2"),
  reductionRefusal(String.raw`Matrix is not the exact task x arm x 1\.\.(\S+) cell set`, "matrix.json is not the exact task x configuration x 1..$2 set of runs"),
  reductionRefusal(String.raw`(\S+) does not carry arm (\S+)'s expected instrument`, "$2 does not carry configuration $3's expected judge"),
  reductionRefusal(String.raw`duplicate instrument for arm (\S+)`, "duplicate judge for configuration $2"),
  reductionRefusal("instruments must name every and only Matrix arm exactly once", "judges must name every and only configuration in matrix.json exactly once"),
  reductionRefusal("Matrix must contain at least one cell", "matrix.json must contain at least one run"),
  reductionRefusal(String.raw`cell (\S+) without a sole valid verdict carries a parsed evaluation`, "run $2 without a sole valid verdict carries a parsed evaluation"),
  reductionRefusal(String.raw`non-judged cell (\S+) carries a parsed evaluation`, "non-judged run $2 carries a parsed evaluation"),
  reductionRefusal(String.raw`parsed input names non-Matrix cell (\S+)`, "parsed input names $2, a run matrix.json does not carry"),
  reductionRefusal(String.raw`(\S+) parsed (\S+), Matrix names (\S+)`, "$2 parsed $3, matrix.json names $4"),

  // The check package's own schema issue messages, as the admission replay prints a parse failure.
  listItem(String.raw`(?:binary admission replay failed: )?${FIELD_PATH}: `, String.raw`((?:${FIELD_PATH}|\(root\)): )digest references must be sorted and unique`,
    "$3fingerprint references must be sorted and unique"),
];

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/gu;

/** One refusal, one stderr line: aliases publisher names, puts the refusal in the reader's words,
 * aliases identifiers, then escapes every control character (line feeds included), so a
 * publisher-chosen string cannot forge a line of its own. */
function humanRefusalDetail(message: string): string {
  const named = PUBLISHER_NAMED.reduce(
    (text, { prefix, suffixes }) => aliasPublisherNames(text, prefix, suffixes),
    message,
  );
  const worded = READER_WORDING.reduce((text, [pattern, wording]) => text.replace(pattern, wording), named);
  return withoutHumanIdentifiers(worded)
    .replace(CONTROL_CHARACTER, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * What this tool does to the platform bytes, stated identically wherever it is stated. The verdict
 * surface said one thing and the usage block another -- "Verification uses …", the noun #2982 ruled
 * overclaims -- because the sentence was written twice (issue #3675).
 */
const PLATFORM_BYTES_SENTENCE = "Checks run against the exact platform bytes installed from npm." as const;

/**
 * The host gap, stated without handing a reader an unresolvable origin to visit. Identifiers the
 * spec release serves resolve and print whole; only the rest are names (issue #4894).
 */
const IDENTIFIER_DISCLOSURE =
  "Protocol identifiers the protocol spec release serves resolve to their\n"
  + "documents; the rest are names, not addresses. This verifier fetches nothing\n"
  + `from them. ${PLATFORM_BYTES_SENTENCE}`;

function usage(): string {
  return "Usage: colophon-check <bundle> [--json] [--tsa-root <file>]... [--ots-headers <file>]...\n"
    + "                        [--freeze-repo <dir>] [--identity-binding <file>]\n"
    + "  --tsa-root     RFC 3161 trust anchor, DER or PEM. Repeatable.\n"
    + "  --ots-headers  Bitcoin block headers, one \"<height>:<80-byte-hex>\" per line. Repeatable.\n"
    + "  --freeze-repo  Also check that this published freeze-artifact repository is exactly what\n"
    + "                 the bundle renders. The repository is a derived artifact, never the claim\n"
    + "                 of record; a drifted tree exits 1.\n"
    + "  --identity-binding  A colophon-domain-binding/1 document binding one of this bundle's\n"
    + "                 signing keys to a domain. Checked offline as far as the bytes allow;\n"
    + "                 the lookup at the domain itself stays yours.\n"
    + "  --help, -h     Print this usage and exit 0.\n"
    + "Trust anchors and block headers are yours, not the bundle's: with none supplied\n"
    + "for its time source, a well-formed timestamp proof reports present rather than\n"
    + "verified, and none ships with this tool.\n"
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

/** What a reader supplies to evaluate each time source, in the usage text's words for the flag that
 * carries it: trust anchors (`--tsa-root`) for an authority-time proof, block headers
 * (`--ots-headers`) for a chain-time one. Whether material was supplied is decided per profile
 * (`evaluateAnchors`), and on a `verified` or `present` proof the time basis names the profile, so
 * a note naming the other material would tell a reader who supplied a root that none was supplied,
 * and point a chain-time proof at the wrong flag (spec §4.2, v1.16; issue #5253). Keyed by the
 * time-basis union, so a new basis fails to compile here rather than inheriting a name. */
const TIME_SOURCE_MATERIAL: Readonly<Record<NonNullable<AnchorVerificationEntry["timeBasis"]>, string>> = {
  "authority-time": "trust anchors",
  "chain-time": "block headers",
};

function timeSourceMaterial(entry: AnchorVerificationEntry): string {
  // `evaluateAnchors` gives every `verified` and `present` entry a time basis. Without one, the note
  // keeps the usage text's general word.
  return entry.timeBasis === undefined ? "trust anchors" : TIME_SOURCE_MATERIAL[entry.timeBasis];
}

/** What THIS reader did about the time basis, stated separately from what the bytes say. §8: the
 * verifier's own report always adds its evaluation — whose material validated the time basis, or
 * that none was supplied. Exported so the product's workspace `verify` prints the same note rather
 * than a copy of it (issue #5241). */
export function timestampProofEvaluationNote(entry: AnchorVerificationEntry): string {
  if (entry.status === "verified") {
    // The evaluated instant is reported only where it adds something the head line does not: for a
    // chain-time proof it is the block's own time, which the height alone never gives.
    const evaluated = entry.time !== undefined && entry.time !== anchoredValue(entry)
      ? ` — ${entry.time}`
      : "";
    return `time source evaluated against ${timeSourceMaterial(entry)} you supplied${evaluated}`;
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
    ? `time source not evaluated: the ${timeSourceMaterial(entry)} you supplied do not verify this timestamp proof`
    : `time source not evaluated: no ${timeSourceMaterial(entry)} supplied`;
}

/** What each record a timestamp proof covers is called in the human lines (spec §4.2, v1.15; issue
 * #5278). `matrix` covers `matrix.json`, which §5 names *the runs* and hides as "Matrix"; `lock`
 * names no §5 concept and prints as written. `--json` and the sealed claim keep the raw subject. */
const TIMESTAMP_SUBJECT_NAMES: Readonly<Record<ClaimAnchorSubject, string>> = { lock: "lock", matrix: "the runs" };

/** Exported so the product's workspace `verify` names each subject as the reader does. */
export function timestampSubjectName(subject: ClaimAnchorSubject): string {
  return TIMESTAMP_SUBJECT_NAMES[subject];
}

function renderAnchor(entry: AnchorVerificationEntry): string {
  const value = anchoredValue(entry);
  const head = [
    `  ${entry.subject === undefined ? "unresolved" : timestampSubjectName(entry.subject)} timestamp proof`,
    entry.timeBasis ?? "unknown time source",
    entry.status,
    ...(value === undefined ? [] : [value]),
  ].join(" · ");
  return `${head}\n    ${timestampProofEvaluationNote(entry)}\n    record ${entry.recordSha256}`;
}

/** Keeps the declared provider's useful profile path while dropping its unresolvable host. */
function anchorProfileName(profile: string): string {
  return /^https?:\/\/[^/]+\/(?:[^/]+\/)*anchor-profiles\/(.+)$/u.exec(profile)?.[1] ?? profile;
}

function renderSubject(subject: AnchorSubjectReport): string {
  const name = timestampSubjectName(subject.subject);
  if (subject.outcome === "declared-but-absent") {
    return `  ${name}: promised but missing — this run promised `
      + `${subject.declaredProfiles?.map(anchorProfileName).join(", ") ?? "a timestamp provider"} and the bundle carries no matching timestamp proof`;
  }
  if (subject.outcome === "absent") return `  ${name}: none — no timestamp proof was carried and none was promised`;
  // Exhaustive over the three coverage outcomes: `anchored` is the only one left. A fourth outcome
  // fails to compile here rather than reading as timestamped, in this report and in the product's
  // workspace `verify`, which prints this block (issue #5313).
  subject.outcome satisfies "anchored";
  return `  ${name}: timestamped`;
}

/** The `Timestamp coverage` block: one line per subject, outcome named as §4.2 rules it. Exported
 * so the product's workspace `verify` prints the same block rather than a copy of it (issue #5241). */
export function renderTimestampCoverage(report: IntegrityAnchorsReport): string {
  return `Timestamp coverage\n${report.subjects.map(renderSubject).join("\n")}`;
}

function renderAnchorReport(report: IntegrityAnchorsReport): string {
  const anchors = report.anchors.length === 0
    ? "  no timestamp proofs carried"
    : report.anchors.map(renderAnchor).join("\n");
  return `\nTimestamps\n${anchors}\n\n${renderTimestampCoverage(report)}\n`;
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
function wrapParagraph(text: string | undefined): string | undefined {
  return text === undefined ? undefined : wrap(text);
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
  "external-import": "the import marker matches the claim",
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
  // The Run digest in the one form the other surfaces print it: `lock` prints `run <64 hex>` and
  // the report page prints the Run SHA-256 the same way, so a reader holds the three against each
  // other as strings. That is why this line is bare hex where `Bundle:` above it carries a
  // `sha256:` prefix. The evidence-native (`/5`) result carries no Run digest, so it prints no
  // line.
  const run = "runSha256" in result && result.runSha256 !== undefined
    ? `\nRun: ${result.runSha256}`
    : "";
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
    : "\nA timestamp proof (anchor) dates the bytes it covers and says nothing else\nabout the run: not that results were produced after it, and not that the\ntimestamping authority is independent of the bundle's owner.";
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
Format: ${result.format}${run}

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
  // Asking for help is not a usage failure: the same text, on stdout, with exit 0 (issue #4955).
  // Checked before parsing so the flag answers wherever it sits, and so `-h` is never taken for
  // the bundle path.
  if (args.includes("--help") || args.includes("-h")) {
    return { exitCode: 0, stdout: withoutHumanIdentifiers(usage()), stderr: "" };
  }
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
      stderr: `colophon-check: ${humanRefusalDetail(cause instanceof Error ? cause.message : String(cause))}\n`,
    };
  }

  let verified: VerifiedPublicBundleSnapshot;
  try {
    verified = await (deps.verify ?? verifyPublicBundleSnapshot)(
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
    const stderr = parsed.json ? "" : `colophon-check: ${humanRefusalDetail(error.message)}\n`;
    return { exitCode: code === "record-integrity" ? 1 : 2, stdout, stderr };
  }

  const result: PublicBundleVerificationResult = verified.verification;

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
      // identity line inseparable: neither exists without a resolved `identity`. The code is
      // `validation` -- the binding's precondition is unmet, nothing collides -- and it is public,
      // since it reaches `--json` output as `identityBinding.code` (issue #4378).
      const publishers = (result.signers ?? []).filter((signer) => signer.role === "publisher");
      if (publishers.length !== 1) {
        refuse(
          "validation",
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
  // that is not an SPDX licence expression, an unreadable repository directory — is not thereby an
  // invalid bundle, and the bundle verdict already computed above is reported either way.
  let freezeRepo: FreezeRepoVerificationResult | undefined;
  let freezeRepoFailure: { readonly code: string; readonly message: string } | undefined;
  if (parsed.freezeRepoDir !== undefined) {
    try {
      freezeRepo = await (deps.freezeRepo ?? verifyFreezeRepoSnapshot)(verified.snapshot, parsed.freezeRepoDir);
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
  // The refusal is worded on its own, so a wording rule reads it from its start as it does a bundle
  // refusal (#5299); the note's lead is fixed text.
  const notes = parsed.json
    ? ""
    : [
      ...(freezeRepoFailure === undefined ? [] : [["freeze repository not checked", freezeRepoFailure.message]]),
      ...(identityFailure === undefined ? [] : [["domain binding not applied", identityFailure.message]]),
    ].map(([lead, message]) => `colophon-check: ${lead}: ${humanRefusalDetail(message)}\n`).join("");
  // A drifted freeze repository is a verdict about the artifact and takes precedence: exit 1 is
  // what the usage text promises for it, and an operational failure on a different flag must not
  // silently re-code that verdict as 2.
  if (freezeRepo !== undefined && !freezeRepo.ok) return { exitCode: 1, stdout, stderr: notes };
  if (freezeRepoFailure !== undefined || identityFailure !== undefined) {
    return { exitCode: 2, stdout, stderr: notes };
  }
  return { exitCode: 0, stdout, stderr: "" };
}
