// SPDX-License-Identifier: Apache-2.0

/**
 * #3063: the cold-bundle leak scan must read a bundle's text, not its base64
 * alphabet. Regression cover for the intermittent P8 red: a clean signed
 * record whose base64 happens to spell a leak word is not a leak, while every
 * plain-text leak -- including one inside a decoded payload -- still fails.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BUNDLE_LEAK_PATTERN, findBundleLeaks, findLeaks } from "./leak-scan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function utf8(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"));
}

/**
 * Canonical unpadded-length base64 that spells `word` -- the false positive
 * itself: bytes whose encoding happens to contain a leak keyword.
 */
function base64Spelling(word: string, fill = "A"): string {
  const blob = `${fill.repeat(88 - word.length)}${word}`;
  if (Buffer.from(blob, "base64").toString("base64") !== blob) throw new Error("fixture is not canonical base64");
  return blob;
}

/** A DSSE envelope of the shape every signed record in a bundle has. */
function envelope(payloadBase64: string, signatureBase64: string): string {
  return JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: payloadBase64,
    signatures: [{ keyid: "k1", sig: signatureBase64 }],
  });
}

function payloadOf(document: unknown): string {
  return Buffer.from(JSON.stringify(document), "utf8").toString("base64");
}

const CLEAN_SIGNATURE = Buffer.alloc(64).toString("base64");

