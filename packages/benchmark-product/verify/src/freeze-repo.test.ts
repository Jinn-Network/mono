// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the deterministic freeze-repository projection (issue #2870), driven by a
 * hand-built authenticated snapshot so every rule is exercised without a full bundle build. The
 * real end-to-end path (materialize a v4 bundle, export, check, tamper) is core's integration
 * test; this file owns the rendering rules themselves.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BUNDLE_V8_FORMAT,
  SUPPORTED_BUNDLE_FORMATS,
  type SupportedBundleFormat,
  type VerifiedBundleSnapshot,
} from "./manifest.js";
import { BUNDLE_FORMAT, BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT } from "./legacy-closures.js";
import { BUNDLE_V4_EVIDENCE_ROLES } from "./schema.js";
import {
  FREEZE_REPO_BUNDLE_SUPPORT,
  FREEZE_REPO_EXCLUDED_ROLES,
  FREEZE_REPO_FORMAT,
  FREEZE_REPO_MANIFEST_FILENAME,
  FREEZE_REPO_ROLES,
  probeExecutableBit,
  freezeRepoCommitId,
  listTree,
  renderFreezeRepo,
} from "./freeze-repo.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

const SOURCE_BYTES = encoder.encode("the licensed upstream source document\n");
const SOURCE_DIGEST = sha256Hex(SOURCE_BYTES);

const SECOND_SOURCE_DIGEST = sha256Hex(encoder.encode("a second licensed source\n"));

function sourceRow(digest: string, suffix: string): string {
  return JSON.stringify({
    protocol: "https://spec.jinn.network/binary-judgment/source-manifest-entry/v1",
    provenanceSha256: `sha256:${digest}`,
    source: { uri: `https://example.test/source-${suffix}.json`, digest: { sha256: digest } },
    license: { uri: `https://example.test/LICENSE-${suffix}.txt`, digest: { sha256: "b".repeat(64) } },
    attribution: { uri: `https://example.test/ATTRIBUTION-${suffix}.txt`, digest: { sha256: "c".repeat(64) } },
    publishedAt: "2026-01-02T03:04:05Z",
  });
}

// Real JSONL: two rows, so the extension rule sees bytes that are not a single JSON document.
const SOURCE_MANIFEST_BYTES = encoder.encode(
  `${[sourceRow(SOURCE_DIGEST, "one"), sourceRow(SECOND_SOURCE_DIGEST, "two")].join("\n")}\n`,
);

const ITEM_BANK_BYTES = canonical({
  protocol: "https://spec.jinn.network/binary-judgment/item-bank-entry/v1",
  entries: 1,
});
const SAMPLING_SCRIPT_BYTES = encoder.encode("#!/usr/bin/env python3\nprint('sample')\n");

interface SnapshotOverrides {
  readonly benchmark?: Record<string, unknown>;
  readonly format?: SupportedBundleFormat;
  readonly records?: readonly { readonly bytes: Uint8Array; readonly roles: readonly string[] }[];
}

