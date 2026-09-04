// SPDX-License-Identifier: Apache-2.0

/**
 * The deterministic public-repository projection of a sealed bundle's freeze artifacts
 * (issue #2870).
 *
 * Doctrine, matching the Inspect View export (`core/src/operations/inspect-view-export.ts`):
 * the repository is a DERIVED artifact, not the claim of record. The sealed records remain the
 * sole source of truth. What this module adds is that the derivation is a function rather than a
 * hand assembly, so a published tree can be regenerated from the bundle and diffed against it —
 * closing the gap between the stated artifacts and the actual ones.
 *
 * Determinism claim, stated exactly: FOR A GIVEN FORMAT VERSION the rendered tree is a pure
 * function of the bundle bytes. No clock, no locale, no filesystem enumeration order, and no tool
 * version reaches the tree. `FREEZE_REPO_FORMAT` is recorded in `freeze.json`, so a change to this
 * renderer is a visible format bump rather than silent drift.
 *
 * Nothing here writes remotely, uploads, hosts, or registers. `exportFreezeRepo` writes one local
 * directory; `verifyFreezeRepo` reads one.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  BUNDLE_V5_FORMAT,
  BUNDLE_V8_FORMAT,
  SUPPORTED_BUNDLE_FORMATS,
  type SupportedBundleFormat,
  type VerifiedBundleSnapshot,
} from "./manifest.js";
import {
  BUNDLE_FORMAT,
  BUNDLE_V4_FORMAT,
  BUNDLE_V6_FORMAT,
  BUNDLE_V7_FORMAT,
} from "./legacy-closures.js";
import { BundleV4EvidenceCatalogSchema, type BundleV4EvidenceRole } from "./schema.js";
import { BinarySourceManifestEntrySchema, type BinarySourceManifestEntry } from "./admission/intake.js";
import { refuse } from "./profile/errors.js";
import { verifyPublicBundleSnapshot } from "./verify.js";
import type { VerifyPublicBundleDeps } from "./verify.js";

export const FREEZE_REPO_FORMAT = "colophon-freeze-repo/2" as const;

/**
 * What each public-bundle closure means to this projection.
 *
 * `qualification` — the bundle carries the admission/qualification graph, which IS the freeze
 * artifact set, so the export accepts it. `disclosure` — the bundle carries a sealed
 * disclosure-specification record. That record is claim-side: it states the variables that produced
 * the score, and its `disclosure-specification` evidence role is deliberately not in
 * `FREEZE_REPO_ROLES`, so it stays in the bundle a reader verifies rather than entering this tree.
 * It is recorded here only so the generated README can tell a reader of such a bundle where to
 * look for it.
 *
 * A table rather than an inline list of accepted versions (issue #3540). The guard used to name
 * v4 and v7 inline, so `benchmark-product-public-bundle/8` — v7's freeze graph exactly, plus one
 * claim-side record — landed beside it and was refused for its version alone. Keyed by
 * `SupportedBundleFormat`, a new closure version is a type error here until someone states what it
 * means to the freeze projection; `freeze-repo.test.ts` makes the same omission a test failure.
 */
export interface FreezeRepoBundleSupport {
  /** Whether the bundle carries the qualification graph, and therefore whether the export accepts it. */
  readonly qualification: boolean;
  /** Whether the bundle carries a sealed disclosure-specification record. Always claim-side. */
  readonly disclosure: boolean;
}

export const FREEZE_REPO_BUNDLE_SUPPORT: Record<SupportedBundleFormat, FreezeRepoBundleSupport> = {
  [BUNDLE_FORMAT]: { qualification: false, disclosure: false },
  [BUNDLE_V4_FORMAT]: { qualification: true, disclosure: false },
  [BUNDLE_V5_FORMAT]: { qualification: false, disclosure: false },
  [BUNDLE_V6_FORMAT]: { qualification: false, disclosure: false },
  [BUNDLE_V7_FORMAT]: { qualification: true, disclosure: false },
  [BUNDLE_V8_FORMAT]: { qualification: true, disclosure: true },
};

/** The accepted formats, in the order `SUPPORTED_BUNDLE_FORMATS` declares them. */
const FREEZE_REPO_ACCEPTED_FORMATS: readonly SupportedBundleFormat[] = SUPPORTED_BUNDLE_FORMATS
  .filter((format) => FREEZE_REPO_BUNDLE_SUPPORT[format].qualification);

/** `a or b`, `a, b, or c` — the accepted set is now long enough that a chain of `or` reads badly. */
function listAccepted(formats: readonly string[]): string {
  if (formats.length < 3) return formats.join(" or ");
  return `${formats.slice(0, -1).join(", ")}, or ${formats[formats.length - 1]}`;
}

/**
 * The freeze artifacts, as evidence roles. This is the admission/qualification graph — the item
 * bank and its sources, the admission decisions and their ledger, the label resolutions and
 * analysis contexts, the judge instruments (the judge prompts' commitment), the human-review and
 * screening material including the sampling script.
 *
 * Deliberately NOT the Run/Matrix/Report execution graph: those are the claim, and the claim
 * belongs in the bundle a reader verifies, not in a browsable dataset repository.
 *
 * Order is frozen and mirrors `BUNDLE_V4_EVIDENCE_ROLES`; it is the order `freeze.json` renders
 * role groups in. Appending a role changes the rendered tree and therefore requires a format bump.
 *
 * This list is an order-preserving subsequence of `BUNDLE_V4_EVIDENCE_ROLES` whose complement is
 * `FREEZE_REPO_EXCLUDED_ROLES` below. That relation is asserted against the catalog itself, so a
 * role appended there fails the suite until it is placed in one list or the other — rather than
 * being dropped from every published tree with nothing saying so.
 */
export const FREEZE_REPO_ROLES: readonly BundleV4EvidenceRole[] = [
  "item-bank",
  "source-manifest",
  "admission-index",
  "admission-manifest",
  "replacement-ledger",
  "source-item",
  "judge-instrument",
  "analysis-context",
  "label-resolution",
  "human-review-evaluation-spec",
  "human-review-form",
  "human-review-packet",
  "human-review-response",
  "human-review-verdict",
  "reviewer-roster",
  "review-visibility-receipt",
  "review-reveal-receipt",
  "operator-assertion",
  "screening-table",
  "screening-reveal-receipt",
  "screening-instrument",
  "screening-sampling-script",
  "screening-raw-outputs",
  "screening-prompt",
  "screening-procedure",
  "screening-pool",
  "screening-sample-commitment",
  "screening-transcript",
] as const;

