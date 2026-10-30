// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DSSE_PAYLOAD_TYPE, canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";

import { runCommand } from "./command.js";
import { recordDigest } from "./index.js";

const temporary = mkdtempSync(join(tmpdir(), "jinn-verify-command-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

let directories = 0;

function directory(files: Readonly<Record<string, Uint8Array | string>>): string {
  directories += 1;
  const path = join(temporary, `set-${directories}`);
  mkdirSync(path);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content);
  return path;
}

async function run(...argv: readonly string[]) {
  const output = { stdout: "", stderr: "" };
  const code = await runCommand(argv, {
    stdout: (text) => { output.stdout += text; },
    stderr: (text) => { output.stderr += text; },
  });
  return { code, ...output };
}

const BINARY_JUDGMENT_PROFILE = "ebb34d8362e2cc3135847a5ad6f3ee3d9c2d9922a2b827aa9dfcbaf440b22557";

const task = sealTask({
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  profile: { uri: "https://spec.jinn.network/task-profiles/binary-judgment/2.0", digest: { sha256: BINARY_JUDGMENT_PROFILE } },
  instructions: "Judge the answer.",
  outputs: [{ name: "verdict", mediaType: "application/json", required: true }],
});
const taskDigest = recordDigest(task);

function delivery(overrides: Record<string, unknown> = {}): Uint8Array {
  return sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
    task: taskDigest,
    outputs: [],
    outcome: "fulfilled",
    createdAt: "2026-07-28T00:05:00Z",
    ...overrides,
  });
}

function named(bytes: Uint8Array): readonly [string, Uint8Array] {
  return [`${recordDigest(bytes).slice("sha256:".length)}.bin`, bytes];
}

function evaluation(privateKey: KeyObject, keyid: string): Uint8Array {
  const payloadBytes = canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task", digest: { sha256: taskDigest.slice("sha256:".length) } },
      { name: "result", digest: { sha256: "5".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-07-28T00:10:00Z",
      evaluator: { id: "urn:uuid:11111111-1111-4111-8111-111111111111" },
      verdict: "pass",
      taskSubject: "task",
      resultSubjects: ["result"],
    },
  });
  const signature = new Uint8Array(sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), privateKey));
  return sealDsseEnvelope({ payloadBytes, signatures: [{ keyid, signature }] });
}

function keysFile(entries: readonly { readonly keyId: string; readonly publicKey: KeyObject }[]): string {
  return JSON.stringify({
    evaluators: entries.map(({ keyId, publicKey }) => ({
      keyId,
      spkiDerBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    })),
  });
}

describe("usage and environment errors exit 2", () => {
  test.each([
    ["no path", []],
    ["two paths", ["a", "b"]],
    ["an unknown flag", ["a", "--verbose"]],
    ["--keys with no file", ["a", "--keys"]],
  ])("%s prints usage and reads nothing", async (_name, argv) => {
    const { code, stdout, stderr } = await run(...argv);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("npx @jinn-network/verify <path>");
  });

  test("a path that does not exist", async () => {
    const { code, stderr } = await run(join(temporary, "missing"));
    expect(code).toBe(2);
    expect(stderr).toContain("cannot read");
  });

  test("a directory with no files", async () => {
    const { code, stderr } = await run(directory({}));
    expect(code).toBe(2);
    expect(stderr).toContain("no files");
  });

  test.each([
    ["missing", join(temporary, "no-keys.json")],
    ["not JSON", directory({ "keys.json": "not json" }) + "/keys.json"],
    ["without keys", directory({ "keys.json": "{}" }) + "/keys.json"],
  ])("a keys file %s", async (_name, keys) => {
    const { code, stderr, stdout } = await run(directory(Object.fromEntries([named(task)])), "--keys", keys);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toBe("");
  });
});

