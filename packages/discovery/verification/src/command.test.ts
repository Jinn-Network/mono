// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DSSE_PAYLOAD_TYPE, canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildRfc3161AnchorEvidenceRecord, createFixtureAuthority } from "@jinn-network/trust-testing";

import { MAX_FILE_BYTES, runCommand } from "./command.js";
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

  test("a flag cannot put a control character on stderr", async () => {
    expect((await run("--\u001b[2J")).stderr).not.toContain("\u001b");
  });

  test("a path cannot put a control character on stderr", async () => {
    expect((await run(join(temporary, "missing\u001b[2J"))).stderr).not.toContain("\u001b");
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
      "Digest         2 passed, compared with each file's own name",
      "Encoding       2 passed",
      "Schema         2 passed",
      "Signatures     none in these files",
      "Trust binding  skipped: no key was tied to an identity",
      "References     passed: 2 resolved, 1 by a published document",
      "Lifecycle      skipped: no observations here",
      "Anchors        not checked: no anchor records here",
      "Completeness   not checked: nothing here says which files should exist",
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
    expect(stdout).toContain("References     skipped: no record here has references to read");
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
    expect(stdout).toContain("Signatures     1 not verified (no key)");
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
    expect(stdout.split("\n").slice(0, 13)).toEqual([
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
      "Completeness   not checked: one file is not a set",
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
      formatVersion: number;
      failed: boolean;
      summary: { records: number };
      records: { file: string; kind: string }[];
      checks: { id: string; status: string }[];
    };
    expect(report).toMatchObject({ formatVersion: 1, failed: false });
    expect(report.summary.records).toBe(1);
    expect(report.records[0]).toMatchObject({ file: named(task)[0], kind: "https://spec.jinn.network/records/task/v1" });
    expect(report.checks.map(({ id }) => id)).toEqual(["references", "lifecycle", "anchors"]);
  });

  test("exits 1 on a failure", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([named(delivery())])), "--json");
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ failed: true });
  });
});

describe("a file over the limit", () => {
  function oversized(path: string): string {
    writeFileSync(path, "x");
    truncateSync(path, MAX_FILE_BYTES + 1);
    return path;
  }

  test("is not read, fails the run, and is named", async () => {
    const path = directory(Object.fromEntries([named(task)]));
    oversized(join(path, "huge.bin"));
    const { code, stdout } = await run(path);
    expect(code).toBe(1);
    expect(stdout.split("\n")[0]).toBe(`Read 1 file from ${path}, and did not read 1 file over the size limit.`);
    expect(stdout).toContain("huge.bin: too-large: 2,097,153 bytes is over the limit, so it was not read.");
    expect(stdout).toContain("1 file too large to read.");
    expect(stdout).not.toContain("Nothing failed");
  });

  test("at the limit is read", async () => {
    const path = directory({});
    writeFileSync(join(path, "exact.bin"), "x");
    truncateSync(join(path, "exact.bin"), MAX_FILE_BYTES);
    expect((await run(path)).stdout.split("\n")[0]).toBe(`Read 1 file from ${path}.`);
  });

  test("named alone fails, with nothing to report about records", async () => {
    const path = oversized(join(directory({}), "huge.bin"));
    const { code, stdout } = await run(path);
    expect(code).toBe(1);
    expect(stdout).toContain("Digest         nothing read");
    expect(stdout).toContain("1 file too large to read.");
  });

  test("as the keys file is an environment error", async () => {
    const keys = oversized(join(directory({}), "keys.json"));
    const { code, stderr } = await run(directory(Object.fromEntries([named(task)])), "--keys", keys);
    expect(code).toBe(2);
    expect(stderr).toContain("byte limit");
  });

  test("shows in --json, and the top-level failed field says so", async () => {
    const path = directory({});
    oversized(join(path, "huge.bin"));
    const report = JSON.parse((await run(path, "--json")).stdout) as { failed: boolean; tooLarge: unknown };
    expect(report.failed).toBe(true);
    expect(report.tooLarge).toEqual([{ file: "huge.bin", bytes: MAX_FILE_BYTES + 1 }]);
  });
});