/**
 * The catalog roles this projection deliberately does NOT carry — the exact complement of
 * `FREEZE_REPO_ROLES` within `BUNDLE_V4_EVIDENCE_ROLES`. Naming them, rather than leaving the
 * exclusion implicit in what the other list happens to omit, is what lets an appended catalog role
 * fail a test instead of vanishing from every published tree.
 *
 * Every entry is excluded for one reason: it belongs to the claim, not to the qualification graph
 * a reader browses. `task` through `verdict` are the Run/Matrix/Report execution graph.
 * `snapshot-probe` is the pre-run snapshot-serving probe sealed alongside the runtime-selection
 * manifest (spec 1.5 rule 5) — it evidences how the Run's arms were served, so it is execution
 * evidence that merely arrives later in the catalog's frozen order. `disclosure-specification`
 * hangs off the Report extension (issue #2839) and is likewise part of the claim.
 */
export const FREEZE_REPO_EXCLUDED_ROLES: readonly BundleV4EvidenceRole[] = [
  "task",
  "runtime-selection",
  "evaluation-spec",
  "admission-receipt",
  "solve-submission",
  "run-pinning-evidence",
  "evaluation-submission",
  "solve-delivery",
  "solve-output",
  "evaluation-task",
  "evaluation-delivery",
  "verdict",
  "snapshot-probe",
  "disclosure-specification",
] as const;

/**
 * Bundle members copied verbatim so the repository frames its own freeze: the manifest that names
 * the bundle identity, the Benchmark record that carries the publication's licence data, the
 * evidence catalog that assigns every role below, and the qualification index that joins them.
 */
export const FREEZE_REPO_BUNDLE_MEMBERS = [
  "bundle.json",
  "benchmark.json",
  "evidence.json",
  "qualification.json",
] as const;

/** The generated manifest, which cannot list itself. */
export const FREEZE_REPO_MANIFEST_FILENAME = "freeze.json" as const;

/**
 * Fixed git identity and instant. A repository whose commit hash is the value an announcement pins
 * cannot take its identity or its time from the machine that rendered it.
 */
const COMMIT_IDENTITY = "Colophon <freeze@colophon.invalid> 0 +0000";

/** The same fixed instant the commit identity uses. An SPDX document requires a creation time and
 * this renderer has no clock, so it states the epoch rather than inventing a real one; the README
 * says so in as many words. */
const FIXED_INSTANT = "1970-01-01T00:00:00Z";

/**
 * SPDX short-identifier grammar (SPDX 2.3 Annex A). Deliberately grammar, not the licence list: a
 * list would date. State what that buys exactly — it refuses free text with spaces or punctuation
 * outside the grammar ("internal use only"), so such a string is never rendered into an
 * `SPDX-License-Identifier:` line. It does NOT establish that the identifier is on the SPDX list:
 * `Proprietary` and `LicenseRef-Whatever` satisfy the grammar. Because a "Canonical licence text:
 * <URL>" line is a claim that has to resolve, `spdxUrl` emits one only where the list can carry
 * it — never for a `LicenseRef-` identifier, which SPDX defines as off-list by construction.
 */
const SPDX_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u;

/**
 * Annex D's `idstring` — the same character set WITHOUT `+`, because in an expression `+` is the
 * "or later" operator and is legal only as the last character of a licence id. Folding it into the
 * character class would accept `MIT+++`, `A+B`, and `… WITH Classpath-exception-2.0+` (SPDX allows
 * no `+` on an exception at all), so the operator is matched by the parser rather than the class.
 */
const SPDX_IDSTRING = /^[A-Za-z0-9][A-Za-z0-9.-]*$/u;

/**
 * The same grammar, widened to the SPDX 2.3 Annex D licence EXPRESSION: `id`, `id+`,
 * `id WITH exception`, and those joined by `AND` / `OR` with optional parentheses. A publication
 * licensed `Apache-2.0 OR MIT` is an ordinary dual licence, and the short-identifier check alone
 * refused it outright — so such a publication could not be exported at all, which is a refusal
 * with no honest reason behind it.
 *
 * Still grammar, not list membership, exactly as the single-identifier check is; and `spdxUrl`
 * below cites a list address only for the single-identifier case, because a compound expression
 * names no one page.
 */
export function isSpdxLicenseExpression(value: string): boolean {
  const tokens = value.trim().split(/\s+/u).flatMap((token) => token.match(/\(|\)|[^()]+/gu) ?? []);
  if (tokens.length === 0) return false;
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  // The operators are reserved: without this `MIT OR OR` parses as three identifiers and passes.
  const keyword = (token: string | undefined): boolean =>
    token === "AND" || token === "OR" || token === "WITH";
  const identifier = (token: string | undefined, allowPlus: boolean): boolean =>
    token !== undefined && !keyword(token) && SPDX_IDSTRING.test(allowPlus ? token.replace(/\+$/u, "") : token);
  const simple = (): boolean => {
    if (!identifier(tokens[index], true)) return false;
    index += 1;
    if (peek() === "WITH") {
      index += 1;
      if (!identifier(tokens[index], false)) return false;
      index += 1;
    }
    return true;
  };
  const unit = (): boolean => {
    if (peek() === "(") {
      index += 1;
      if (!expression()) return false;
      if (peek() !== ")") return false;
      index += 1;
      return true;
    }
    return simple();
  };
  function expression(): boolean {
    if (!unit()) return false;
    while (peek() === "AND" || peek() === "OR") {
      index += 1;
      if (!unit()) return false;
    }
    return true;
  }
  return expression() && index === tokens.length;
}

/**
 * Control characters and line separators, plus any line that would read as an SPDX tag.
 * `citation` and `name` are spliced verbatim into `LICENSE` and the README heading, so a citation
 * carrying a line break followed by `SPDX-License-Identifier: MIT` would put a second licence tag
 * into a machine-scanned licence file. Self-inflicted rather than an outside attack — the field is
 * the publication's own sealed record — but a generated licence file must not be writable from a
 * free-text field, and refusing is cheaper than escaping.
 *
 * The refused set is C0 (tab excepted, and the line terminators in the one multi-line field), DEL,
 * ALL of C1, and `U+2028` / `U+2029`. C1 and the separators are not decoration: a line-break check
 * that stops at `U+007F` is bypassed by every scanner that does not. Python's `str.splitlines()`
 * — the idiom in ScanCode and most licence scanners — breaks on `\r`, `U+0085`, `U+2028` and
 * `U+2029`, and Java's `String.lines()` breaks on the same set, so a tag after any of them is a
 * second licence tag to the reader that matters even though this file saw one line.
 *
 * The splitter below therefore recognizes exactly the terminators the classes admit, and nothing
 * outside them can reach a rendered file to be recognized by anyone else.
 */
const SPDX_TAG_LINE = /^[ \t]*SPDX-[A-Za-z][A-Za-z0-9-]*[ \t]*:/u;

function renderableFreeTextProblem(value: string, multiline: boolean): string | undefined {
  // Tab is carried in both cases; CR and LF only where the field is documented as multi-line. CR
  // is admitted there because a citation pasted with CRLF endings is ordinary and the record is
  // already sealed, so refusing it would make such a bundle permanently unexportable — and the
  // splitter below treats it as the line break it is.
  const forbidden = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u
    : /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/u;
  if (forbidden.test(value)) {
    return "carries a control character or line separator; a freeze repository renders it into generated text and will not emit one";
  }
  if (value.split(/\r\n|[\n\r]/u).some((line) => SPDX_TAG_LINE.test(line))) {
    return "carries a line that reads as an SPDX tag; a freeze repository generates LICENSE from the declared licence alone and will not splice a second tag into it";
  }
  return undefined;
}