describe("a directory of records", () => {
  test("a closed set exits 0 and prints what ran, and only that", async () => {
    const closing = delivery();
    const { code, stdout, stderr } = await run(directory(Object.fromEntries([named(task), named(closing)])));
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.split("\n").slice(1)).toEqual([
      "",
      "Kinds          2 known, 0 unknown naming a type, 0 naming no type",
      "Digest         2 passed",
      "Encoding       2 passed",
      "Schema         2 passed",
      "Signatures     none in these files",
      "Trust binding  skipped: no key was tied to an identity",
      "References     passed: 2 resolved, 1 by a published document",
      "Lifecycle      skipped: no observations here",
      "Anchors        not checked: no anchor records here",
      "",
      "Nothing failed. Skipped and unknown are not passes.",
      "",
    ]);
  });

  test("the header says how many files were read, and from where", async () => {
    const path = directory(Object.fromEntries([named(task)]));
    expect((await run(path)).stdout.split("\n")[0]).toBe(`Read 1 file from ${path}.`);
  });

  test("a name that is not a digest claims none, and that is skipped, not passed", async () => {
    const { stdout, code } = await run(directory({ "task.json": task }));
    expect(code).toBe(0);
    expect(stdout).toContain("Digest         1 skipped (no digest claimed)");
  });

  test("a file whose name is not its digest fails, exits 1, and is named", async () => {
    const closing = delivery();
    const [name] = named(closing);
    const { code, stdout } = await run(directory({ [name]: task }));
    expect(code).toBe(1);
    expect(stdout).toContain("Digest         1 failed");
    expect(stdout).toContain(`${name}: digest:`);
    expect(stdout).toContain("1 record failed");
    expect(stdout).not.toContain("Nothing failed");
  });

  test("a dangling reference exits 1 even when every record passed", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([named(delivery())])));
    expect(code).toBe(1);
    expect(stdout).toContain("References     failed: 1 dangling");
    expect(stdout).toContain("/task");
    expect(stdout).toContain("references failed");
  });

  test("files of unknown kind are counted apart, and no schema is claimed for them", async () => {
    const { code, stdout } = await run(directory({
      "application.json": canonicalJsonBytes({ protocol: "https://spec.jinn.network/binary-judgment/x/v1" }),
      "archive.zip": Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      "note.md": "# A note\n",
    }));
    expect(code).toBe(0);
    expect(stdout).toContain("Kinds          0 known, 1 unknown naming a type, 2 naming no type");
    expect(stdout).toContain("Encoding       1 passed, 2 skipped (not records)");
    expect(stdout).toContain("Schema         3 skipped (kind unknown)");
    expect(stdout).toContain("References     passed for known kinds: 0 resolved");
  });

  test("two reasons for one skip are both counted, the larger first", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "evaluator-key-1";
    const keys = directory({ "keys.json": keysFile([{ keyId, publicKey }]) });
    const { stdout } = await run(directory({
      "a-signed.json": evaluation(privateKey, keyId),
      "b-one.bin": Uint8Array.of(0xff),
      "c-two.bin": Uint8Array.of(0xfe),
    }), "--keys", join(keys, "keys.json"));
    expect(stdout).toContain("Encoding       3 skipped (2 not records, 1 not required by family)");
  });

  test("subdirectories are not walked, and the report says so", async () => {
    const path = directory(Object.fromEntries([named(task)]));
    mkdirSync(join(path, "nested"));
    const { stdout } = await run(path);
    expect(stdout.split("\n")[0]).toBe(`Read 1 file from ${path}, and did not read 1 entry that is not a file.`);
  });

  test("nothing printed uses an em dash", async () => {
    const { stdout } = await run(directory({ "note.md": "# A note\n" }));
    expect(stdout).not.toMatch(/—/u);
  });
});

