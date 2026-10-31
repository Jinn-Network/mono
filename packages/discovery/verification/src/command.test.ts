// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DSSE_PAYLOAD_TYPE, canonicalJsonBytes, dssePreAuthEncoding, sealDsseEnvelope } from "@jinn-network/trust-core";
import { TASK_EXECUTION_PROTOCOL_URI, sealDelivery, sealTask } from "@jinn-network/task-execution-protocol";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildRfc3161AnchorEvidenceRecord, createFixtureAuthority } from "@jinn-network/trust-testing";

import { MAX_FILE_BYTES, runCommand } from "./command.js";
import { recordDigest } from "./index.js";
import { MAX_LIST_BYTES } from "./root-target.js";

const temporary = mkdtempSync(join(tmpdir(), "jinn-verify-command-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

let directories = 0;

function directory(files: Readonly<Record<string, Uint8Array | string>>): string {
  directories += 1;
  const path = join(temporary, `set-${directories}`);
  mkdirSync(path);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true });
    writeFileSync(join(path, name), content);
  }
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
    ["--root with no digest", ["a", "--root"]],
    ["--root with bare hex", ["a", "--root", "a".repeat(64)]],
    ["--root in uppercase", ["a", "--root", `sha256:${"A".repeat(64)}`]],
    ["--root too short", ["a", "--root", `sha256:${"a".repeat(63)}`]],
    ["--root with another algorithm", ["a", "--root", `sha512:${"a".repeat(64)}`]],
    ["--root with more after it", ["a", "--root", `sha256:${"a".repeat(64)}x`]],
  ])("%s prints usage and reads nothing", async (_name, argv) => {
    const { code, stdout, stderr } = await run(...argv);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("npx @jinn-network/verify <path>");
  });

  test("a malformed root says what a root looks like", async () => {
    expect((await run("a", "--root", "abc")).stderr).toContain("--root takes sha256: and 64 lowercase hex digits");
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

  test("a supersession that could not be compared is said, and is not listed as a failure", async () => {
    const engagement = observation("attempt-engaged", "evt-1", 1, ENGAGED);
    const unheld = delivery({ supersedes: `sha256:${"7".repeat(64)}`, createdAt: "2026-07-28T00:06:00Z" });
    const { stdout } = await run(directory(Object.fromEntries([task, unheld, engagement].map(named))));
    expect(stdout).toContain("Lifecycle      passed: 1 attempt folded, 1 supersession not compared");
    expect(stdout).toContain("References     failed: 1 dangling");

    const forged = delivery({ supersedes: taskDigest, createdAt: "2026-07-28T00:07:00Z" });
    const failing = await run(directory(Object.fromEntries([task, unheld, forged, engagement].map(named))));
    expect(failing.code).toBe(1);
    expect(failing.stdout).toContain("not a valid Delivery");
    expect(failing.stdout).not.toContain("was not compared");
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

describe("--root", () => {
  type Tree = Readonly<Record<string, Uint8Array | string>>;

  function sha256(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  function listOf(files: Tree, members: Readonly<Record<string, unknown>> = {}): string {
    const entries = Object.keys(files).sort().map((path) => ({
      path,
      bytes: Buffer.byteLength(files[path]!),
      sha256: sha256(files[path]!),
    }));
    return JSON.stringify({ ...members, files: entries });
  }

  /** A directory holding `files` and a `bundle.json` listing them, with the digest that names it. */
  function published(files: Tree, members: Readonly<Record<string, unknown>> = {}) {
    const list = listOf(files, members);
    return { path: directory({ ...files, "bundle.json": list }), root: `sha256:${sha256(list)}` };
  }

  const [taskFile, taskBytes] = named(task);
  const [deliveryFile, deliveryBytes] = named(delivery());
  const tree: Tree = {
    "notes/readme.txt": "hello",
    [`records/${taskFile}`]: taskBytes,
    [`records/${deliveryFile}`]: deliveryBytes,
  };

  describe("when everything matches", () => {
    test("prints the report, with the root and completeness lines", async () => {
      const { path, root } = published(tree);
      const { code, stdout, stderr } = await run(path, "--root", root);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toBe([
        `Read 3 files from ${path}.`,
        "",
        `Root           matched: bundle.json is ${root}`,
        "Kinds          2 known, 0 unknown naming a type, 1 naming no type",
        "Digest         3 passed, compared with the list",
        "Encoding       2 passed, 1 skipped (not records)",
        "Schema         2 passed, 1 skipped (kind unknown)",
        "Signatures     none in these files",
        "Trust binding  skipped: no key was tied to an identity, and a root pins what was published, not who published it",
        "References     passed for known kinds: 2 resolved, 1 by a published document",
        "Lifecycle      skipped: no observations here",
        "Anchors        not checked: no anchor records here",
        "Completeness   passed: 3 listed files present and unchanged, no others",
        "",
        "Nothing failed. Skipped and unknown are not passes.",
        "",
      ].join("\n"));
    });

    test("finds the list among other files at the top, by its bytes and not its name", async () => {
      const files: Tree = { ...tree, "a-first.txt": "before the list", "z-last.txt": "after it" };
      const list = listOf(files);
      const path = directory({ ...files, "whatever.manifest": list });
      const { code, stdout } = await run(path, "--root", `sha256:${sha256(list)}`);
      expect(code).toBe(0);
      expect(stdout).toContain("Root           matched: whatever.manifest is sha256:");
    });

    test("reads a list over the size limit for a record", async () => {
      const { path, root } = published(tree, { padding: "x".repeat(MAX_FILE_BYTES) });
      expect((await run(path, "--root", root)).code).toBe(0);
    });

    test("ignores an empty directory, which holds no bytes to commit to", async () => {
      const { path, root } = published(tree);
      mkdirSync(join(path, "empty"));
      expect((await run(path, "--root", root)).code).toBe(0);
    });

    test("does not change what a run without --root prints", async () => {
      const { path } = published(Object.fromEntries([named(task)]));
      const { stdout } = await run(path);
      expect(stdout).not.toContain("Root ");
      expect(stdout).toContain("Completeness   not checked: nothing here says which files should exist");
      expect(stdout).toContain("compared with each file's own name");
      expect(stdout).toContain("Trust binding  skipped: no key was tied to an identity\n");
    });
  });

  describe("when no file at the top has the digest", () => {
    test("fails, and says nothing else was checked", async () => {
      const { path } = published(tree);
      const root = `sha256:${"0".repeat(64)}`;
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toBe([
        `Looked at the top of ${path} for ${root}.`,
        "",
        "Root           failed: no file there has this digest",
        "Completeness   not checked: no list to compare with",
        "",
        "Root failed, so nothing else was checked.",
        "",
      ].join("\n"));
    });

    test("a list in a subdirectory is not the list", async () => {
      const list = listOf({ "a.txt": "a" });
      const path = directory({ "a.txt": "a", "sub/bundle.json": list });
      expect((await run(path, "--root", `sha256:${sha256(list)}`)).code).toBe(1);
    });

    test("a link to the list is not followed to find it", async () => {
      const list = listOf({ "a.txt": "a" });
      const elsewhere = directory({ "bundle.json": list });
      const path = directory({ "a.txt": "a" });
      symlinkSync(join(elsewhere, "bundle.json"), join(path, "bundle.json"));
      const { code, stdout } = await run(path, "--root", `sha256:${sha256(list)}`);
      expect(code).toBe(1);
      expect(stdout).toContain("no file there has this digest");
    });

    test("shows in --json", async () => {
      const { path } = published(tree);
      const root = `sha256:${"0".repeat(64)}`;
      const report = JSON.parse((await run(path, "--root", root, "--json")).stdout) as Record<string, unknown>;
      expect(report).toMatchObject({ failed: true, root: { digest: root, checked: false, listed: 0 } });
      expect(report.records).toEqual([]);
      expect(report.checks).toEqual([]);
    });
  });

  describe("a file that matches and is no list", () => {
    test.each<[string, string]>([
      ["not JSON", "not json"],
      ["JSON with no files", "{}"],
      ["an empty list", '{"files":[]}'],
    ])("%s is exit 2, because nothing could be compared", async (_name, bytes) => {
      const path = directory({ "a.txt": bytes });
      const { code, stdout, stderr } = await run(path, "--root", `sha256:${sha256(bytes)}`);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("a.txt");
    });

    test("over the limit for a list is exit 2", async () => {
      const path = directory({ "list.json": "x" });
      truncateSync(join(path, "list.json"), MAX_LIST_BYTES + 1);
      const zeros = Buffer.alloc(MAX_LIST_BYTES + 1);
      zeros[0] = "x".charCodeAt(0);
      const { code, stderr } = await run(path, "--root", `sha256:${sha256(zeros)}`);
      expect(code).toBe(2);
      expect(stderr).toContain(`over the ${MAX_LIST_BYTES} byte limit for a list`);
    });
  });

  test("a path that is not a directory is exit 2", async () => {
    const path = directory({ "a.txt": "a" });
    expect((await run(join(path, "a.txt"), "--root", `sha256:${"0".repeat(64)}`)).code).toBe(2);
  });

  describe("a list that breaks the format", () => {
    function withEntries(files: readonly unknown[]) {
      const list = JSON.stringify({ files });
      return { path: directory({ "a.txt": "a", "bundle.json": list }), root: `sha256:${sha256(list)}` };
    }
    const good = { path: "a.txt", bytes: 1, sha256: sha256("a") };

    test.each<[string, Record<string, unknown>, string]>([
      ["absolute", { path: "/a.txt" }, "is not relative and normalized"],
      ["parent", { path: "../a.txt" }, "is not relative and normalized"],
      ["dot", { path: "./a.txt" }, "is not relative and normalized"],
      ["the list itself", { path: "bundle.json" }, "names the list itself"],
    ])("%s fails, opens no file, and names the entry", async (_name, overrides, expected) => {
      const { path, root } = withEntries([{ ...good, ...overrides }]);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain(`Root           matched: bundle.json is ${root}`);
      expect(stdout).toContain("Completeness   failed: 1 breaking the list format");
      expect(stdout).toContain(expected);
      expect(stdout).toContain("The list broke its format, so nothing else was checked.");
      expect(stdout).not.toContain("Digest ");
      expect(stdout).not.toContain("Nothing failed");
    });

    test("does not follow a parent path out of the directory", async () => {
      const outside = directory({ "outside.txt": "outside" });
      const list = JSON.stringify({ files: [{ path: "../outside.txt", bytes: 7, sha256: sha256("outside") }] });
      const path = join(outside, "inner");
      mkdirSync(path);
      writeFileSync(join(path, "bundle.json"), list);
      const { code, stdout } = await run(path, "--root", `sha256:${sha256(list)}`);
      expect(code).toBe(1);
      expect(stdout).not.toContain("Nothing failed");
    });

    test("a repeated path fails", async () => {
      const { path, root } = withEntries([good, good]);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("a.txt is listed twice");
    });

    test("paths out of order fail", async () => {
      const list = JSON.stringify({ files: [{ path: "b.txt", bytes: 1, sha256: sha256("b") }, good] });
      const path = directory({ "a.txt": "a", "b.txt": "b", "bundle.json": list });
      const { code, stdout } = await run(path, "--root", `sha256:${sha256(list)}`);
      expect(code).toBe(1);
      expect(stdout).toContain("a.txt is out of order");
    });

    test("cannot put a control character on the terminal", async () => {
      const { path, root } = withEntries([{ ...good, path: "/\u001b[2J‮" }]);
      const { stdout } = await run(path, "--root", root);
      expect(stdout).not.toContain("\u001b");
      expect(stdout).not.toContain("‮");
    });
  });

  describe("a listed file that is not what the list says", () => {
    test("one byte changed, same length, fails on both checks and names the file", async () => {
      const { path, root } = published({ ...tree, "notes/readme.txt": "hello" });
      writeFileSync(join(path, "notes/readme.txt"), "hellO");
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Root           matched");
      expect(stdout).toContain("Digest         2 passed, compared with the list, 1 failed");
      expect(stdout).toContain("Completeness   failed: 1 changed");
      expect(stdout).toContain("notes/readme.txt: changed: does not hash to the digest in the list");
      expect(stdout).toContain("notes/readme.txt: digest:");
      expect(stdout).toContain("Completeness failed, 1 record failed. Skipped and unknown are not passes.");
    });

    test("a different length fails", async () => {
      const { path, root } = published(tree);
      writeFileSync(join(path, "notes/readme.txt"), "hello!");
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("notes/readme.txt: changed: 6 bytes, and the list says 5");
    });

    test("the right digest with the wrong length in the list fails", async () => {
      const list = JSON.stringify({ files: [{ path: "a.txt", bytes: 2, sha256: sha256("a") }] });
      const path = directory({ "a.txt": "a", "bundle.json": list });
      const { code, stdout } = await run(path, "--root", `sha256:${sha256(list)}`);
      expect(code).toBe(1);
      expect(stdout).toContain("a.txt: changed: 1 bytes, and the list says 2");
    });

    test("a missing file fails, and what cited it dangles", async () => {
      const { path, root } = published(tree);
      unlinkSync(join(path, `records/${taskFile}`));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout.split("\n")[0]).toBe(`Read 2 files from ${path}.`);
      expect(stdout).toContain("Completeness   failed: 1 missing");
      expect(stdout).toContain(`records/${taskFile}: missing: listed, and not here`);
      expect(stdout).toContain("References     failed: 1 dangling");
      expect(stdout).toContain("Completeness failed, references failed.");
    });

    test.skipIf(process.getuid?.() === 0)("a file in a subdirectory that cannot be opened fails and is named", async () => {
      const { path, root } = published(tree);
      chmodSync(join(path, "notes/readme.txt"), 0o000);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Completeness   failed: 1 unreadable");
      expect(stdout).toContain("notes/readme.txt: unreadable:");
    });

    test.skipIf(process.getuid?.() === 0)("a file at the top that cannot be opened might be the list, so nothing can be said", async () => {
      const { path, root } = published({ "a.txt": "a" });
      chmodSync(join(path, "a.txt"), 0o000);
      const { code, stderr } = await run(path, "--root", root);
      expect(code).toBe(2);
      expect(stderr).toContain("cannot check");
    });

    test("several kinds of problem are all counted", async () => {
      const { path, root } = published(tree);
      unlinkSync(join(path, `records/${taskFile}`));
      writeFileSync(join(path, "notes/readme.txt"), "hellO");
      writeFileSync(join(path, "extra-1.txt"), "x");
      writeFileSync(join(path, "extra-2.txt"), "y");
      const { stdout } = await run(path, "--root", root);
      expect(stdout).toContain("Completeness   failed: 1 changed, 1 missing, 2 not listed");
    });

    test("shows in --json", async () => {
      const { path, root } = published(tree);
      unlinkSync(join(path, `records/${taskFile}`));
      const report = JSON.parse((await run(path, "--root", root, "--json")).stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        formatVersion: 1,
        failed: true,
        root: {
          digest: root,
          list: "bundle.json",
          listed: 3,
          checked: true,
          problems: [{ code: "missing", file: `records/${taskFile}`, detail: "listed, and not here" }],
          notParsed: [],
        },
      });
    });
  });

  describe("a file the list does not name", () => {
    test.each([["at the top", "extra.txt"], ["in a subdirectory", "deep/er/extra.txt"]])("%s fails", async (_name, file) => {
      const { path, root } = published(tree);
      mkdirSync(dirname(join(path, file)), { recursive: true });
      writeFileSync(join(path, file), "extra");
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Completeness   failed: 1 not listed");
      expect(stdout).toContain(`${file}: not-listed: not in the list`);
    });

    test("is not read as a record, so a forged one adds nothing to the counts", async () => {
      const { path, root } = published(tree);
      const forged = sealTask({
        protocol: TASK_EXECUTION_PROTOCOL_URI,
        profile: { uri: "https://spec.jinn.network/task-profiles/binary-judgment/2.0", digest: { sha256: BINARY_JUDGMENT_PROFILE } },
        instructions: "A forged task.",
        outputs: [],
      });
      const [name, bytes] = named(forged);
      writeFileSync(join(path, `records/${name}`), bytes);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Kinds          2 known, 0 unknown naming a type, 1 naming no type");
    });

    test("a second copy of the list fails, so the list is the only exception", async () => {
      const { path, root } = published(tree);
      writeFileSync(join(path, "copy.json"), listOf(tree));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Completeness   failed: 1 not listed");
    });

    test("with a hostile name is escaped", async () => {
      const { path, root } = published(tree);
      writeFileSync(join(path, "evil‮\u001b[2J.txt"), "x");
      const { stdout } = await run(path, "--root", root);
      expect(stdout).toContain("evil\\u{202e}\\u{1b}[2J.txt: not-listed");
    });
  });

  describe("what is not a plain file", () => {
    test("a link to a file with the right bytes fails, even when it is listed", async () => {
      const { path, root } = published({ "a.txt": "a" });
      const outside = directory({ "a.txt": "a" });
      unlinkSync(join(path, "a.txt"));
      symlinkSync(join(outside, "a.txt"), join(path, "a.txt"));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Completeness   failed: 1 not regular");
      expect(stdout).toContain("a.txt: not-regular: a symbolic link, not followed");
    });

    test("a link to a directory is not walked into", async () => {
      const outside = directory({ "b.txt": "b" });
      const { path, root } = published({ "a.txt": "a", "linked/b.txt": "b" });
      rmSync(join(path, "linked"), { recursive: true });
      symlinkSync(outside, join(path, "linked"));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("linked: not-regular: a symbolic link, not followed");
      expect(stdout).toContain("linked/b.txt: missing: listed, and not here");
    });

    test("a link the list does not name fails too", async () => {
      const { path, root } = published(tree);
      symlinkSync("/etc/passwd", join(path, "passwd"));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("passwd: not-regular: a symbolic link, not followed");
    });

    test("a pipe fails and is not opened, listed or not", async () => {
      const { path, root } = published({ "a.txt": "a" });
      unlinkSync(join(path, "a.txt"));
      execFileSync("mkfifo", [join(path, "a.txt")]);
      execFileSync("mkfifo", [join(path, "other")]);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("a.txt: not-regular: a special file, not opened");
      expect(stdout).toContain("other: not-regular: a special file, not opened");
    });

    test("a hard link fails", async () => {
      const { path, root } = published({ "a.txt": "a" });
      const outside = directory({});
      linkSync(join(path, "a.txt"), join(outside, "a.txt"));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("Completeness   failed: 1 hard-linked");
      expect(stdout).toContain("a.txt: hard-link: more than one name holds these bytes");
    });

    test("a hard link to the list fails", async () => {
      const { path, root } = published({ "a.txt": "a" });
      const outside = directory({});
      linkSync(join(path, "bundle.json"), join(outside, "bundle.json"));
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("bundle.json: hard-link:");
    });
  });

  describe("a listed file over the size limit for a record", () => {
    function big(): { bytes: Uint8Array; file: string } {
      return { file: "big.dat", bytes: Buffer.alloc(MAX_FILE_BYTES + 1, "x") };
    }

    test("is compared and not parsed, and does not fail the run", async () => {
      const { file, bytes } = big();
      const { path, root } = published({ ...tree, [file]: bytes });
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(0);
      expect(stdout.split("\n")[0]).toBe(`Read 4 files from ${path}, and did not parse 1 file over the size limit.`);
      expect(stdout).toContain("Digest         3 passed, compared with the list");
      expect(stdout).toContain("Completeness   passed: 4 listed files present and unchanged, no others");
    });

    test("that has changed fails", async () => {
      const { file, bytes } = big();
      const { path, root } = published({ ...tree, [file]: bytes });
      const changed = Buffer.from(bytes);
      changed[changed.length - 1] = "y".charCodeAt(0);
      writeFileSync(join(path, file), changed);
      const { code, stdout } = await run(path, "--root", root);
      expect(code).toBe(1);
      expect(stdout).toContain("big.dat: changed: does not hash to the digest in the list");
    });

    test("has no upper limit, because it is hashed in pieces", async () => {
      const size = MAX_LIST_BYTES + 1;
      const list = JSON.stringify({ files: [{ path: "huge.dat", bytes: size, sha256: sha256(Buffer.alloc(size)) }] });
      const path = directory({ "bundle.json": list, "huge.dat": "" });
      truncateSync(join(path, "huge.dat"), size);
      expect((await run(path, "--root", `sha256:${sha256(list)}`)).code).toBe(0);
    });

    test("is named in --json", async () => {
      const { file, bytes } = big();
      const { path, root } = published({ ...tree, [file]: bytes });
      const report = JSON.parse((await run(path, "--root", root, "--json")).stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        failed: false,
        tooLarge: [],
        root: { notParsed: [{ file, bytes: MAX_FILE_BYTES + 1 }] },
      });
    });
  });

  describe("keys", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const keys = keysFile([{ keyId: "evaluator-key-1", publicKey }]);

    test("in the list are covered by the root, and still tied to no identity", async () => {
      const { path, root } = published({ ...tree, "trust/keys.json": keys });
      const { code, stdout } = await run(path, "--root", root, "--keys", join(path, "trust/keys.json"));
      expect(code).toBe(0);
      expect(stdout).toContain("Keys           covered by the root: trust/keys.json is in the list");
      expect(stdout).toContain("Trust binding  skipped: no key was tied to an identity, and a root pins what was published, not who published it");
    });

    test("with the same bytes somewhere else are covered too, because the root commits to bytes", async () => {
      const { path, root } = published({ ...tree, "trust/keys.json": keys });
      const elsewhere = join(directory({ "copy.json": keys }), "copy.json");
      const { stdout } = await run(path, "--root", root, "--keys", elsewhere);
      expect(stdout).toContain("Keys           covered by the root: trust/keys.json is in the list");
    });

    test("not in the list are not covered, and that does not fail the run", async () => {
      const { path, root } = published(tree);
      const elsewhere = join(directory({ "keys.json": keys }), "keys.json");
      const { code, stdout } = await run(path, "--root", root, "--keys", elsewhere);
      expect(code).toBe(0);
      expect(stdout).toContain("Keys           not covered by the root: their bytes are not in the list");
      expect(stdout).toContain("Trust binding  skipped");
    });

    test("swapped for other keys are not covered, and fail as a changed file", async () => {
      const { path, root } = published({ ...tree, "trust/keys.json": keys });
      const other = keysFile([{ keyId: "evaluator-key-1", publicKey: generateKeyPairSync("ed25519").publicKey }]);
      writeFileSync(join(path, "trust/keys.json"), other);
      const { code, stdout } = await run(path, "--root", root, "--keys", join(path, "trust/keys.json"));
      expect(code).toBe(1);
      expect(stdout).toContain("Keys           not covered by the root");
      expect(stdout).toContain("trust/keys.json: changed");
    });

    test("say nothing when no keys were given", async () => {
      const { path, root } = published(tree);
      expect((await run(path, "--root", root)).stdout).not.toContain("Keys ");
    });

    test("show in --json", async () => {
      const { path, root } = published({ ...tree, "trust/keys.json": keys });
      const covered = JSON.parse((await run(path, "--root", root, "--keys", join(path, "trust/keys.json"), "--json")).stdout) as Record<string, unknown>;
      expect(covered).toMatchObject({ root: { keys: { covered: true, listedAs: "trust/keys.json" } } });
      const elsewhere = join(directory({ "keys.json": `${keys}\n` }), "keys.json");
      const bare = JSON.parse((await run(path, "--root", root, "--keys", elsewhere, "--json")).stdout) as Record<string, unknown>;
      expect(bare).toMatchObject({ root: { keys: { covered: false } } });
    });

    test("a verified signature reads the same as without a root", async () => {
      const { publicKey: signerKey, privateKey } = generateKeyPairSync("ed25519");
      const signed = evaluation(privateKey, "evaluator-key-1");
      const signerKeys = keysFile([{ keyId: "evaluator-key-1", publicKey: signerKey }]);
      const [name, bytes] = named(signed);
      const { path, root } = published({ ...tree, [`records/${name}`]: bytes, "trust/keys.json": signerKeys });
      const { code, stdout } = await run(path, "--root", root, "--keys", join(path, "trust/keys.json"));
      expect(code).toBe(0);
      expect(stdout).toContain("Signatures     1 verified against keys you supplied, none unverified");
    });
  });

  test("escapes every name from the input, in the report and in the root's --json", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const keys = keysFile([{ keyId: "evaluator-key-1", publicKey }]);
    const files: Tree = {
      "big\u202e.dat": Buffer.alloc(MAX_FILE_BYTES + 1, "x"),
      "trust/keys\u202e.json": keys,
    };
    const list = listOf(files);
    const path = directory({ ...files, "list\u202e.json": list, "extra\u202e.txt": "x" });
    const argv = [path, "--root", `sha256:${sha256(list)}`, "--keys", join(path, "trust/keys\u202e.json")];
    const { stdout } = await run(...argv);
    expect(stdout).toContain("Root           matched: list\\u{202e}.json is sha256:");
    expect(stdout).toContain("covered by the root: trust/keys\\u{202e}.json is in the list");
    expect(stdout).toContain("extra\\u{202e}.txt: not-listed");
    const report = JSON.parse((await run(...argv, "--json")).stdout) as { root: unknown };
    expect(JSON.stringify(report.root)).not.toContain("\u202e");
  });

  test("lists at most five failures, and points to --json for the rest", async () => {
    const { path, root } = published({ "a.txt": "a" });
    for (let index = 0; index < 7; index += 1) writeFileSync(join(path, `extra-${index}.txt`), "x");
    const { stdout } = await run(path, "--root", root);
    expect(stdout.match(/extra-\d\.txt: not-listed/gu)).toEqual([0, 1, 2, 3, 4].map((index) => `extra-${index}.txt: not-listed`));
    expect(stdout).toContain("and 2 more; --json has them all");
  });

  test("--help says what a root is", async () => {
    const { code, stdout } = await run("--help");
    expect(code).toBe(0);
    expect(stdout).toContain("--root sha256:<hex>");
    expect(stdout).toContain("somewhere you trust");
  });
});
