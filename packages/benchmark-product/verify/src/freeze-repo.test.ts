// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the deterministic freeze-repository projection (issue #2870), driven by a
 * hand-built authenticated snapshot so every rule is exercised without a full bundle build. The
 * real end-to-end path (materialize a v4 bundle, export, check, tamper) is core's integration
 * test; this file owns the rendering rules themselves.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BUNDLE_FORMAT, BUNDLE_V4_FORMAT, type VerifiedBundleSnapshot } from "./manifest.js";
import {
  FREEZE_REPO_FORMAT,
  FREEZE_REPO_MANIFEST_FILENAME,
  FREEZE_REPO_ROLES,
  freezeRepoCommitId,
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

const SOURCE_MANIFEST_BYTES = encoder.encode(`${JSON.stringify({
  protocol: "https://spec.jinn.network/binary-judgment/source-manifest-entry/v1",
  provenanceSha256: `sha256:${SOURCE_DIGEST}`,
  source: { uri: "https://example.test/source.json", digest: { sha256: SOURCE_DIGEST } },
  license: { uri: "https://example.test/LICENSE.txt", digest: { sha256: "b".repeat(64) } },
  attribution: { uri: "https://example.test/ATTRIBUTION.txt", digest: { sha256: "c".repeat(64) } },
  publishedAt: "2026-01-02T03:04:05Z",
})}\n`);

const ITEM_BANK_BYTES = canonical({
  protocol: "https://spec.jinn.network/binary-judgment/item-bank-entry/v1",
  entries: 1,
});
const SAMPLING_SCRIPT_BYTES = encoder.encode("#!/usr/bin/env python3\nprint('sample')\n");

interface SnapshotOverrides {
  readonly benchmark?: Record<string, unknown>;
  readonly format?: typeof BUNDLE_V4_FORMAT | typeof BUNDLE_FORMAT;
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
    format: "benchmark-product.bundle-evidence/2",
    records: records
      .map((record) => ({ sha256: sha256Hex(record.bytes), roles: record.roles }))
      .sort((left, right) => (left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)),
  };
  const fileBytes = new Map<string, Uint8Array>([
    ["benchmark.json", canonical(benchmark)],
    ["evidence.json", canonical(evidence)],
    ["qualification.json", canonical({ format: "benchmark-product.bundle-qualification/1" })],
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
    expect(notice).toContain("https://example.test/LICENSE.txt");
    expect(notice).toContain(`sha256:${"b".repeat(64)}`);
    expect(notice).toContain("https://example.test/ATTRIBUTION.txt");
    // The modification notice the licence brief asks for.
    expect(notice).toContain("artifacts/source-item/");
    expect(notice).toMatch(/unmodified/);
    expect(notice).toMatch(/derived work/i);

    expect(spdx["packages"][0]["licenseDeclared"]).toBe("CC-BY-NC-4.0");
    expect(spdx["packages"][1]["checksums"]).toEqual([{ algorithm: "SHA256", checksumValue: SOURCE_DIGEST }]);
  });

  test("the README states the derived-artifact doctrine and the check that proves the tree", () => {
    const readme = decoder.decode(renderFreezeRepo(snapshotOf()).files.get("README.md")!);

    expect(readme).toContain("derived artifact");
    expect(readme).toContain("sole source of truth");
    expect(readme).toContain("colophon freeze-repo verify");
  });

  test("refuses a bundle with no qualification graph rather than emitting an empty repository", () => {
    expect(() => renderFreezeRepo(snapshotOf({ format: BUNDLE_FORMAT })))
      .toThrow(/requires a qualification bundle/);
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
          GIT_AUTHOR_NAME: "Colophon", GIT_AUTHOR_EMAIL: "freeze@colophon.invalid",
          GIT_AUTHOR_DATE: "0 +0000",
          GIT_COMMITTER_NAME: "Colophon", GIT_COMMITTER_EMAIL: "freeze@colophon.invalid",
          GIT_COMMITTER_DATE: "0 +0000",
        },
      }).trim();

    git("init", "--quiet");
    git("add", "-A");
    const treeOid = git("write-tree");
    const commitOid = execFileSync("git", ["-C", root, "commit-tree", treeOid, "-m", `Colophon freeze ${tree.bundleIdentity}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Colophon", GIT_AUTHOR_EMAIL: "freeze@colophon.invalid",
        GIT_AUTHOR_DATE: "0 +0000",
        GIT_COMMITTER_NAME: "Colophon", GIT_COMMITTER_EMAIL: "freeze@colophon.invalid",
        GIT_COMMITTER_DATE: "0 +0000",
      },
    }).trim();

    expect(tree.commitId).toBe(commitOid);
  });
});