describe("bundle leak scan (#3063)", () => {
  test.each(["apikey", "LoCoMo"])("a clean record whose base64 spells %s is not a finding", (word) => {
    const spelling = base64Spelling(word);
    const signed = envelope(payloadOf({ armId: "alpha", verdict: "pass" }), spelling);
    const payloaded = envelope(spelling, CLEAN_SIGNATURE);
    for (const record of [signed, payloaded]) {
      expect(BUNDLE_LEAK_PATTERN.test(record), "the raw record text must contain the word").toBe(true);
      expect(findLeaks(utf8(record), { path: "records/a.bin" })).toEqual([]);
    }
  });

  test("a base64-suffixed field is decoded rather than pattern-matched", () => {
    const report = JSON.stringify({ spkiDerBase64: base64Spelling("apikey") });
    expect(BUNDLE_LEAK_PATTERN.test(report)).toBe(true);
    expect(findLeaks(utf8(report), { path: "report.json" })).toEqual([]);
  });

  test("a plain-text leak in a decoded payload is still a finding", () => {
    const record = envelope(payloadOf({ datasetId: "LoCoMo-v1" }), CLEAN_SIGNATURE);
    const findings = findLeaks(utf8(record), { path: "records/a.bin" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: "records/a.bin", kind: "pattern", match: "LoCoMo" });
    expect(findings[0].where).toContain("base64");
  });

  test("an unnamed string that merely looks like base64 is still text-scanned", () => {
    // The exemption is by field name, never by shape: a value is never skipped
    // because it happens to be spellable in the base64 alphabet.
    const looksLikeBase64 = `corpus/LoCoMo/sessions/train/${"A".repeat(35)}`;
    expect(looksLikeBase64.length % 4).toBe(0);
    expect(findLeaks(utf8(JSON.stringify({ datasetPath: looksLikeBase64 })), { path: "a.json" }))
      .toEqual([expect.objectContaining({ kind: "pattern", match: "LoCoMo" })]);
  });

  test("a leak inside a decoded non-JSON base64 field is a finding", () => {
    const script = Buffer.from("#!/bin/sh\nfetch LoCoMo\n", "utf8").toString("base64");
    const findings = findLeaks(utf8(JSON.stringify({ samplingScriptBase64: script })), { path: "a.json" });
    expect(findings).toEqual([expect.objectContaining({ kind: "pattern", match: "LoCoMo" })]);
    expect(findings[0].where).toBe("raw.samplingScriptBase64 (base64)");
  });

  test("plain-text leaks in ordinary fields, keys, and non-JSON files are still findings", () => {
    expect(findLeaks(utf8(JSON.stringify({ note: "sourced from a licensed benchmark" })), { path: "a.json" }))
      .toHaveLength(1);
    expect(findLeaks(utf8(JSON.stringify({ api_key: "redacted" })), { path: "b.json" })).toHaveLength(1);
    expect(findLeaks(utf8("# README\n\nrun against LoCoMo\n"), { path: "README.md" })).toHaveLength(1);
  });

  test("the workspace path is still refused, raw and inside a payload", () => {
    const workspaceDir = "/tmp/judge-p8-rehearsal-abc123";
    expect(findLeaks(utf8(`see ${workspaceDir}/run\n`), { path: "notes.md", workspaceDir }))
      .toEqual([expect.objectContaining({ kind: "workspace-path", where: "raw" })]);
    const record = envelope(payloadOf({ dir: `${workspaceDir}/run` }), CLEAN_SIGNATURE);
    expect(findLeaks(utf8(record), { path: "records/a.bin", workspaceDir }))
      .toEqual([expect.objectContaining({ kind: "workspace-path" })]);
  });

  test("a non-UTF-8 text file is still scanned, as it was before", () => {
    const latin1 = new Uint8Array(Buffer.from("caf\u00e9 sourced from a licensed benchmark\n", "latin1"));
    expect(findLeaks(latin1, { path: "notes.txt" })).toEqual([
      expect.objectContaining({ kind: "pattern", match: "licensed benchmark" }),
    ]);
  });

  test("a URL-safe base64 payload is decoded too, not pattern-matched", () => {
    // DSSE accepts both alphabets (trust-core's decodeBase64Strict), so a
    // URL-safe payload must not fall back to scanning its own alphabet.
    const urlSafe = (standard: string): string => {
      const translated = standard.replaceAll("+", "-").replaceAll("/", "_");
      // Guards the fixtures: a payload with no `+` or `/` decodes identically in
      // either alphabet and would prove nothing about URL-safe handling.
      expect(translated, "fixture must exercise the URL-safe alphabet").not.toBe(standard);
      return translated;
    };

    const clean = envelope(urlSafe(base64Spelling("apikey", "/")), CLEAN_SIGNATURE);
    expect(BUNDLE_LEAK_PATTERN.test(clean)).toBe(true);
    expect(findLeaks(utf8(clean), { path: "records/a.bin" })).toEqual([]);

    // `pad` only makes the encoding use the non-alphanumeric base64 characters.
    const leaky = envelope(urlSafe(payloadOf({ datasetId: "LoCoMo-v1", pad: "\u00ff\u00ff\u00ff" })), CLEAN_SIGNATURE);
    expect(findLeaks(utf8(leaky), { path: "records/b.bin" }))
      .toEqual([expect.objectContaining({ kind: "pattern", match: "LoCoMo" })]);
  });

  test("plain text inside a binary file is still scanned", () => {
    // A `.eval` Inspect log is a ZIP, and a ZIP stores its entry names
    // uncompressed -- the v4 producer closure caught those, so this must too.
    const workspaceDir = "/tmp/judge-p8-rehearsal-abc123";
    const binary = (text: string) => new Uint8Array(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]),
      Buffer.from(text, "utf8"),
      Buffer.from([0xff, 0xfe, 0]),
    ]));
    expect(findLeaks(binary(`${workspaceDir}/run`), { path: "opaque.bin", workspaceDir })).toEqual([
      { path: "opaque.bin", kind: "workspace-path", where: "raw (binary)", match: workspaceDir },
    ]);
    expect(findLeaks(binary("samples/LoCoMo_qa_001.json"), { path: "native/inspect/a.eval" })).toEqual([
      { path: "native/inspect/a.eval", kind: "pattern", where: "raw (binary)", match: "LoCoMo" },
    ]);
    expect(findLeaks(binary("samples/clean_qa_001.json"), { path: "native/inspect/a.eval" })).toEqual([]);
  });

  test("an unpadded base64 payload is decoded too", () => {
    // trust-core's decodeBase64Strict accepts unpadded base64, so a record it
    // verifies must not fall back to scanning its own alphabet here.
    const unpadded = (standard: string): string => standard.replace(/=+$/u, "");
    const leaky = envelope(unpadded(payloadOf({ datasetId: "LoCoMo-v1" })), CLEAN_SIGNATURE);
    expect(findLeaks(utf8(leaky), { path: "records/a.bin" }))
      .toEqual([expect.objectContaining({ kind: "pattern", match: "LoCoMo" })]);
  });

  test("binary files are skipped and a bundle directory is walked whole", () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "leak-scan-"));
    roots.push(bundleDir);
    mkdirSync(join(bundleDir, "records"));
    writeFileSync(join(bundleDir, "records", "a.bin"), envelope(payloadOf({ armId: "alpha" }), CLEAN_SIGNATURE));
    writeFileSync(join(bundleDir, "opaque.bin"), Buffer.from([0, 1, 2, 3, 0]));
    expect(findBundleLeaks(bundleDir)).toEqual([]);
    writeFileSync(join(bundleDir, "records", "b.bin"), envelope(payloadOf({ datasetId: "locomo" }), CLEAN_SIGNATURE));
    expect(findBundleLeaks(bundleDir)).toEqual([
      expect.objectContaining({ path: "records/b.bin", kind: "pattern" }),
    ]);
  });
});