function assertRenderableFreeText(path: string, value: string, multiline: boolean): void {
  const problem = renderableFreeTextProblem(value, multiline);
  if (problem !== undefined) refuse("record-integrity", path, `the sealed record's ${path} ${problem}`);
}

/**
 * Everything a licence must satisfy before it can be rendered onto an `SPDX-License-Identifier:`
 * line, in one place: the free-text guard, the single-space rule, then the Annex D grammar.
 * Returns the reason the value cannot be rendered — a fragment whose subject the caller supplies
 * — or `undefined` when it can.
 *
 * The grammar alone is not the check. `isSpdxLicenseExpression` tokenizes with `split(/\s+/u)`,
 * so it is blind to padding, to doubled separators, and to which whitespace character was used;
 * the value is rendered onto the tag line exactly as it arrived. A caller that applied only the
 * grammar would admit `Apache-2.0  OR  MIT` and `MIT\tOR Apache-2.0`, which this export refuses.
 * That is why the whole check is exported rather than one half of it: `colophon import-item-bank
 * --license` calls this function, so the flag and the export cannot come to disagree about what a
 * licence is (issue #3878).
 */
export function spdxLicenseProblem(value: string): string | undefined {
  const freeText = renderableFreeTextProblem(value, false);
  if (freeText !== undefined) return freeText;
  if (value !== value.trim() || /\s\s|[^\S ]/u.test(value)) {
    return "is padded or separated by something other than single spaces; a freeze repository renders it onto an SPDX-License-Identifier line exactly as declared";
  }
  if (!isSpdxLicenseExpression(value)) {
    return "is not an SPDX licence expression (SPDX 2.3 Annex D grammar); a freeze repository renders it as one and will not present free text as a licence identifier";
  }
  return undefined;
}

/**
 * A download location SPDX will accept. `source.uri` is `z.string().min(1)` in the sealed
 * source-manifest schema, not a URL, so a local path can reach here — and publishing one as a
 * download location makes the SPDX document wrong rather than merely sparse. `NOASSERTION` is the
 * field's own word for "not stated", which is the true thing to say.
 */
function spdxDownloadLocation(uri: string): string {
  return /^(?:https?|ftp|git|git\+https?|svn|hg|bzr):\/\//u.test(uri) ? uri : "NOASSERTION";
}

/**
 * SPDX's `supplier` is `Organization: <name>` or `Person: <name>`. The Benchmark record's
 * `author` is free text and is frequently a machine signing-key id (`did:key:z6Mk…`), which is
 * neither — and labelling one an organization also reverses `verify.ts`'s note that the human
 * surface deliberately does not print signer identifiers. A scheme-qualified identifier therefore
 * reports `NOASSERTION` rather than being given a role it does not have.
 *
 * What this does NOT settle: `Organization:` versus `Person:` for an ordinary name. The sealed
 * record carries one free-text `author` and nothing that distinguishes the two, so a personal name
 * is still reported as an organization. Choosing between them needs a field the record does not
 * have; inventing the distinction here would be a claim no record backs.
 */
function spdxSupplier(author: string): string {
  // Scheme-qualified AND whitespace-free: a supplier name almost always carries a space, a machine
  // identifier never does, so "Colophon: Research" is still stated as the supplier it is.
  const machineIdentifier = !/\s/u.test(author) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(author);
  return machineIdentifier ? "NOASSERTION" : `Organization: ${author}`;
}

export interface FreezeRepoSourceLicence {
  readonly provenanceSha256: string;
  readonly source: BinarySourceManifestEntry["source"];
  readonly license: BinarySourceManifestEntry["license"];
  readonly attribution: BinarySourceManifestEntry["attribution"];
  readonly publishedAt: string;
}

export interface FreezeRepoPublication {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly author?: string;
  readonly citation?: string;
}