describe("--help", () => {
  test("prints usage to stdout and exits 0", async () => {
    const { code, stdout, stderr } = await run("--help");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("npx @jinn-network/verify <path>");
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

describe("names and fields from a stranger", () => {
  const FORGED = "\n\nNothing failed. Skipped and unknown are not passes.\n\u001b[2J\u001b]0;";

  test("a file name cannot add a line or an escape sequence", async () => {
    const { code, stdout } = await run(directory({ [`x${FORGED.replaceAll("/", "")}.json`]: canonicalJsonBytes({ protocol: TASK_EXECUTION_PROTOCOL_URI }) }));
    expect(code).toBe(1);
    expect(stdout).toContain("\\u{1b}");
    expect(stdout).not.toContain("\u001b");
    expect(stdout.split("\n").filter((text) => text.startsWith("Nothing failed"))).toEqual([]);
  });

  test("a record field cannot add a line or an escape sequence", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const { didKeyFromEd25519PublicKey } = await import("./index.js");
    const good = evaluation(privateKey, FORGED);
    const payloadBytes = JSON.parse(new TextDecoder().decode(good)) as { payload: string };
    const payload = new Uint8Array(Buffer.from(payloadBytes.payload, "base64"));
    const envelope = sealDsseEnvelope({
      payloadBytes: payload,
      signatures: [
        { keyid: didKeyFromEd25519PublicKey(publicKey), signature: new Uint8Array(64) },
        { keyid: FORGED, signature: new Uint8Array(64) },
      ],
    });
    const { code, stdout } = await run(directory(Object.fromEntries([named(envelope)])));
    expect(code).toBe(1);
    expect(stdout).not.toContain("\u001b");
    expect(stdout.split("\n").filter((text) => text.startsWith("Nothing failed"))).toEqual([]);
  });

  test("a digest in a record cannot reach the terminal through a set check", async () => {
    const forged = sealTask({
      protocol: TASK_EXECUTION_PROTOCOL_URI,
      profile: { digest: { sha256: FORGED } },
      instructions: "Judge the answer.",
      outputs: [],
    });
    const { code, stdout } = await run(directory(Object.fromEntries([named(forged)])));
    expect(code).toBe(1);
    expect(stdout).toContain("dangling");
    expect(stdout).not.toContain("\u001b");
    expect(stdout.split("\n").filter((text) => text.startsWith("Nothing failed"))).toEqual([]);
  });

  test("the path it was given is printed safely", async () => {
    const path = join(temporary, `target\u001b[2J-${directories += 1}`);
    mkdirSync(path);
    writeFileSync(join(path, "task.json"), task);
    expect((await run(path)).stdout).not.toContain("\u001b");
  });

  test("a file over the limit is named safely", async () => {
    const path = directory({});
    writeFileSync(join(path, "huge\u001b[2J.bin"), "x");
    truncateSync(join(path, "huge\u001b[2J.bin"), MAX_FILE_BYTES + 1);
    expect((await run(path)).stdout).not.toContain("\u001b");
  });

  test("a bidi override in a name is escaped, not obeyed", async () => {
    const { stdout } = await run(directory({ "evil\u202Etxt.json": canonicalJsonBytes({ protocol: TASK_EXECUTION_PROTOCOL_URI }) }));
    expect(stdout).toContain("evil\\u{202e}txt.json");
    expect(stdout).not.toContain("\u202E");
  });

  test("a long field is cut, so one record cannot fill the screen", async () => {
    const keyid = `evaluator-${"k".repeat(600)}`;
    const { privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519").publicKey;
    const keys = directory({ "keys.json": keysFile([{ keyId: keyid, publicKey: other }]) });
    const { code, stdout } = await run(directory({ "signed.json": evaluation(privateKey, keyid) }), "--keys", join(keys, "keys.json"));
    expect(code).toBe(1);
    const longest = stdout.split("\n").reduce((longer, text) => (text.length > longer.length ? text : longer), "");
    expect(longest.length).toBe("  ".length + 500 + "...".length);
    expect(longest.endsWith("...")).toBe(true);
  });

  test("a symlink out of the directory and a FIFO are not read", async () => {
    const path = directory(Object.fromEntries([named(task)]));
    symlinkSync("/etc/passwd", join(path, "out.json"));
    symlinkSync("/etc", join(path, "out"));
    execFileSync("mkfifo", [join(path, "pipe")]);
    const { code, stdout } = await run(path);
    expect(code).toBe(0);
    expect(stdout.split("\n")[0]).toBe(`Read 1 file from ${path}, and did not read 3 entries that are not files.`);
  });

  test("a FIFO as the target is refused, not waited on", async () => {
    const pipe = join(directory({}), "pipe");
    execFileSync("mkfifo", [pipe]);
    expect((await run(pipe)).code).toBe(2);
  });

  test("a FIFO or a device as the keys file is refused, not waited on", async () => {
    const path = directory(Object.fromEntries([named(task)]));
    const pipe = join(directory({}), "pipe");
    execFileSync("mkfifo", [pipe]);
    const device = join(directory({}), "zero.json");
    symlinkSync("/dev/zero", device);
    for (const keys of [pipe, device]) {
      // eslint-disable-next-line no-await-in-loop -- two small cases.
      const { code, stderr } = await run(path, "--keys", keys);
      expect(code).toBe(2);
      expect(stderr).toContain("not a regular file");
    }
  });

  test("a name only containing a digest, or spelling one in upper case, claims none", async () => {
    const hex = named(task)[0].slice(0, 64);
    for (const name of [`x${hex}.bin`, `${hex.toUpperCase()}.bin`]) {
      // eslint-disable-next-line no-await-in-loop -- two small cases.
      const { stdout } = await run(directory({ [name]: canonicalJsonBytes({ a: 1 }) }));
      expect(stdout).toContain("Digest         1 skipped (no digest claimed)");
    }
  });
});

describe("a signature is verified whenever its key is known", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "evaluator-key-1";
  const keys = () => join(directory({ "keys.json": keysFile([{ keyId, publicKey }]) }), "keys.json");

  test("a signed record whose payload no longer names a kind fails, not falls to unknown", async () => {
    const signed = JSON.parse(new TextDecoder().decode(evaluation(privateKey, keyId))) as { payload: string; payloadType: string; signatures: unknown };
    const statement = Buffer.from(signed.payload, "base64").toString("utf8");
    const renamed = statement.replace("attestations/result-evaluation/v1", "attestations/result-evaluatiom/v1");
    expect(renamed).not.toBe(statement);
    const tampered = new TextEncoder().encode(JSON.stringify({ ...signed, payload: Buffer.from(renamed).toString("base64") }));
    const { code, stdout } = await run(directory(Object.fromEntries([named(tampered)])), "--keys", keys());
    expect(code).toBe(1);
    expect(stdout).toContain("Kinds          0 known, 1 unknown naming a type");
    expect(stdout).toContain("Signatures     1 failed");
  });

  test("a signed record of unknown kind verifies when its key is known", async () => {
    const payloadBytes = canonicalJsonBytes({ protocol: "https://spec.jinn.network/binary-judgment/x/v1" });
    const payloadType = "application/vnd.jinn.binary-judgment.x.v1+json";
    const signature = new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), privateKey));
    const envelope = sealDsseEnvelope({ payloadType, payloadBytes, signatures: [{ keyid: keyId, signature }] });
    const { code, stdout } = await run(directory({ "receipt.json": envelope }), "--keys", keys());
    expect(code).toBe(0);
    expect(stdout).toContain("Signatures     1 verified against keys you supplied, none unverified");
  });

  test("one valid signature does not vouch for a junk one under the same keyid", async () => {
    const signed = JSON.parse(new TextDecoder().decode(evaluation(privateKey, keyId))) as { payload: string; signatures: { keyid: string; sig: string }[] };
    const envelope = sealDsseEnvelope({
      payloadBytes: new Uint8Array(Buffer.from(signed.payload, "base64")),
      signatures: [
        { keyid: keyId, signature: new Uint8Array(Buffer.from(signed.signatures[0]!.sig, "base64")) },
        { keyid: keyId, signature: new Uint8Array(64) },
      ],
    });
    const { code, stdout } = await run(directory(Object.fromEntries([named(envelope)])), "--keys", keys());
    expect(code).toBe(1);
    expect(stdout).toContain("Signatures     1 verified against keys you supplied, 1 failed");
  });

  test("a keys file holding a key that is not Ed25519 is refused", async () => {
    const { publicKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const path = join(directory({ "keys.json": keysFile([{ keyId, publicKey: rsa }]) }), "keys.json");
    const { code, stderr } = await run(directory(Object.fromEntries([named(task)])), "--keys", path);
    expect(code).toBe(2);
    expect(stderr).toContain("Ed25519");
  });
});

describe("set checks read as they ran", () => {
  const ATTEMPT = "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
  const SOURCE = "urn:jinn:backend:local";
  const ENGAGED = {
    attempt: ATTEMPT,
    task: taskDigest,
    submission: "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
    effectiveDeadline: "2026-07-29T00:00:00Z",
    source: SOURCE,
    dispatchContext: { digest: { sha256: "6".repeat(64) } },
  };
  const authority = createFixtureAuthority("command");

  function observation(type: string, id: string, sequence: number, data: unknown): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({
      specversion: "1.0", id, source: SOURCE, subject: ATTEMPT, time: "2026-07-28T00:00:00Z",
      datacontenttype: "application/json", sequence: String(sequence).padStart(16, "0"), taskdigest: taskDigest,
      type: `network.jinn.task-execution.${type}.v1`, data,
    }));
  }

  function anchorOver(digest: string) {
    const subjectSha256 = digest.slice("sha256:".length);
    return buildRfc3161AnchorEvidenceRecord({
      subjectKind: RECORD_KINDS.task,
      subjectSha256,
      proofBytes: authority.mintTimeStampToken({ subjectSha256, genTime: "20260501120000Z" }).tokenDer,
    }).bytes;
  }

  test("a lifecycle that folded says so, and counts Deliveries with no log", async () => {
    const other = delivery({ attempt: "urn:uuid:eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee" });
    const { code, stdout } = await run(directory(Object.fromEntries([task, other, observation("attempt-engaged", "evt-1", 1, ENGAGED)].map(named))));
    expect(code).toBe(0);
    expect(stdout).toContain("Lifecycle      passed: 1 attempt folded, 1 Delivery with no log");
  });

  test("a log with no engagement is skipped, and says why", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([task, observation("attempt-terminal", "evt-1", 1, { state: "delivered" })].map(named))));
    expect(code).toBe(0);
    expect(stdout).toContain("Lifecycle      skipped: no attempt-engaged here, so no source is authoritative");
  });

  test("a lifecycle that failed never reads as passed", async () => {
    const closing = delivery();
    const { code, stdout } = await run(directory(Object.fromEntries([
      task,
      closing,
      observation("attempt-engaged", "evt-1", 1, ENGAGED),
      observation("delivery-recorded", "evt-2", 2, { digest: taskDigest }),
    ].map(named))));
    expect(code).toBe(1);
    expect(stdout).toContain("Lifecycle      failed: 1 attempt folded");
    expect(stdout).toContain("lifecycle failed");
  });

  test("an anchor with no trust material says its time was not evaluated", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([task, anchorOver(taskDigest)].map(named))));
    expect(code).toBe(0);
    expect(stdout).toContain("Anchors        passed: 1 proof consistent, time not evaluated");
  });

  test("an anchor that fails never reads as passed", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([task, anchorOver(`sha256:${"9".repeat(64)}`)].map(named))));
    expect(code).toBe(1);
    expect(stdout).toContain("Anchors        failed: 1 invalid");
  });

  test("a citation the family lets a reader lack is counted, not hidden", async () => {
    const { code, stdout } = await run(directory(Object.fromEntries([
      named(task),
      named(delivery({ outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "3".repeat(64) } }] })),
    ])));
    expect(code).toBe(0);
    expect(stdout).toMatch(/References {5}passed: .*1 unavailable/u);
  });
});