function snapshotOf(overrides: SnapshotOverrides = {}): VerifiedBundleSnapshot {
  const records = overrides.records ?? [
    { bytes: ITEM_BANK_BYTES, roles: ["item-bank"] },
    { bytes: SOURCE_MANIFEST_BYTES, roles: ["source-manifest"] },
    { bytes: SOURCE_BYTES, roles: ["source-item"] },
    { bytes: SAMPLING_SCRIPT_BYTES, roles: ["screening-sampling-script"] },
    // Not a freeze artifact: the execution graph is the claim, and the claim stays in the bundle.
    { bytes: canonical({ verdict: true }), roles: ["verdict"] },
  ];
  const benchmark = overrides.benchmark ?? {
    protocol: "https://spec.jinn.network/benchmarking/v1",
    name: "LoCoMo judge freeze",
    description: "synthetic",
    version: "1.2.3",
    author: "did:key:zSynthetic",
    license: "CC-BY-NC-4.0",
    citation: "Colophon, LoCoMo judge freeze, 2026.",
    items: [],
    reveal: { policy: "immediate" },
  };
  const evidence = {
    format: "benchmark-product-evidence-catalog/4",
    records: records
      .map((record) => ({ sha256: sha256Hex(record.bytes), roles: record.roles }))
      .sort((left, right) => (left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)),
  };
  const fileBytes = new Map<string, Uint8Array>([
    ["benchmark.json", canonical(benchmark)],
    ["evidence.json", canonical(evidence)],
    ["qualification.json", canonical({ format: "benchmark-product-binary-qualification/1" })],
    ["bundle.json", canonical({ format: overrides.format ?? BUNDLE_V4_FORMAT, files: [] })],
  ]);
  for (const record of records) fileBytes.set(`records/${sha256Hex(record.bytes)}.bin`, record.bytes);
  return {
    manifest: { format: overrides.format ?? BUNDLE_V4_FORMAT, files: [] } as VerifiedBundleSnapshot["manifest"],
    bytes: fileBytes.get("bundle.json")!,
    identity: "a".repeat(64),
    fileBytes,
  };
}

function readManifest(tree: ReturnType<typeof renderFreezeRepo>): Record<string, any> {
  return JSON.parse(decoder.decode(tree.files.get(FREEZE_REPO_MANIFEST_FILENAME)!)) as Record<string, any>;
}