export interface FreezeRepoTree {
  readonly format: typeof FREEZE_REPO_FORMAT;
  readonly bundleFormat: string;
  readonly bundleIdentity: string;
  readonly publication: FreezeRepoPublication;
  /** The git commit id this tree hashes to — the value a freeze announcement pins. */
  readonly commitId: string;
  /**
   * The roles this tree carries, in `FREEZE_REPO_ROLES`' frozen order — the same order
   * `freeze.json` renders its role groups in. Frozen rather than alphabetical so the two surfaces
   * present one list once, not the same list in two orders.
   */
  readonly roles: readonly string[];
  /** Every rendered path, sorted, mapped to its exact bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Code-unit ordering, the same total order the bundle's own catalogs are sorted by. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * UTF-8 byte ordering, which is the order git sorts tree entries in — NOT the code-unit order
 * above. The two agree on ASCII and diverge above it: `U+FF21` precedes `U+1D400` by UTF-8 bytes
 * (`EF BC A1` < `F0 9D 90 80`) and follows it by UTF-16 code units, because the astral character
 * is a surrogate pair beginning `D835`. No path `renderFreezeRepo` produces is affected — every
 * one of them is ASCII — but `freezeRepoCommitId` is exported, and a caller passing such a name
 * would otherwise be handed an oid git disagrees with while the function documents the opposite.
 */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/**
 * Canonical JSON for the documents this module GENERATES. Sealed record bytes are never
 * re-serialized — they are copied exactly — so this only has to be stable, not protocol-canonical.
 */
function json(value: unknown): Uint8Array {
  return text(`${JSON.stringify(value, undefined, 2)}\n`);
}

function parseJsonOrUndefined(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Git object hashing
// ---------------------------------------------------------------------------

function gitObjectId(type: "blob" | "tree" | "commit", body: Uint8Array): Buffer {
  return createHash("sha1")
    .update(text(`${type} ${body.length}\0`))
    .update(body)
    .digest();
}

interface TreeNode {
  readonly files: Map<string, Uint8Array>;
  readonly directories: Map<string, TreeNode>;
}

function emptyNode(): TreeNode {
  return { files: new Map(), directories: new Map() };
}

/**
 * Place one file in the tree under construction, refusing every path git itself would refuse to
 * record. The renderer produces none of these, but this function is reached through the exported
 * `freezeRepoCommitId`, and each of them otherwise yields an oid for a tree no git repository can
 * hold — a worse failure than a refusal, because the number still looks like a commit id.
 */
function insert(root: TreeNode, path: string, bytes: Uint8Array): void {
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    refuse("conflict", path, `"${path}" has an empty path segment; git records no such entry`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    refuse("conflict", path, `"${path}" contains a "." or ".." segment; git records no such entry`);
  }
  if (Buffer.from(path, "utf8").toString("utf8") !== path) {
    // A lone surrogate has no UTF-8 encoding, so `Buffer.from` replaces it with U+FFFD — and both
    // the sort key and the emitted entry name go through that encoding. Two distinct file sets
    // ("a\uD800" and "a\uFFFD") would otherwise return ONE oid, and two names differing only in
    // their surrogate would emit a tree body carrying the same name twice: bytes no git repository
    // can hold. The round trip is the check because it tests the exact property that matters —
    // that the bytes emitted for this name represent this name.
    refuse(
      "conflict",
      path,
      `"${path}" is not representable in UTF-8 (an unpaired surrogate); git tree entry names are UTF-8 bytes`,
    );
  }
  if (path.includes("\u0000")) {
    // A tree entry is framed as `<mode> <name>\0<oid>`, so a NUL in a name does not merely produce
    // a tree git would refuse — it produces bytes that are not a tree object at all.
    refuse("conflict", path, `"${path}" contains a NUL; a git tree entry is NUL-terminated and cannot carry one`);
  }
  let node = root;
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    if (node.files.has(segment)) {
      refuse(
        "conflict",
        path,
        `"${path}" needs a directory at "${segments.slice(0, index + 1).join("/")}", which is already a file`,
      );
    }
    let next = node.directories.get(segment);
    if (next === undefined) {
      next = emptyNode();
      node.directories.set(segment, next);
    }
    node = next;
  }
  const name = segments[segments.length - 1]!;
  if (node.directories.has(name)) {
    refuse("conflict", path, `"${path}" is already a directory in this tree; git records one entry per name`);
  }
  node.files.set(name, bytes);
}

/**
 * Git's tree ordering compares a directory entry as if its name ended in "/", over UTF-8 bytes —
 * the two rules that make a hand-built tree object hash the same as one `git write-tree` would
 * produce. The slash rule bites only on a prefix collision (`a.txt` beside a directory `a`), which
 * `freezeRepoCommitId`'s own git-parity test now exercises directly rather than relying on a
 * rendered tree that happens to have none.
 */
function treeObjectId(node: TreeNode): Buffer {
  const entries: { readonly sortKey: string; readonly mode: string; readonly name: string; readonly id: Buffer }[] = [
    ...[...node.files].map(([name, bytes]) => ({
      sortKey: name,
      mode: "100644",
      name,
      id: gitObjectId("blob", bytes),
    })),
    ...[...node.directories].map(([name, child]) => ({
      sortKey: `${name}/`,
      mode: "40000",
      name,
      id: treeObjectId(child),
    })),
  ].sort((left, right) => compareUtf8(left.sortKey, right.sortKey));

  const body = Buffer.concat(
    entries.map((entry) => Buffer.concat([Buffer.from(text(`${entry.mode} ${entry.name}\0`)), entry.id])),
  );
  return gitObjectId("tree", body);
}

/**
 * The commit id for a rendered tree: a real git commit object over a real git tree, computed
 * in-process. No `git` binary, no working directory, no index — so the value is a function of the
 * bundle rather than of whatever machine happened to run the export.
 *
 * Stated exactly, because the README tells a reader `git rev-parse HEAD` equals this value: the
 * hash is plain SHA-1, while git uses hardened SHA-1 (sha1dc), which REFUSES a block bearing a
 * known collision-attack signature. The two agree on every input git accepts and disagree only on
 * content deliberately built to carry such a block — where git produces no oid at all rather than
 * a different one. A bundle's records are digest-committed by the closure that sealed them, so
 * this is a limit of the parity claim, not a way to move a published pin.
 */
export function freezeRepoCommitId(files: ReadonlyMap<string, Uint8Array>, bundleIdentity: string): string {
  const root = emptyNode();
  for (const [path, bytes] of files) insert(root, path, bytes);
  const body = text(
    `tree ${treeObjectId(root).toString("hex")}\n`
      + `author ${COMMIT_IDENTITY}\n`
      + `committer ${COMMIT_IDENTITY}\n`
      + "\n"
      + `Colophon freeze ${bundleIdentity}\n`,
  );
  return gitObjectId("commit", body).toString("hex");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function requireMember(snapshot: VerifiedBundleSnapshot, path: string): Uint8Array {
  const bytes = snapshot.fileBytes.get(path);
  if (bytes === undefined) {
    refuse("not-found", path, `authenticated bundle snapshot is missing "${path}"`);
  }
  return bytes;
}

function readPublication(snapshot: VerifiedBundleSnapshot): FreezeRepoPublication {
  const benchmark = parseJsonOrUndefined(requireMember(snapshot, "benchmark.json"));
  if (benchmark === null || typeof benchmark !== "object") {
    refuse("record-integrity", "benchmark.json", "the sealed Benchmark record is not a JSON object");
  }
  const record = benchmark as Record<string, unknown>;
  const license = record["license"];
  // The free-text guard, the single-space rule, and the grammar are one function, shared with the
  // `--license` flag that seals this field, so the two cannot disagree about what a licence is.
  if (typeof license === "string" && license.length > 0) {
    const problem = spdxLicenseProblem(license);
    if (problem !== undefined) {
      refuse("record-integrity", "benchmark.json.license", `the sealed Benchmark record's licence ${problem}`);
    }
  }
  if (typeof license !== "string" || license.length === 0) {
    // Licence scaffolding is generated from licence data or it is not generated at all. Inventing
    // a licence for a publication that never declared one is exactly the hand-assembly this
    // export exists to replace.
    refuse(
      "conflict",
      "benchmark.json.license",
      "the sealed Benchmark record declares no licence; a freeze repository's LICENSE, NOTICE, and SPDX metadata are generated from the bundle's licence data",
    );
  }
  const name = record["name"];
  const version = record["version"];
  if (typeof name !== "string" || typeof version !== "string") {
    refuse("record-integrity", "benchmark.json", "the sealed Benchmark record has no name or version");
  }
  const author = record["author"];
  const citation = record["citation"];
  // Every field below is spliced verbatim into generated text — LICENSE, NOTICE, the README
  // heading, the SPDX document — so each is checked before it can reach any of them.
  assertRenderableFreeText("benchmark.json.name", name, false);
  assertRenderableFreeText("benchmark.json.version", version, false);
  if (typeof author === "string") assertRenderableFreeText("benchmark.json.author", author, false);
  // A citation is legitimately multi-line (a BibTeX entry), so newlines are allowed there and
  // nothing else is.
  if (typeof citation === "string") assertRenderableFreeText("benchmark.json.citation", citation, true);
  return {
    name,
    version,
    license,
    ...(typeof author === "string" ? { author } : {}),
    ...(typeof citation === "string" ? { citation } : {}),
  };
}

/** The per-source licence and attribution facts, read from the sealed source-manifest rows. */
function readSourceLicences(sourceManifestBytes: readonly Uint8Array[]): readonly FreezeRepoSourceLicence[] {
  const rows: FreezeRepoSourceLicence[] = [];
  for (const bytes of sourceManifestBytes) {
    let lines: readonly string[];
    try {
      lines = decoder.decode(bytes).split("\n").filter((line) => line.length > 0);
    } catch {
      refuse("record-integrity", "source-manifest", "the sealed source manifest is not valid UTF-8");
    }
    for (const line of lines) {
      // Authenticated bytes are not automatically well-formed bytes: a malformed row must refuse
      // with a typed error, not escape as a raw SyntaxError from JSON.parse.
      const document = parseJsonOrUndefined(text(line));
      const parsed = BinarySourceManifestEntrySchema.safeParse(document);
      if (!parsed.success) {
        refuse("record-integrity", "source-manifest", "a sealed source-manifest row does not match the pinned schema");
      }
      const entry = parsed.data;
      // `uri` is `z.string().min(1)` in the sealed schema, and `renderNotice` splices each of
      // these into NOTICE verbatim — so the rule the publication fields are held to holds here
      // too: a generated licence-bearing file is not writable from a free-text field. Multi-line
      // because nothing forbids a wrapped descriptor; the tag-line check is what matters.
      for (const [field, value] of [
        ["source.uri", entry.source.uri],
        ["source.name", entry.source.name],
        ["license.uri", entry.license.uri],
        ["attribution.uri", entry.attribution.uri],
      ] as const) {
        if (typeof value === "string") assertRenderableFreeText(`source-manifest.${field}`, value, true);
      }
      rows.push({
        provenanceSha256: entry.provenanceSha256,
        source: entry.source,
        license: entry.license,
        attribution: entry.attribution,
        publishedAt: entry.publishedAt,
      });
    }
  }
  return [...rows].sort((left, right) => compareStrings(left.provenanceSha256, right.provenanceSha256));
}

/** The canonical-text URL for a licence the SPDX list can carry, or `undefined` for a
 * `LicenseRef-` identifier, which by SPDX 2.3 §10 names a licence that is NOT on the list and so
 * has no page there. The grammar check upstream cannot prove list membership for anything else, so
 * this is the narrowest honest cut. */
function spdxUrl(identifier: string): string | undefined {
  if (!SPDX_IDENTIFIER.test(identifier)) return undefined; // a compound expression names no one page
  return /^LicenseRef-/u.test(identifier) ? undefined : `https://spdx.org/licenses/${identifier}.html`;
}

function renderLicense(publication: FreezeRepoPublication, sources: readonly FreezeRepoSourceLicence[]): Uint8Array {
  return text([
    `SPDX-License-Identifier: ${publication.license}`,
    "",
    `${publication.name} ${publication.version}`,
    "",
    `The Colophon-authored records in this repository are published under ${publication.license}.`,
    ...(spdxUrl(publication.license) === undefined
      ? [
        SPDX_IDENTIFIER.test(publication.license)
          ? `${publication.license} is a LicenseRef identifier, which SPDX defines as a licence the list does not carry, so there is no list entry to cite for it.`
          : `${publication.license} is an SPDX licence expression rather than a single identifier, so it names no one list entry to cite; look each identifier in it up on the SPDX list.`,
      ]
      : [
        `SPDX list entry for that identifier: ${spdxUrl(publication.license)!}`,
        "That address is where the SPDX list publishes this identifier if it carries it. The export",
        "checks the declared licence against the SPDX short-identifier grammar, not against the list,",
        "so an identifier the list does not carry will not resolve there.",
      ]),
    "",
    "That is the scope, exactly. Upstream sources keep their own licences, and source-derived text",
    "quoted inside these records stays subject to them. NOTICE names every source row with the",
    "digest of the licence document the sealed source manifest commits to;",
    `${sources.length} source ${sources.length === 1 ? "row is" : "rows are"} listed there and in metadata/spdx.json.`,
    "",
    "This file states the licence the sealed Benchmark record declares. It does not reproduce the",
    "licence text: this repository is generated from a sealed bundle, and the bundle does not carry",
    "those bytes, so reproducing them here would be an assertion no record backs.",
    "",
    ...(publication.citation === undefined ? [] : ["Citation:", publication.citation, ""]),
  ].join("\n"));
}

function renderNotice(
  publication: FreezeRepoPublication,
  sources: readonly FreezeRepoSourceLicence[],
): Uint8Array {
  const lines: string[] = [
    `${publication.name} ${publication.version}`,
    ...(publication.author === undefined ? [] : [`Published by ${publication.author}`]),
    "",
    "Attribution",
    "-----------",
    "",
    "Every upstream source the sealed source manifest names, with the exact attribution and",
    "licence documents it commits to:",
    "",
  ];
  for (const source of sources) {
    lines.push(
      `- source ${source.provenanceSha256}`,
      `  uri:         ${source.source.uri}`,
      `  published:   ${source.publishedAt}`,
      `  licence:     ${source.license.uri}`,
      `               sha256:${source.license.digest.sha256}`,
      `  attribution: ${source.attribution.uri}`,
      `               sha256:${source.attribution.digest.sha256}`,
      "",
    );
  }
  lines.push(
    "Modification notice",
    "-------------------",
    "",
    "No member of this repository is an unmodified copy of an upstream source. The sealed bundle",
    "does not carry upstream source bytes at all: the source manifest names each source by URI and",
    "digest, which is what the rows above list.",
    "",
    "Every member under artifacts/ is a Colophon-authored or Colophon-derived sealed record over",
    "those sources — the item payloads, item-bank entries, admission decisions, label resolutions,",
    "analysis contexts, judge instruments, and the human-review and screening material. The item",
    "payloads quote source-derived question and answer text; the rest is Colophon's own. Each file",
    "is named by the SHA-256 of its own exact bytes.",
    "",
    "Nothing in this repository has been edited by hand. It is regenerated from the bundle.",
    "",
  );
  return text(lines.join("\n"));
}

function renderSpdxMetadata(
  publication: FreezeRepoPublication,
  bundleIdentity: string,
  sources: readonly FreezeRepoSourceLicence[],
): Uint8Array {
  return json({
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    dataLicense: "CC0-1.0",
    name: `${publication.name} ${publication.version}`,
    documentNamespace: `https://colophon.invalid/freeze/${bundleIdentity}`,
    // `created` is the fixed epoch, not a real instant: this document is a pure function of the
    // bundle, and a real creation time would make two renders of the same bundle differ.
    creationInfo: { created: FIXED_INSTANT, creators: [`Tool: ${FREEZE_REPO_FORMAT}`] },
    documentDescribes: ["SPDXRef-Package-Freeze"],
    packages: [
      {
        SPDXID: "SPDXRef-Package-Freeze",
        name: publication.name,
        versionInfo: publication.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseDeclared: publication.license,
        licenseConcluded: publication.license,
        ...(publication.author === undefined ? {} : { supplier: spdxSupplier(publication.author) }),
      },
      ...sources.map((source, index) => ({
        SPDXID: `SPDXRef-Source-${index + 1}`,
        name: source.source.name ?? source.source.uri,
        downloadLocation: spdxDownloadLocation(source.source.uri),
        filesAnalyzed: false,
        licenseDeclared: "NOASSERTION",
        licenseConcluded: "NOASSERTION",
        checksums: [{ algorithm: "SHA256", checksumValue: source.source.digest.sha256 }],
        attributionTexts: [
          `licence document ${source.license.uri} sha256:${source.license.digest.sha256}`,
          `attribution document ${source.attribution.uri} sha256:${source.attribution.digest.sha256}`,
        ],
      })),
    ],
    relationships: sources.map((_, index) => ({
      spdxElementId: "SPDXRef-Package-Freeze",
      relationshipType: "GENERATED_FROM",
      relatedSpdxElement: `SPDXRef-Source-${index + 1}`,
    })),
  });
}

function renderReadme(
  publication: FreezeRepoPublication,
  bundleIdentity: string,
  bundleFormat: string,
  support: FreezeRepoBundleSupport,
  roleCounts: readonly { readonly role: string; readonly files: number }[],
): Uint8Array {
  const lines: string[] = [
    `# ${publication.name} ${publication.version} — freeze artifacts`,
    "",
    "This repository is a **derived artifact**, not the claim of record. The sealed records in the",
    `public bundle \`${bundleIdentity}\` (\`${bundleFormat}\`) remain the sole source of truth. Everything`,
    `here is regenerated from that bundle by \`${FREEZE_REPO_FORMAT}\`; nothing is assembled by hand.`,
    "",
    "## Checking this tree against the bundle",
    "",
    "```",
    "colophon freeze-repo verify --bundle <bundle-dir> --repo <this-repo>",
    "```",
    "",
    "The check re-renders the tree from the bundle and compares it byte for byte. A missing, extra,",
    "or altered file fails and is named. Regenerating instead of checking:",
    "",
    "```",
    "colophon freeze-repo export --bundle <bundle-dir> --out <dir>",
    "```",
    "",
    "## The commit a freeze announcement pins",
    "",
    "`freeze-repo export` and `freeze-repo verify` both report a git commit oid over exactly this",
    "tree, computed from the bundle rather than from whatever machine rendered it — so an",
    "announcement can pin it before the repository is pushed anywhere. It is not written into the",
    "tree, because a file naming the hash of the tree containing it has no fixed point. Committing",
    "this tree to that oid needs the same fixed identity and instant the renderer used, and the file",
    "modes left alone (every member is mode 100644; making one executable, or replacing one with a",
    "symlink, changes the commit — and `freeze-repo verify` reports both):",
    "",
    "```",
    "export GIT_AUTHOR_NAME=Colophon GIT_AUTHOR_EMAIL=freeze@colophon.invalid",
    "export GIT_COMMITTER_NAME=Colophon GIT_COMMITTER_EMAIL=freeze@colophon.invalid",
    "export GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_DATE='@0 +0000'",
    "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null",
    "git init --quiet && git add -A -f",
    `git commit --quiet --no-gpg-sign -m 'Colophon freeze ${bundleIdentity}'`,
    "git rev-parse HEAD    # equals the reported oid",
    "```",
    "",
    "The two `GIT_CONFIG_*` lines, `-f`, and `--no-gpg-sign` are not decoration: your own git",
    "configuration would otherwise reach the object. `commit.gpgsign` adds a `gpgsig` header,",
    "`core.autocrlf` rewrites the bytes, `init.templateDir` and `core.hooksPath` run code, and a",
    "`core.excludesFile` matching `*.bin` makes `git add -A` silently drop the records under",
    "`artifacts/` — each of which yields a different oid, the last of them with nothing said.",
    "",
    "## Layout",
    "",
    `- \`${FREEZE_REPO_MANIFEST_FILENAME}\` — every path with its byte length and SHA-256, plus the`,
    "  protocol identifier each role's records declare. It does not list itself.",
    "- `bundle/` — the bundle members that frame the freeze, copied byte for byte.",
    "- `artifacts/<role>/<sha256>.<json|bin>` — the sealed freeze records, grouped by the evidence",
    "  role the bundle's own catalog assigns them. The extension is `.json` when the exact bytes",
    "  parse as JSON and `.bin` when they do not; the stem is the SHA-256 of those bytes, so a",
    "  file's name is its own check.",
    "- `LICENSE`, `NOTICE`, `metadata/spdx.json` — generated from the bundle's licence data.",
    "",
  ];
  // A reader of a disclosed closure has a specific reason to look for the disclosure record here
  // and not find it, so that bundle's tree says where it is. Conditional, not unconditional:
  // every already-published tree of a format that carries no such record must keep its exact
  // bytes, and a rendered tree is a pure function of the bundle either way.
  if (support.disclosure) {
    lines.push(
      "## The disclosure record",
      "",
      "This bundle carries a sealed disclosure-specification record — the six variables that",
      "produced the score. It is deliberately not in this tree. That record is part of the claim,",
      "and the claim stays in the bundle a reader verifies, where the bundle's own",
      "`disclosure-specification` check reads it. What is projected here is the",
      "admission/qualification graph alone.",
      "",
    );
  }
  lines.push(
    "## Roles present",
    "",
  );
  for (const entry of roleCounts) lines.push(`- \`${entry.role}\` — ${entry.files} ${entry.files === 1 ? "record" : "records"}`);
  lines.push(
    "",
    "## Schemas",
    "",
    "The record schemas are pinned by the protocol identifiers this repository's records carry",
    `(listed in \`${FREEZE_REPO_MANIFEST_FILENAME}\`) and ship with the standalone verifier package,`,
    "`@colophon-claims/verify`. They are not copied here: a copy would make this tree a function of",
    "the tool version as well as of the bundle, and the tree's whole value is that it is not.",
    "",
  );
  return text(lines.join("\n"));
}

/**
 * Render the deterministic freeze repository for one authenticated bundle snapshot.
 *
 * Pure: same snapshot in, byte-identical tree out, on any machine at any time.
 */
export function renderFreezeRepo(snapshot: VerifiedBundleSnapshot): FreezeRepoTree {
  const bundleFormat = snapshot.manifest.format;
  const support = FREEZE_REPO_BUNDLE_SUPPORT[bundleFormat as SupportedBundleFormat];
  if (support?.qualification !== true) {
    // The freeze artifacts ARE the qualification graph. A bundle without one has none, and an
    // empty repository claiming to be a freeze would be worse than a refusal. The accepted list is
    // read from the support table, so this message cannot name a stale set (issue #3540).
    refuse(
      "conflict",
      "bundle.json.format",
      `a freeze repository requires a qualification bundle (${listAccepted(FREEZE_REPO_ACCEPTED_FORMATS)});`
        + ` this bundle is ${bundleFormat}`,
    );
  }

  const publication = readPublication(snapshot);

  const catalogParsed = BundleV4EvidenceCatalogSchema.safeParse(
    parseJsonOrUndefined(requireMember(snapshot, "evidence.json")),
  );
  if (!catalogParsed.success) {
    refuse("record-integrity", "evidence.json", "the bundle's evidence catalog does not match the pinned v4 grammar");
  }

  const freezeRoles = new Set<string>(FREEZE_REPO_ROLES);
  const roleIndex = new Map(FREEZE_REPO_ROLES.map((role, index) => [role, index] as const));
  const files = new Map<string, Uint8Array>();
  const byRole = new Map<BundleV4EvidenceRole, { readonly sha256: string; readonly path: string; readonly bytes: Uint8Array }[]>();
  const sourceManifestBytes: Uint8Array[] = [];

  for (const record of catalogParsed.data.records) {
    const roles = record.roles.filter((role) => freezeRoles.has(role));
    if (roles.length === 0) continue;
    const bytes = requireMember(snapshot, `records/${record.sha256}.bin`);
    // The extension is a function of the bytes, so it stays deterministic while keeping the tree
    // browsable: a reader should not have to guess that a `.bin` is canonical JSON.
    const extension = parseJsonOrUndefined(bytes) === undefined ? "bin" : "json";
    for (const role of roles) {
      const path = `artifacts/${role}/${record.sha256}.${extension}`;
      files.set(path, bytes);
      const group = byRole.get(role) ?? [];
      group.push({ sha256: record.sha256, path, bytes });
      byRole.set(role, group);
      if (role === "source-manifest") sourceManifestBytes.push(bytes);
    }
  }

  if (files.size === 0) {
    refuse("not-found", "evidence.json", "the bundle's evidence catalog assigns no freeze-artifact role");
  }

  for (const member of FREEZE_REPO_BUNDLE_MEMBERS) {
    files.set(`bundle/${member}`, requireMember(snapshot, member));
  }

  const sources = readSourceLicences(sourceManifestBytes);
  const roleGroups = [...byRole.entries()]
    .sort(([left], [right]) => roleIndex.get(left)! - roleIndex.get(right)!)
    .map(([role, records]) => {
      const protocols = [
        ...new Set(
          records
            .map((entry) => (parseJsonOrUndefined(entry.bytes) as { protocol?: unknown } | undefined)?.protocol)
            .filter((protocol): protocol is string => typeof protocol === "string"),
        ),
      ].sort(compareStrings);
      return { role, files: records.length, protocols };
    });

  files.set("LICENSE", renderLicense(publication, sources));
  files.set("NOTICE", renderNotice(publication, sources));
  files.set("metadata/spdx.json", renderSpdxMetadata(publication, snapshot.identity, sources));
  files.set(
    "README.md",
    renderReadme(
      publication,
      snapshot.identity,
      bundleFormat,
      support,
      roleGroups.map(({ role, files: count }) => ({ role, files: count })),
    ),
  );

  const listed = [...files.keys()].sort(compareStrings).map((path) => ({
    path,
    bytes: files.get(path)!.length,
    sha256: sha256Hex(files.get(path)!),
  }));
  files.set(
    FREEZE_REPO_MANIFEST_FILENAME,
    json({
      format: FREEZE_REPO_FORMAT,
      bundle: { identity: snapshot.identity, format: bundleFormat },
      publication,
      roles: roleGroups,
      // The source rows are NOT restated here. They are already carried byte-for-byte under
      // `artifacts/source-manifest/`, and re-serializing schema-parsed objects would make these
      // bytes a function of the verifier's schema shape as well as of the bundle — which is
      // exactly the tool-version dependence this format promises not to have.
      // `freeze.json` cannot list itself: its own digest is not knowable before it is written.
      // Every other rendered path is here, sorted.
      files: listed,
    }),
  );

  const sorted = new Map([...files.entries()].sort(([left], [right]) => compareStrings(left, right)));
  return {
    format: FREEZE_REPO_FORMAT,
    bundleFormat,
    bundleIdentity: snapshot.identity,
    publication,
    commitId: freezeRepoCommitId(sorted, snapshot.identity),
    roles: roleGroups.map(({ role }) => role),
    files: sorted,
  };
}

// ---------------------------------------------------------------------------
// Filesystem surface
// ---------------------------------------------------------------------------

export interface FreezeRepoExportResult {
  readonly repoDir: string;
  readonly bundleIdentity: string;
  readonly commitId: string;
  readonly fileCount: number;
  readonly roles: readonly string[];
}

/** Render a bundle's freeze repository into `repoDir`. The bundle is verified first: a tree
 * derived from records that do not verify would carry exactly the drift this export closes. */
export async function exportFreezeRepo(
  bundleDir: string,
  repoDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<FreezeRepoExportResult> {
  const tree = renderFreezeRepo((await verifyPublicBundleSnapshot(bundleDir, deps)).snapshot);
  // Never write into an occupied tree. Merging into leftovers would produce a directory that is
  // not the rendered tree, and the export's whole contract is that the directory IS the tree; a
  // recursive delete of a caller-named path is the wrong way to guarantee that.
  // Only "the directory does not exist yet" reads as empty. Any other enumeration error — an
  // unreadable subdirectory, say — is exactly the case where the guard cannot tell whether the
  // tree is occupied, and answering "empty" there would let the export merge into leftovers (and
  // follow a seeded symlink out of `repoDir`) while still reporting the rendered tree's oid.
  let occupied: readonly TreeEntry[] = [];
  try {
    occupied = listTree(repoDir, false);
  } catch (cause) {
    const code = (cause !== null && typeof cause === "object" && "code" in cause)
      ? (cause as { code?: unknown }).code
      : undefined;
    if (code !== "ENOENT") {
      refuse(
        "conflict",
        repoDir,
        `"${repoDir}" could not be read to check that it is empty (${code ?? "unknown error"}); export writes a complete tree and will not write into a directory it cannot enumerate`,
      );
    }
  }
  if (occupied.length > 0) {
    refuse("conflict", repoDir, `"${repoDir}" already contains files; export writes a complete tree and will not merge into one — remove the directory and export again`);
  }
  for (const [path, bytes] of tree.files) {
    const target = join(repoDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return {
    repoDir,
    bundleIdentity: tree.bundleIdentity,
    commitId: tree.commitId,
    fileCount: tree.files.size,
    roles: tree.roles,
  };
}

export type FreezeRepoDifferenceKind = "missing" | "unexpected" | "changed";

export interface FreezeRepoDifference {
  readonly path: string;
  readonly kind: FreezeRepoDifferenceKind;
}

export interface FreezeRepoVerificationResult {
  readonly ok: boolean;
  /**
   * False when the filesystem holding the tree does not carry an executable bit (or could not be
   * asked), so the mode dimension was not checked and `ok` rests on bytes and entry type alone.
   * Reported rather than assumed: a check that silently drops a dimension is the kind of quiet
   * claim this tool exists to avoid.
   */
  readonly executableBitChecked: boolean;
  readonly bundleIdentity: string;
  readonly commitId: string;
  readonly fileCount: number;
  readonly differences: readonly FreezeRepoDifference[];
}

interface TreeEntry {
  readonly path: string;
  /** False for a symlink, device, socket, or anything else git would not record as a blob at
   * mode 100644. Such an entry is never treated as satisfying an expected member. */
  readonly plainFile: boolean;
  /** Owner-execute bit as git would record it, and only where the filesystem carries one. */
  readonly executable: boolean;
}

/**
 * @internal Exported for this module's own tests; not part of the package's public surface.
 *
 * Decide whether the filesystem under `dir` actually carries an executable bit, the way git
 * autodetects `core.fileMode`: write a probe file, and see whether the owner-execute bit reads
 * back the way it was set.
 *
 * This exists because some filesystems report a fixed mode for every file — `0777` on an exFAT
 * or Windows-hosted mount, on some network filesystems — so reading the mode there says nothing
 * about the published tree. Without the probe a byte-perfect clone on such a machine reports
 * EVERY member as `changed`, which is the loudest possible false alarm for a tool whose whole
 * claim is that the tree matches.
 *
 * Fails to "not carried" on any error (a read-only mount, a permission refusal). That direction
 * is deliberate and matches git's: the byte comparison still runs on every member, so the cost is
 * one unreported mode bit on a filesystem we could not interrogate, against a total spurious
 * failure the other way.
 */
export function execBitIsCarried(dir: string): boolean {
  // Written inside the repository's own `.git` when it has one — same filesystem, and the walk
  // already skips root `.git`, so a probe stranded by a SIGKILL between create and unlink cannot
  // later read back as an unexpected member of the published tree.
  const name = `.colophon-filemode-probe-${randomBytes(8).toString("hex")}`;
  const gitDir = join(dir, ".git");
  let probeDir = dir;
  try {
    if (statSync(gitDir).isDirectory()) probeDir = gitDir;
  } catch {
    // no `.git`, or an unreadable one: probe the tree itself
  }
  const probe = join(probeDir, name);
  try {
    writeFileSync(probe, "", { mode: 0o644, flag: "wx" });
    // A filesystem that reports the bit on a file created without it is reporting a constant.
    if ((statSync(probe).mode & 0o111) !== 0) return false;
    chmodSync(probe, 0o755);
    return (statSync(probe).mode & 0o100) !== 0;
  } catch {
    return false;
  } finally {
    // The probe answers a question; it never raises one. A cleanup refusal (EPERM on an unusual
    // mount) must not escape as the caller's failure — at worst it strands the file note below.
    try {
      rmSync(probe, { force: true });
    } catch {
      // deliberately ignored
    }
  }
}

/**
 * @internal Exported for this module's own tests; not part of the package's public surface.
 *
 * Enumerate a published tree the way git sees it. Three rules earn their place:
 *
 * - `.git` is skipped ONLY at the root, and before the entry type is dispatched on. A nested
 *   `.git` directory is ordinary content to the outer repository, so skipping it at depth would
 *   let a tree carry files the check never looks at; and in a linked worktree or a submodule
 *   checkout the root `.git` is a regular FILE, so a directory-only test reports it as an
 *   unexpected member of an otherwise faithful clone.
 * - a symlink is not a file. Reporting it rather than skipping it is what stops
 *   `LICENSE -> /etc/passwd` from reading as a matching member.
 * - the executable bit is read as git reads it — the OWNER bit alone, since that is what selects
 *   mode 100755 — and only when `execBitCarried` says the filesystem records one at all.
 */
export function listTree(repoDir: string, execBitCarried: boolean): readonly TreeEntry[] {
  const found: TreeEntry[] = [];
  const walk = (dir: string, atRoot: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (atRoot && entry.name === ".git") continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, false);
        continue;
      }
      const path = relative(repoDir, absolute).split(sep).join("/");
      if (!entry.isFile()) {
        found.push({ path, plainFile: false, executable: false });
        continue;
      }
      // The exec bit is part of the git tree (mode 100755 rather than 100644), so it moves the
      // commit oid the announcement pins even though the bytes are untouched.
      const executable = execBitCarried && (statSync(absolute).mode & 0o100) !== 0;
      found.push({ path, plainFile: true, executable });
    }
  };
  walk(repoDir, true);
  return found.sort((left, right) => compareStrings(left.path, right.path));
}

/**
 * The standalone check: re-render from the bundle and compare the published tree byte for byte.
 * Missing, unexpected, and changed members are all reported and all fail.
 */
export async function verifyFreezeRepo(
  bundleDir: string,
  repoDir: string,
  deps: VerifyPublicBundleDeps = {},
): Promise<FreezeRepoVerificationResult> {
  return verifyFreezeRepoSnapshot((await verifyPublicBundleSnapshot(bundleDir, deps)).snapshot, repoDir);
}

/**
 * The same check against a bundle snapshot the caller has ALREADY authenticated.
 *
 * This is the form a caller that just verified the bundle wants: re-verifying it here would run a
 * second full pass whose anchor outcomes are computed without the caller's own `--tsa-root` /
 * `--ots-headers` trust material, so they could differ — silently — from the ones the caller went
 * on to report. One verification, one set of outcomes.
 */
export function verifyFreezeRepoSnapshot(
  snapshot: VerifiedBundleSnapshot,
  repoDir: string,
): FreezeRepoVerificationResult {
  const tree = renderFreezeRepo(snapshot);
  const differences: FreezeRepoDifference[] = [];

  let present: readonly TreeEntry[];
  let executableBitChecked = false;
  try {
    if (!statSync(repoDir).isDirectory()) throw new Error("not a directory");
    executableBitChecked = execBitIsCarried(repoDir);
    present = listTree(repoDir, executableBitChecked);
  } catch {
    refuse("not-found", repoDir, `"${repoDir}" is not a readable directory`);
  }

  const presentByPath = new Map(present.map((entry) => [entry.path, entry] as const));
  for (const [path, expected] of tree.files) {
    const entry = presentByPath.get(path);
    if (entry === undefined) {
      differences.push({ path, kind: "missing" });
      continue;
    }
    // A symlink or an executable bit changes what git records for this path, so the published
    // tree no longer hashes to the pinned commit even when the bytes read back identical.
    if (!entry.plainFile || entry.executable) {
      differences.push({ path, kind: "changed" });
      continue;
    }
    const actual = readFileSync(join(repoDir, path));
    if (sha256Hex(actual) !== sha256Hex(expected)) differences.push({ path, kind: "changed" });
  }
  for (const entry of present) {
    if (!tree.files.has(entry.path)) differences.push({ path: entry.path, kind: "unexpected" });
  }

  return {
    ok: differences.length === 0,
    executableBitChecked,
    bundleIdentity: tree.bundleIdentity,
    commitId: tree.commitId,
    fileCount: tree.files.size,
    differences: differences.sort((left, right) => compareStrings(left.path, right.path)),
  };
}
