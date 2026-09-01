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

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT, type VerifiedBundleSnapshot } from "./manifest.js";
import { BundleV4EvidenceCatalogSchema, type BundleV4EvidenceRole } from "./schema.js";
import { BinarySourceManifestEntrySchema, type BinarySourceManifestEntry } from "./admission/intake.js";
import { refuse } from "./profile/errors.js";
import { verifyPublicBundleSnapshot } from "./verify.js";
import type { VerifyPublicBundleDeps } from "./verify.js";

export const FREEZE_REPO_FORMAT = "colophon-freeze-repo/1" as const;

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

function insert(root: TreeNode, path: string, bytes: Uint8Array): void {
  const segments = path.split("/");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    let next = node.directories.get(segment);
    if (next === undefined) {
      next = emptyNode();
      node.directories.set(segment, next);
    }
    node = next;
  }
  node.files.set(segments[segments.length - 1]!, bytes);
}

/**
 * Git's tree ordering compares a directory entry as if its name ended in "/" — the one rule that
 * makes a hand-built tree object hash the same as one `git write-tree` would produce.
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
  ].sort((left, right) => compareStrings(left.sortKey, right.sortKey));

  const body = Buffer.concat(
    entries.map((entry) => Buffer.concat([Buffer.from(text(`${entry.mode} ${entry.name}\0`)), entry.id])),
  );
  return gitObjectId("tree", body);
}

/**
 * The commit id for a rendered tree: a real git commit object over a real git tree, computed
 * in-process. No `git` binary, no working directory, no index — so the value is a function of the
 * bundle rather than of whatever machine happened to run the export.
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
  if (typeof license === "string" && license.length > 0 && !SPDX_IDENTIFIER.test(license)) {
    refuse(
      "record-integrity",
      "benchmark.json.license",
      `the sealed Benchmark record's licence "${license}" is not an SPDX short identifier; a freeze repository renders it as one and will not present free text as a licence identifier`,
    );
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
      ? [`${publication.license} is a LicenseRef identifier, which SPDX defines as a licence the list does not carry, so there is no list entry to cite for it.`]
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
        ...(publication.author === undefined ? {} : { supplier: `Organization: ${publication.author}` }),
      },
      ...sources.map((source, index) => ({
        SPDXID: `SPDXRef-Source-${index + 1}`,
        name: source.source.name ?? source.source.uri,
        downloadLocation: source.source.uri,
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
    "## Roles present",
    "",
  ];
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
  if (bundleFormat !== BUNDLE_V4_FORMAT && bundleFormat !== BUNDLE_V7_FORMAT) {
    // The freeze artifacts ARE the qualification graph. A bundle without one has none, and an
    // empty repository claiming to be a freeze would be worse than a refusal.
    refuse(
      "conflict",
      "bundle.json.format",
      `a freeze repository requires a qualification bundle (${BUNDLE_V4_FORMAT} or ${BUNDLE_V7_FORMAT}); this bundle is ${bundleFormat}`,
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
    renderReadme(publication, snapshot.identity, bundleFormat, roleGroups.map(({ role, files: count }) => ({ role, files: count }))),
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
    occupied = listTree(repoDir);
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
    roles: [...new Set([...tree.files.keys()]
      .filter((path) => path.startsWith("artifacts/"))
      .map((path) => path.split("/")[1]!))],
  };
}

export type FreezeRepoDifferenceKind = "missing" | "unexpected" | "changed";

export interface FreezeRepoDifference {
  readonly path: string;
  readonly kind: FreezeRepoDifferenceKind;
}

export interface FreezeRepoVerificationResult {
  readonly ok: boolean;
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
  readonly executable: boolean;
}

/**
 * Enumerate a published tree the way git sees it. Two rules earn their place:
 *
 * - `.git` is skipped ONLY at the root. A nested `.git` directory is ordinary content to the outer
 *   repository, so skipping it at depth would let a tree carry files the check never looks at.
 * - a symlink is not a file. Reporting it rather than skipping it is what stops
 *   `LICENSE -> /etc/passwd` from reading as a matching member.
 */
function listTree(repoDir: string): readonly TreeEntry[] {
  const found: TreeEntry[] = [];
  const walk = (dir: string, atRoot: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (atRoot && entry.name === ".git") continue;
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
      found.push({ path, plainFile: true, executable: (statSync(absolute).mode & 0o111) !== 0 });
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
  const tree = renderFreezeRepo((await verifyPublicBundleSnapshot(bundleDir, deps)).snapshot);
  const differences: FreezeRepoDifference[] = [];

  let present: readonly TreeEntry[];
  try {
    if (!statSync(repoDir).isDirectory()) throw new Error("not a directory");
    present = listTree(repoDir);
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
    bundleIdentity: tree.bundleIdentity,
    commitId: tree.commitId,
    fileCount: tree.files.size,
    differences: differences.sort((left, right) => compareStrings(left.path, right.path)),
  };
}