describe("freeze repository rendering", () => {
  test("the same bundle regenerates a byte-identical tree", () => {
    const first = renderFreezeRepo(snapshotOf());
    const second = renderFreezeRepo(snapshotOf());

    expect([...second.files.keys()]).toEqual([...first.files.keys()]);
    for (const [path, bytes] of first.files) {
      expect(sha256Hex(second.files.get(path)!), path).toBe(sha256Hex(bytes));
    }
    expect(second.commitId).toBe(first.commitId);
    expect(first.format).toBe(FREEZE_REPO_FORMAT);
  });

  test("groups freeze records under their catalog roles and leaves the execution graph out", () => {
    const tree = renderFreezeRepo(snapshotOf());
    const paths = [...tree.files.keys()];

    expect(paths).toContain(`artifacts/item-bank/${sha256Hex(ITEM_BANK_BYTES)}.json`);
    expect(paths).toContain(`artifacts/source-manifest/${sha256Hex(SOURCE_MANIFEST_BYTES)}.bin`);
    expect(paths).toContain(`artifacts/screening-sampling-script/${sha256Hex(SAMPLING_SCRIPT_BYTES)}.bin`);
    expect(paths.some((path) => path.startsWith("artifacts/verdict/"))).toBe(false);
    // Exact sealed bytes, never a re-serialization.
    expect(tree.files.get(`artifacts/source-item/${SOURCE_DIGEST}.bin`)).toEqual(SOURCE_BYTES);
  });

  test("copies the framing bundle members byte for byte", () => {
    const snapshot = snapshotOf();
    const tree = renderFreezeRepo(snapshot);

    for (const member of ["bundle.json", "benchmark.json", "evidence.json", "qualification.json"]) {
      expect(tree.files.get(`bundle/${member}`), member).toEqual(snapshot.fileBytes.get(member));
    }
  });

  test("freeze.json lists every other path with its length and digest, sorted, and never itself", () => {
    const tree = renderFreezeRepo(snapshotOf());
    const manifest = readManifest(tree);
    const listed = manifest["files"] as { path: string; bytes: number; sha256: string }[];

    expect(listed.map((entry) => entry.path)).not.toContain(FREEZE_REPO_MANIFEST_FILENAME);
    expect(listed.map((entry) => entry.path)).toEqual([...listed.map((entry) => entry.path)].sort());
    expect(new Set(listed.map((entry) => entry.path)))
      .toEqual(new Set([...tree.files.keys()].filter((path) => path !== FREEZE_REPO_MANIFEST_FILENAME)));
    for (const entry of listed) {
      const bytes = tree.files.get(entry.path)!;
      expect(entry.bytes, entry.path).toBe(bytes.length);
      expect(entry.sha256, entry.path).toBe(sha256Hex(bytes));
    }
    expect(manifest["bundle"]).toEqual({ identity: "a".repeat(64), format: BUNDLE_V4_FORMAT });
    expect(manifest["format"]).toBe(FREEZE_REPO_FORMAT);
  });

  test("freeze.json pins each role's protocol identifier from the record bytes themselves", () => {
    const manifest = readManifest(renderFreezeRepo(snapshotOf()));
    const roles = manifest["roles"] as { role: string; files: number; protocols: string[] }[];

    expect(roles.find((entry) => entry.role === "item-bank")?.protocols)
      .toEqual(["https://spec.jinn.network/binary-judgment/item-bank-entry/v1"]);
    // Non-JSON sealed bytes declare no protocol; the role is still listed, with none.
    expect(roles.find((entry) => entry.role === "screening-sampling-script")?.protocols).toEqual([]);
    // Frozen role order, not catalog or insertion order.
    const order = roles.map((entry) => FREEZE_REPO_ROLES.indexOf(entry.role as never));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  test("generates LICENSE, NOTICE, and SPDX metadata from the bundle's own licence data", () => {
    const tree = renderFreezeRepo(snapshotOf());
    const license = decoder.decode(tree.files.get("LICENSE")!);
    const notice = decoder.decode(tree.files.get("NOTICE")!);
    const spdx = JSON.parse(decoder.decode(tree.files.get("metadata/spdx.json")!)) as Record<string, any>;

    expect(license).toContain("SPDX-License-Identifier: CC-BY-NC-4.0");
    expect(license).toContain("https://spdx.org/licenses/CC-BY-NC-4.0.html");
    expect(license).toContain("Colophon, LoCoMo judge freeze, 2026.");

    expect(notice).toContain(`source sha256:${SOURCE_DIGEST}`);
    expect(notice).toContain("https://example.test/LICENSE-one.txt");
    expect(notice).toContain(`sha256:${"b".repeat(64)}`);
    expect(notice).toContain("https://example.test/ATTRIBUTION-two.txt");
    // The modification notice the licence brief asks for, and it must not invert the fact: the
    // bundle carries NO upstream source bytes, so no member is an unmodified upstream copy.
    expect(notice).toContain("No member of this repository is an unmodified copy of an upstream source");
    expect(notice).toContain("Colophon-authored or Colophon-derived sealed record");
    expect(notice).not.toMatch(/artifacts\/source-item\/[^\n]*unmodified/);

    expect(spdx["spdxVersion"]).toBe("SPDX-2.3");
    expect(spdx["SPDXID"]).toBe("SPDXRef-DOCUMENT");
    expect(spdx["dataLicense"]).toBe("CC0-1.0");
    // Fixed instant, not a real one: a real creation time would make two renders differ.
    expect(spdx["creationInfo"]["created"]).toBe("1970-01-01T00:00:00Z");
    expect(spdx["documentDescribes"]).toEqual(["SPDXRef-Package-Freeze"]);
    expect(spdx["packages"][0]["licenseDeclared"]).toBe("CC-BY-NC-4.0");
    expect(spdx["packages"]).toHaveLength(3);
    expect(spdx["packages"].slice(1).map((entry: any) => entry.checksums[0].checksumValue).sort())
      .toEqual([SOURCE_DIGEST, SECOND_SOURCE_DIGEST].sort());
  });

  test("the README states the derived-artifact doctrine and the check that proves the tree", () => {
    const readme = decoder.decode(renderFreezeRepo(snapshotOf()).files.get("README.md")!);

    expect(readme).toContain("derived artifact");
    expect(readme).toContain("sole source of truth");
    expect(readme).toContain("colophon freeze-repo verify");
  });

  test("the published commit recipe neutralizes the reader's own git configuration", () => {
    // The recipe's only purpose is that a third party independently reproduces the pinned oid. A
    // reader's `commit.gpgsign`, `core.autocrlf`, or a `core.excludesFile` matching `*.bin` each
    // yields a different oid — the last of them silently — so the isolation the renderer's own
    // parity test uses has to be part of the published recipe, not left implicit.
    const readme = decoder.decode(renderFreezeRepo(snapshotOf()).files.get("README.md")!);

    expect(readme).toContain("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null");
    expect(readme).toContain("git add -A -f");
    expect(readme).toContain("--no-gpg-sign");
  });

  test("refuses a bundle with no qualification graph rather than emitting an empty repository", () => {
    expect(() => renderFreezeRepo(snapshotOf({ format: BUNDLE_FORMAT })))
      .toThrow(/requires a qualification bundle/);
  });

  test("names every accepted format when it refuses one that is not accepted", () => {
    // A hand-written list in the message is how this refusal came to name a stale accept set
    // (issue #3540). It is generated from the support table, so it cannot go stale again.
    const accepted = SUPPORTED_BUNDLE_FORMATS.filter((format) => FREEZE_REPO_BUNDLE_SUPPORT[format].qualification);
    expect(accepted.length).toBeGreaterThan(1);
    let message: string | undefined;
    try {
      renderFreezeRepo(snapshotOf({ format: BUNDLE_FORMAT }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, "a bundle with no qualification graph must be refused").toBeDefined();
    for (const format of accepted) expect(message!, format).toContain(format);
    // Three or more accepted formats read as a list, not a chain of `or`.
    const tail = accepted.length >= 3
      ? `${accepted[accepted.length - 2]}, or ${accepted[accepted.length - 1]}`
      : accepted.join(" or ");
    expect(message!).toContain(tail);
  });

  test("renders the disclosed closure: its freeze graph is the anchored qualification graph", () => {
    // `/8` is `/7`'s member list plus a claim-side disclosure record whose evidence role is not a
    // freeze-artifact role, so the freeze artifacts are identical and only the recorded format
    // differs.
    const v7 = renderFreezeRepo(snapshotOf({ format: BUNDLE_V7_FORMAT }));
    const v8 = renderFreezeRepo(snapshotOf({ format: BUNDLE_V8_FORMAT }));

    expect(v8.bundleFormat).toBe(BUNDLE_V8_FORMAT);
    expect(readManifest(v8)["bundle"]).toEqual({ identity: "a".repeat(64), format: BUNDLE_V8_FORMAT });
    // Same artifacts, byte for byte: only the bytes that name the format may differ.
    for (const [path, bytes] of v7.files) {
      if (path.startsWith("artifacts/")) expect(v8.files.get(path), path).toEqual(bytes);
    }
    expect([...v8.files.keys()].sort()).toEqual([...v7.files.keys()].sort());
  });

  test("tells a disclosed-closure reader where the disclosure record is, and says nothing to others", () => {
    // A `/8` reader has a specific reason to look for the disclosure record in the tree. Saying so
    // unconditionally would change every already-published v4 and v7 tree, which is the silent
    // drift `FREEZE_REPO_FORMAT` exists to prevent -- so the sentence is a function of the format.
    const disclosed = decoder.decode(renderFreezeRepo(snapshotOf({ format: BUNDLE_V8_FORMAT })).files.get("README.md")!);
    expect(disclosed).toContain("disclosure-specification record");
    expect(disclosed).toContain("claim");

    for (const format of [BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT] as const) {
      const readme = decoder.decode(renderFreezeRepo(snapshotOf({ format })).files.get("README.md")!);
      expect(readme, format).not.toContain("disclosure-specification record");
    }
  });

  test("refuses when the Benchmark record declares no licence", () => {
    const benchmark = {
      protocol: "https://spec.jinn.network/benchmarking/v1",
      name: "Unlicensed", description: "", version: "1.0.0",
      items: [], reveal: { policy: "immediate" },
    };
    expect(() => renderFreezeRepo(snapshotOf({ benchmark }))).toThrow(/declares no licence/);
  });

  test("refuses a catalog that assigns no freeze-artifact role", () => {
    expect(() => renderFreezeRepo(snapshotOf({ records: [{ bytes: canonical({ v: 1 }), roles: ["verdict"] }] })))
      .toThrow(/no freeze-artifact role/);
  });
});

/**
 * The rendered bytes, pinned. `snapshotOf()` takes nothing from the clock, the locale, the
 * filesystem, or a tool version, so the tree it renders has exactly one commit oid — which makes
 * a literal the only assertion in this file that a renderer change cannot satisfy by construction.
 * Reflowing one NOTICE line, adding an SPDX field, or reordering `freeze.json` all move it.
 *
 * When it fails, that is the design working. Read the diff, decide whether the change is intended,
 * and if it is, bump `FREEZE_REPO_FORMAT` — every already-published tree stops verifying against
 * its bundle otherwise — then update this literal in the same change.
 */
const GOLDEN_COMMIT_ID = "65bfe7cc80f038772fcd5fb9b5f75b91e66bc7fc";

describe("freeze repository rendered bytes", () => {
  test("renders to the pinned commit id, so a renderer change is a format bump and not silent drift", () => {
    expect(renderFreezeRepo(snapshotOf()).commitId).toBe(GOLDEN_COMMIT_ID);
  });

  test("carries exactly the catalog roles that are not named as excluded", () => {
    // Both lists are literal, so this is not the tautology of checking a constant against itself:
    // a role appended to BUNDLE_V4_EVIDENCE_ROLES appears in neither, and the projection would
    // otherwise omit its evidence from every published tree while still reporting ok.
    const excluded = new Set<string>(FREEZE_REPO_EXCLUDED_ROLES);
    expect([...FREEZE_REPO_ROLES])
      .toEqual(BUNDLE_V4_EVIDENCE_ROLES.filter((role) => !excluded.has(role)));
  });
});

describe("freeze repository bundle-format support table", () => {
  test("states a decision for every supported bundle format", () => {
    // The guard used to enumerate two formats inline, so a closure version could land beside it
    // and be refused for its version alone (issue #3540). The table is keyed by the supported
    // union, so a new format is a type error until someone writes its row; this is the same
    // check at runtime, for a build that widens the union without widening the type.
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      expect(FREEZE_REPO_BUNDLE_SUPPORT[format], format).toBeDefined();
      expect(typeof FREEZE_REPO_BUNDLE_SUPPORT[format].qualification, format).toBe("boolean");
      expect(typeof FREEZE_REPO_BUNDLE_SUPPORT[format].disclosure, format).toBe("boolean");
    }
    expect(Object.keys(FREEZE_REPO_BUNDLE_SUPPORT).sort()).toEqual([...SUPPORTED_BUNDLE_FORMATS].sort());
  });

  test("accepts exactly the qualification-carrying closures", () => {
    expect(SUPPORTED_BUNDLE_FORMATS.filter((format) => FREEZE_REPO_BUNDLE_SUPPORT[format].qualification))
      .toEqual([BUNDLE_V4_FORMAT, BUNDLE_V7_FORMAT, BUNDLE_V8_FORMAT]);
    // A disclosure record is claim-side; carrying one never makes a bundle a freeze subject on
    // its own, and every format that carries one must also carry the qualification graph.
    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      if (FREEZE_REPO_BUNDLE_SUPPORT[format].disclosure) {
        expect(FREEZE_REPO_BUNDLE_SUPPORT[format].qualification, format).toBe(true);
      }
    }
  });
});

describe("the verifier README's accepted-format list", () => {
  test("names exactly the closures the export accepts", () => {
    // A third party reads this section to learn which bundles the projection takes, and it
    // enumerated the accepted versions by hand -- the same shape that let `/8` be refused for its
    // version alone (issue #3540). `PUBLIC-BUNDLE.md` is pinned to the support table by the
    // product's docs-consistency suite; this pins the copy that ships in the npm tarball.
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const start = readme.indexOf("\n## Freeze-artifact repositories\n");
    expect(start, "the freeze-artifact section must exist").toBeGreaterThan(-1);
    const rest = readme.indexOf("\n## ", start + 1);
    const section = readme.slice(start, rest === -1 ? undefined : rest);

    for (const format of SUPPORTED_BUNDLE_FORMATS) {
      // The section speaks in short names (`v8`), not whole format strings.
      const shortName = `v${format.slice(format.lastIndexOf("/") + 1)}`;
      const accepted = FREEZE_REPO_BUNDLE_SUPPORT[format].qualification;
      expect(section.includes(shortName), `${format} accepted=${accepted}`).toBe(accepted);
    }
  });
});

describe("freeze repository commit id", () => {
  test("is the value a freeze announcement pins: a real git commit oid over the rendered tree", () => {
    const tree = renderFreezeRepo(snapshotOf());
    expect(tree.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(freezeRepoCommitId(tree.files, tree.bundleIdentity)).toBe(tree.commitId);
  });

  test("moves when any byte, path, or bundle identity moves", () => {
    const files = new Map([["a.txt", encoder.encode("one")], ["dir/b.txt", encoder.encode("two")]]);
    const base = freezeRepoCommitId(files, "identity");

    expect(freezeRepoCommitId(new Map([["a.txt", encoder.encode("one!")], ["dir/b.txt", encoder.encode("two")]]), "identity"))
      .not.toBe(base);
    expect(freezeRepoCommitId(new Map([["a.txt", encoder.encode("one")], ["dir/c.txt", encoder.encode("two")]]), "identity"))
      .not.toBe(base);
    expect(freezeRepoCommitId(files, "other-identity")).not.toBe(base);
    // Insertion order is not identity: the tree is sorted before it is hashed.
    expect(freezeRepoCommitId(new Map([["dir/b.txt", encoder.encode("two")], ["a.txt", encoder.encode("one")]]), "identity"))
      .toBe(base);
  });
});

describe("freeze repository commit id agrees with git itself", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("git commits the rendered tree to the same oid this module computes", () => {
    const tree = renderFreezeRepo(snapshotOf());
    const root = mkdtempSync(join(tmpdir(), "freeze-repo-git-"));
    roots.push(root);
    for (const [path, bytes] of tree.files) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          // A contributor's global core.autocrlf / init.templateDir / core.hooksPath must not
          // reach this comparison: the point is what git does with the rendered bytes, alone.
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "Colophon", GIT_AUTHOR_EMAIL: "freeze@colophon.invalid",
          GIT_AUTHOR_DATE: "@0 +0000",
          GIT_COMMITTER_NAME: "Colophon", GIT_COMMITTER_EMAIL: "freeze@colophon.invalid",
          GIT_COMMITTER_DATE: "@0 +0000",
        },
      }).trim();

    git("init", "--quiet");
    git("add", "-A");
    const treeOid = git("write-tree");
    const commitOid = execFileSync("git", ["-C", root, "commit-tree", treeOid, "-m", `Colophon freeze ${tree.bundleIdentity}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Colophon", GIT_AUTHOR_EMAIL: "freeze@colophon.invalid",
        GIT_AUTHOR_DATE: "@0 +0000",
        GIT_COMMITTER_NAME: "Colophon", GIT_COMMITTER_EMAIL: "freeze@colophon.invalid",
        GIT_COMMITTER_DATE: "@0 +0000",
      },
    }).trim();

    expect(tree.commitId).toBe(commitOid);
  });
});

describe("freeze repository fail-closed rules", () => {
  test("cites no SPDX list address for a LicenseRef identifier, and says the check is grammar", () => {
    // The grammar check is not list membership, so a rendered "canonical licence text" URL would be
    // a claim the export cannot back. `LicenseRef-` is the one case SPDX itself settles: it names a
    // licence the list does not carry, so no address is emitted at all.
    const licenseRef = renderFreezeRepo(snapshotOf({
      benchmark: {
        protocol: "https://spec.jinn.network/benchmarking/v1",
        name: "Off-list", description: "", version: "1.0.0",
        license: "LicenseRef-Internal-1",
        items: [], reveal: { policy: "immediate" },
      },
    }));
    const offList = decoder.decode(licenseRef.files.get("LICENSE")!);
    expect(offList).toContain("SPDX-License-Identifier: LicenseRef-Internal-1");
    expect(offList).not.toContain("spdx.org/licenses/");
    expect(offList).toContain("the list does not carry");

    // For every other identifier the address is emitted, and the file states plainly that the
    // export checked the grammar and not the list, so an off-list identifier will not resolve.
    const listed = decoder.decode(renderFreezeRepo(snapshotOf()).files.get("LICENSE")!);
    expect(listed).toContain("https://spdx.org/licenses/CC-BY-NC-4.0.html");
    expect(listed).toContain("not against the list");
  });

  test("refuses a licence that is not an SPDX short identifier", () => {
    const benchmark = {
      protocol: "https://spec.jinn.network/benchmarking/v1",
      name: "Free text", description: "", version: "1.0.0",
      license: "internal use only",
      items: [], reveal: { policy: "immediate" },
    };
    // Rendering it would put `SPDX-License-Identifier: internal use only` and a dead spdx.org URL
    // into a licence-bearing file.
    expect(() => renderFreezeRepo(snapshotOf({ benchmark }))).toThrow(/not an SPDX short identifier/);
  });

  test("carries every screening role the catalog can assign, including the transcript", () => {
    // The screening branch's records are freeze artifacts; omitting one silently would drop
    // evidence from the published tree with nothing in it saying so.
    for (const role of ["screening-transcript", "screening-sampling-script", "screening-prompt", "screening-raw-outputs"]) {
      expect(FREEZE_REPO_ROLES, role).toContain(role);
    }
  });

  test("freeze.json does not restate the schema-parsed source rows", () => {
    // They are carried byte-for-byte under artifacts/source-manifest/; re-serializing them would
    // make these bytes a function of the verifier's schema shape as well as of the bundle.
    expect(readManifest(renderFreezeRepo(snapshotOf()))["sources"]).toBeUndefined();
  });
});

describe("published-tree enumeration", () => {
  const trees: string[] = [];

  afterEach(() => {
    for (const dir of trees.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function treeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "freeze-repo-walk-"));
    trees.push(dir);
    return dir;
  }

  // Issue #3349: a filesystem that reports a constant mode (0777 on exFAT, on a Windows-hosted
  // mount, on some network filesystems) must not turn a byte-perfect clone into total drift.
  test("the executable bit is ignored where the filesystem does not carry one", () => {
    const dir = treeDir();
    writeFileSync(join(dir, "README.md"), "text\n");
    chmodSync(join(dir, "README.md"), 0o777);

    expect(listTree(dir, false)).toEqual([{ path: "README.md", plainFile: true, executable: false }]);
  });

  test("only the owner bit selects mode 100755, as git records it", () => {
    const dir = treeDir();
    writeFileSync(join(dir, "group-only"), "text\n");
    chmodSync(join(dir, "group-only"), 0o645);
    writeFileSync(join(dir, "owner"), "text\n");
    chmodSync(join(dir, "owner"), 0o755);

    expect(listTree(dir, true)).toEqual([
      { path: "group-only", plainFile: true, executable: false },
      { path: "owner", plainFile: true, executable: true },
    ]);
  });

  // A linked worktree or a submodule checkout carries `.git` as a regular FILE, not a directory.
  test("a root .git file is git metadata, not an unexpected member", () => {
    const dir = treeDir();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/clone\n");
    writeFileSync(join(dir, "README.md"), "text\n");

    expect(listTree(dir, false).map((entry) => entry.path)).toEqual(["README.md"]);
  });

  test("a nested .git is still ordinary content", () => {
    const dir = treeDir();
    mkdirSync(join(dir, "artifacts", ".git"), { recursive: true });
    writeFileSync(join(dir, "artifacts", ".git", "payload"), "smuggled\n");

    expect(listTree(dir, false).map((entry) => entry.path)).toEqual(["artifacts/.git/payload"]);
  });

  test("a symlink is reported as not a plain file", () => {
    const dir = treeDir();
    writeFileSync(join(dir, "payload"), "text\n");
    symlinkSync(join(dir, "payload"), join(dir, "LICENSE"));

    const entries = listTree(dir, true);
    expect(entries.find((entry) => entry.path === "LICENSE")).toEqual({
      path: "LICENSE",
      plainFile: false,
      executable: false,
    });
  });

  test("the filesystem probe answers for a real POSIX temp directory and leaves nothing behind", () => {
    const dir = treeDir();

    expect(probeExecutableBit(dir)).toBe("carried");
    expect(listTree(dir, true)).toEqual([]);
  });

  test("the probe uses the repository's own .git and leaves neither directory changed", () => {
    const dir = treeDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "README.md"), "text\n");

    expect(probeExecutableBit(dir)).toBe("carried");
    expect(readdirSync(join(dir, ".git"))).toEqual([]);
    expect(listTree(dir, true).map((entry) => entry.path)).toEqual(["README.md"]);
  });

  // A linked worktree and a submodule checkout carry a regular FILE at `.git`, which is the
  // configuration the root-`.git` skip exists to support, so the probe has nowhere but the tree.
  test("a .git file leaves the tree as the only probe site, and the tree is left clean", () => {
    const dir = treeDir();
    writeFileSync(join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/tree\n");
    writeFileSync(join(dir, "README.md"), "text\n");

    expect(probeExecutableBit(dir)).toBe("carried");
    expect(listTree(dir, true).map((entry) => entry.path)).toEqual(["README.md"]);
  });

  // A site that refuses the write says nothing about the filesystem, so the dimension must not be
  // dropped while another site on the same device is still writable. Skipped under root, which
  // writes through a read-only directory and so would pass either way — a green assertion that
  // proves nothing is worse than an honest skip.
  test.skipIf(process.geteuid?.() === 0)("a .git that refuses the probe falls back to the tree", () => {
    const dir = treeDir();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "README.md"), "text\n");
    chmodSync(join(dir, ".git"), 0o555);

    try {
      expect(probeExecutableBit(dir)).toBe("carried");
      expect(readdirSync(join(dir, ".git"))).toEqual([]);
      expect(listTree(dir, true).map((entry) => entry.path)).toEqual(["README.md"]);
    } finally {
      chmodSync(join(dir, ".git"), 0o755);
    }
  });

  // The cross-device rejection that issue #3605 is about cannot be built in a unit test: it needs a
  // second filesystem. The device comparison in `probeSites` is what enforces it.

  test.skipIf(process.geteuid?.() === 0)("no writable site at all drops the dimension rather than throwing", () => {
    const dir = treeDir();
    writeFileSync(join(dir, "README.md"), "text\n");
    chmodSync(dir, 0o555);

    try {
      expect(probeExecutableBit(dir)).toBe("not-probed");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("the probe reports that it could not be run rather than throwing", () => {
    expect(probeExecutableBit(join(treeDir(), "does-not-exist"))).toBe("not-probed");
  });
});