describe("signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  function evaluated(keyid: string): string {
    return directory(Object.fromEntries([named(task), named(evaluation(privateKey, keyid))]));
  }

  test("with no key, the signature is counted unverified and nothing reads as passed", async () => {
    const { code, stdout } = await run(evaluated("evaluator-key-1"));
    expect(code).toBe(0);
    expect(stdout).toContain("Signatures     1 not verified (no key)");
    expect(stdout).toContain("Trust binding  skipped: no key was tied to an identity");
  });

  test("a supplied key is reported as supplied, and trust binding stays skipped", async () => {
    const keys = directory({ "keys.json": keysFile([{ keyId: "evaluator-key-1", publicKey }]) });
    const { code, stdout } = await run(evaluated("evaluator-key-1"), "--keys", join(keys, "keys.json"));
    expect(code).toBe(0);
    expect(stdout).toContain("Signatures     1 verified against keys you supplied, none unverified");
    expect(stdout).toContain("Trust binding  skipped: no key was tied to an identity");
  });

  test("a signature that does not verify exits 1", async () => {
    const other = generateKeyPairSync("ed25519").publicKey;
    const keys = directory({ "keys.json": keysFile([{ keyId: "evaluator-key-1", publicKey: other }]) });
    const { code, stdout } = await run(evaluated("evaluator-key-1"), "--keys", join(keys, "keys.json"));
    expect(code).toBe(1);
    expect(stdout).toContain("Signatures     1 failed");
  });

  test("a signed record of unknown kind is counted unverified, with that reason", async () => {
    const receipt = sealDsseEnvelope({
      payloadType: "application/vnd.jinn.not-registered.v1+json",
      payloadBytes: canonicalJsonBytes({}),
      signatures: [{ keyid: "evaluator-key-1", signature: Uint8Array.of(1) }],
    });
    const { stdout } = await run(directory({ "receipt.json": receipt }));
    expect(stdout).toContain("Signatures     1 not verified (kind unknown)");
  });

  test("a did:key carries its own key, which is not called supplied", async () => {
    const { didKeyFromEd25519PublicKey } = await import("./index.js");
    const { stdout } = await run(evaluated(didKeyFromEd25519PublicKey(publicKey)));
    expect(stdout).toContain("Signatures     1 verified by the key in their own id, none unverified");
  });
});

describe("one record file", () => {
  test("is checked alone, and no set check is claimed", async () => {
    const path = join(directory({ "delivery.json": delivery() }), "delivery.json");
    const { code, stdout } = await run(path);
    expect(code).toBe(0);
    expect(stdout.split("\n").slice(0, 12)).toEqual([
      `Read 1 file from ${path}.`,
      "",
      "Kinds          1 known, 0 unknown naming a type, 0 naming no type",
      "Digest         1 skipped (no digest claimed)",
      "Encoding       1 passed",
      "Schema         1 passed",
      "Signatures     none in these files",
      "Trust binding  skipped: no key was tied to an identity",
      "References     not checked: one file is not a set",
      "Lifecycle      not checked: one file is not a set",
      "Anchors        not checked: one file is not a set",
      "",
    ]);
  });

  test("that fails exits 1", async () => {
    const path = join(directory({ "task.json": canonicalJsonBytes({ protocol: TASK_EXECUTION_PROTOCOL_URI }) }), "task.json");
    const { code, stdout } = await run(path);
    expect(code).toBe(1);
    expect(stdout).toContain("Schema         1 failed");
  });
});

describe("--json", () => {
  test("prints the structured report, with each record's file", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([named(task)])), "--json");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      summary: { records: number };
      records: { file: string; kind: string }[];
      checks: { id: string; status: string }[];
    };
    expect(report.summary.records).toBe(1);
    expect(report.records[0]).toMatchObject({ file: named(task)[0], kind: "https://spec.jinn.network/records/task/v1" });
    expect(report.checks.map(({ id }) => id)).toEqual(["references", "lifecycle", "anchors"]);
  });

  test("exits 1 on a failure", async () => {
    expect((await run(directory(Object.fromEntries([named(delivery())])), "--json")).code).toBe(1);
  });
});

describe("failures are listed briefly", () => {
  test("after five, the rest are counted", async () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const [, bytes] = named(delivery({ createdAt: `2026-07-28T00:0${index}:00Z` }));
      return [`${"0".repeat(63)}${index}.bin`, bytes];
    }));
    const { stdout, code } = await run(directory(files));
    expect(code).toBe(1);
    expect(stdout).toContain("and 11 more; --json has them all");
    expect(stdout.split("\n").filter((text) => text.startsWith("  "))).toHaveLength(6);
  });
});
