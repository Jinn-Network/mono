// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DSSE_PAYLOAD_TYPE,
  canonicalJsonBytes,
  dssePreAuthEncoding,
  sealDsseEnvelope,
  sealSignedPayload,
  sealSignedRecord,
} from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseProducedSignature,
  Eip1271Witness,
  KeyBinding,
  ResolvedBinding,
} from "@jinn-network/trust-core";
import { createBindingResolver, createWitnessVerifier } from "@jinn-network/trust-resolve";
import type { SealedKeyBindingRecord } from "@jinn-network/trust-resolve";
import {
  DELIVERY_MEDIA_TYPE,
  TASK_EXECUTION_PROTOCOL_URI,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";

import { checkRecord, defaultRecordKinds, didKeyFromEd25519PublicKey, recordDigest } from "./index.js";
import type { CheckResult, RecordCheckId, RecordKind, RecordReport } from "./index.js";

const encoder = new TextEncoder();

const TASK = {
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  profile: { uri: "https://spec.jinn.network/task-profiles/repository-work/1.0", digest: { sha256: "1".repeat(64) } },
  instructions: "Normalize the slug helper.",
  outputs: [{ name: "patch", mediaType: "text/x-diff", required: true }],
};
const SUBMISSION = {
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  submission: "urn:uuid:bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb",
  task: { digest: { sha256: "2".repeat(64) } },
  requester: "urn:uuid:cccccccc-cccc-5ccc-8ccc-cccccccccccc",
  idempotencyKey: "key-1",
  nonce: "nonce-1",
  deadline: "2026-07-29T00:00:00Z",
};
const DELIVERY = {
  protocol: TASK_EXECUTION_PROTOCOL_URI,
  attempt: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
  task: `sha256:${"2".repeat(64)}`,
  outputs: [{ name: "patch", mediaType: "text/x-diff", digest: { sha256: "3".repeat(64) } }],
  outcome: "fulfilled",
  createdAt: "2026-07-28T00:05:00Z",
};
const AGENT = "urn:uuid:11111111-1111-4111-8111-111111111111";

function check(report: RecordReport, id: RecordCheckId): CheckResult<RecordCheckId> {
  return report.checks.find((candidate) => candidate.id === id)!;
}

function statuses(report: RecordReport): Record<string, string> {
  return Object.fromEntries(report.checks.map(({ id, status }) => [id, status]));
}

function codes(result: CheckResult): readonly string[] {
  return result.findings.map(({ code }) => code);
}

function ed25519(): { readonly publicKey: KeyObject; readonly privateKey: KeyObject; readonly keyid: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey, keyid: didKeyFromEd25519PublicKey(publicKey) };
}

function evaluationStatement(evaluator = AGENT) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "task", digest: { sha256: "4".repeat(64) } },
      { name: "result", digest: { sha256: "5".repeat(64) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-07-28T00:10:00Z",
      evaluator: { id: evaluator },
      verdict: "pass",
      taskSubject: "task",
      resultSubjects: ["result"],
    },
  };
}

/** A DSSE envelope over `statement`, signed by `key`, spelled however `spell` says. */
function signedEvaluation(
  key: ReturnType<typeof ed25519>,
  spell: (envelope: unknown) => string = (envelope) => JSON.stringify(envelope, null, 2),
  statement: unknown = evaluationStatement(),
): Uint8Array {
  const payloadBytes = encoder.encode(JSON.stringify(statement, null, 2));
  const signature = sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), key.privateKey);
  return encoder.encode(spell({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payloadBytes).toString("base64"),
    signatures: [{ keyid: key.keyid, sig: signature.toString("base64") }],
  }));
}

function signedRecord(key: ReturnType<typeof ed25519>, record: unknown, payloadType: string) {
  return sealSignedRecord({
    record,
    payloadType,
    signer: async ({ preAuthEncoding }) => [
      { keyid: key.keyid, signature: new Uint8Array(sign(null, preAuthEncoding, key.privateKey)) },
    ] as [DsseProducedSignature],
  });
}

describe("a sealed Task, Submission and Delivery", () => {
  test.each([
    ["Task", () => sealTask(TASK), RECORD_KINDS.task],
    ["Submission", () => sealSubmission(SUBMISSION), RECORD_KINDS.submission],
    ["Delivery", () => sealDelivery(DELIVERY), RECORD_KINDS.delivery],
  ])("a %s reports the kind it names and every check that ran", async (_name, seal, kind) => {
    const bytes = seal();
    const report = await checkRecord(bytes);
    expect(report).toMatchObject({
      digest: recordDigest(bytes),
      kind,
      family: "task-execution",
      names: TASK_EXECUTION_PROTOCOL_URI,
      outcome: "checked",
    });
    expect(statuses(report)).toEqual({
      digest: "skipped",
      encoding: "passed",
      schema: "passed",
      signature: "skipped",
      "trust-binding": "skipped",
    });
    expect(check(report, "signature").findings).toEqual([expect.objectContaining({ code: "unsigned-record" })]);
  });

  test("the five checks are always reported, in order", async () => {
    const report = await checkRecord(sealTask(TASK));
    expect(report.checks.map(({ id }) => id)).toEqual(["digest", "encoding", "schema", "signature", "trust-binding"]);
  });
});

describe("digest", () => {
  test("with no claimed digest nothing is compared, so the check says skipped and reports the digest", async () => {
    const bytes = sealTask(TASK);
    const report = await checkRecord(bytes);
    expect(check(report, "digest").status).toBe("skipped");
    expect(check(report, "digest").findings[0]).toMatchObject({ code: "no-claimed-digest" });
    expect(report.digest).toBe(recordDigest(bytes));
  });

  test("a matching claim passes", async () => {
    const bytes = sealTask(TASK);
    const report = await checkRecord(bytes, { digest: recordDigest(bytes) });
    expect(check(report, "digest")).toEqual({ id: "digest", status: "passed", findings: [] });
  });

  test("a claim the bytes do not hash to fails and names both digests", async () => {
    const bytes = sealTask(TASK);
    const claimed = `sha256:${"0".repeat(64)}`;
    const report = await checkRecord(bytes, { digest: claimed });
    expect(check(report, "digest").status).toBe("failed");
    expect(check(report, "digest").findings).toEqual([
      expect.objectContaining({
        code: "content-corruption",
        detail: expect.stringMatching(new RegExp(`${claimed}.*${recordDigest(bytes)}`, "u")),
      }),
    ]);
    expect(report.outcome).toBe("failed");
  });
});

describe("encoding", () => {
  test("a respelling of a sealed record fails, whatever its parse says", async () => {
    const report = await checkRecord(encoder.encode(JSON.stringify(TASK, null, 2)));
    expect(check(report, "encoding").status).toBe("failed");
    expect(codes(check(report, "encoding"))).toEqual(["not-canonical"]);
    expect(check(report, "schema").status).toBe("passed");
    expect(report.outcome).toBe("failed");
  });

  test("the comparison is over the raw parse, so a key the schema ignores still counts", async () => {
    const sealed = new TextDecoder().decode(sealTask(TASK));
    const withDuplicate = sealed.replace(`{"instructions"`, `{"instructions":"first","instructions"`);
    const report = await checkRecord(encoder.encode(withDuplicate));
    expect(codes(check(report, "encoding"))).toEqual(["not-canonical"]);
  });

  test("a number outside the I-JSON integer subset is reported, not thrown", async () => {
    const text = new TextDecoder().decode(sealTask(TASK)).replace(`{"instructions"`, `{"com.example.ratio":0.5,"instructions"`);
    const report = await checkRecord(encoder.encode(text));
    expect(check(report, "encoding").status).toBe("failed");
    expect(codes(check(report, "encoding"))).toEqual(["not-i-json"]);
  });
});

describe("schema", () => {
  test("a Task with no outputs fails its schema with the path", async () => {
    const { outputs: _outputs, ...withoutOutputs } = TASK;
    const report = await checkRecord(canonicalJsonBytes(withoutOutputs));
    expect(report.kind).toBe(RECORD_KINDS.task);
    expect(check(report, "schema").status).toBe("failed");
    expect(check(report, "schema").findings[0]).toMatchObject({ code: "invalid-document", path: "outputs" });
    expect(report.outcome).toBe("failed");
  });

  test("a bare key-binding document is refused: a signed record is an envelope", async () => {
    const report = await checkRecord(canonicalJsonBytes({ protocol: "https://spec.jinn.network/trust/key-binding/v1" }));
    expect(report.kind).toBe(RECORD_KINDS.keyBinding);
    expect(check(report, "schema").status).toBe("failed");
    expect(codes(check(report, "schema"))).toEqual(["ENVELOPE_INVALID"]);
  });
});

describe("a signed record's envelope states its media type (§21.2)", () => {
  const signatures = [{ signature: Uint8Array.of(1), keyid: "did:key:z" }] as const;
  const PROFILE = {
    protocol: "https://spec.jinn.network/profiles/task-profile/v1",
    profile: "https://example.test/profiles/safe/1.0",
    description: "safe",
    payloadSchema: { type: "object" },
    inputConventions: { slots: [] },
    outputConventions: { slots: [] },
    evaluationFamilies: [],
    requirementKeys: [],
  };

  test.each([
    ["a Task", sealTask(TASK), RECORD_KINDS.task],
    ["a profile document", canonicalJsonBytes(PROFILE), RECORD_KINDS.profileDocument],
  ])("%s under text/plain is refused", async (_name, payloadBytes, kind) => {
    const report = await checkRecord(sealDsseEnvelope({ payloadType: "text/plain", payloadBytes, signatures: [...signatures] as never }));
    expect(report.kind).toBe(kind);
    expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "payload-type-mismatch" }] });
  });

  test("a profile document under its own media type is read", async () => {
    const report = await checkRecord(sealDsseEnvelope({
      payloadType: "application/vnd.jinn.task-execution.task-profile.v1+json",
      payloadBytes: canonicalJsonBytes(PROFILE),
      signatures: [...signatures] as never,
    }));
    expect(check(report, "schema").status).toBe("passed");
  });

  test.each([
    ["remote-ref", { $ref: "https://evil.example/schema.json" }],
    ["redos-pattern", { type: "string", pattern: "(a+)+$" }],
    ["remote-dynamic-ref", { $dynamicRef: "https://evil.example/schema.json#node" }],
    ["remote-recursive-ref", { $recursiveRef: "https://evil.example/schema.json" }],
  ])("§6.4 %s: a profile whose payload schema is unsafe to load is invalid", async (_name, payloadSchema) => {
    const report = await checkRecord(canonicalJsonBytes({ ...PROFILE, payloadSchema }));
    expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "invalid-document", path: "payloadSchema" }] });
  });

  describe("§6.4 holds for a schema carried inline in an output slot", () => {
    const withSlotSchema = (schema: unknown) => canonicalJsonBytes({
      ...PROFILE,
      outputConventions: { slots: [
        { name: "first", required: true },
        { name: "out", required: true, mediaType: "application/json", schema },
      ] },
    });
    const SLOT_PATH = "outputConventions.slots.1.schema.content";
    const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

    test.each([
      ["a remote $ref, as plain JSON", JSON.stringify({ $ref: "https://evil.example/x.json" })],
      ["a remote $dynamicRef, as plain JSON", JSON.stringify({ $dynamicRef: "https://evil.example/x.json#node" })],
      ["an unsafe pattern, as plain JSON", JSON.stringify({ type: "string", pattern: "(a+)+$" })],
      ["a remote $ref, as base64", base64({ $ref: "https://evil.example/x.json" })],
      ["an unsafe pattern, as base64", base64({ type: "string", pattern: "(a+)+$" })],
      ["a remote $dynamicRef, as base64 in double quotes", `"${base64({ $dynamicRef: "https://evil.example/x.json#node" })}"`],
      ["a remote $ref as base64, in the key of a harmless object", `{"${base64({ $ref: "https://evil.example/x.json" })}":{}}`],
      ["an unsafe pattern as base64, in the key of a harmless object", `{"${base64({ type: "string", pattern: "(a+)+$" })}":{}}`],
      // Its letters decode to `{"a":"..."}`, so here the plain reading is the unsafe one of the two.
      ["a remote $ref as plain JSON, whose base64 reading is a harmless object", '{"eyJhIjoi":{},"$ref":"https://evil.example/10","In0=":{}}'],
    ])("%s is invalid", async (_name, content) => {
      const report = await checkRecord(withSlotSchema({ name: "out.schema.json", content }));
      expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "invalid-document", path: SLOT_PATH }] });
    });

    test.each([
      ["text that is no JSON", "<<not a schema>>"],
      ["a number", "123"],
      ["null", "null"],
      ["a list", "[]"],
      ["a JSON string", JSON.stringify("https://evil.example/x.json")],
      ["a JSON string of a schema", JSON.stringify(JSON.stringify({ $ref: "https://evil.example/x.json" }))],
      ["a number, as base64", base64(123)],
      ["null, as base64", base64(null)],
    ])("%s is no schema, so it cannot be shown safe to load", async (_name, content) => {
      const report = await checkRecord(withSlotSchema({ name: "out.schema.json", content }));
      expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "invalid-document", path: SLOT_PATH }] });
    });

    test.each([
      ["plain JSON", JSON.stringify({ type: "object" })],
      ["base64", base64({ type: "object" })],
      ["the boolean true", "true"],
      ["the boolean false", "false"],
      ["a boolean, as base64", base64(true)],
    ])("a safe schema as %s passes", async (_name, content) => {
      expect(check(await checkRecord(withSlotSchema({ name: "out.schema.json", content })), "schema").status).toBe("passed");
    });

    test("a slot that pins its schema by digest carries nothing to read here", async () => {
      const report = await checkRecord(withSlotSchema({ name: "out.schema.json", digest: { sha256: "4".repeat(64) } }));
      expect(check(report, "schema").status).toBe("passed");
    });

    test("both the payload schema and a slot are reported", async () => {
      const report = await checkRecord(canonicalJsonBytes({
        ...PROFILE,
        payloadSchema: { $ref: "https://evil.example/schema.json" },
        outputConventions: { slots: [{ name: "out", required: true, schema: { name: "s", content: JSON.stringify({ $ref: "https://evil.example/x.json" }) } }] },
      }));
      expect(check(report, "schema").findings.map(({ path }) => path)).toEqual(["payloadSchema", "outputConventions.slots.0.schema.content"]);
    });
  });
});

describe("§21.1: an observation is I-JSON, though §6.1 does not seal it", () => {
  const event = {
    specversion: "1.0",
    id: "evt-1",
    source: "urn:jinn:backend:local",
    subject: "urn:uuid:aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
    time: "2026-07-28T00:00:00Z",
    datacontenttype: "application/json",
    sequence: "0000000000000001",
    taskdigest: `sha256:${"2".repeat(64)}`,
    type: "network.jinn.task-execution.progress.v1",
    data: { message: "working" },
  };
  const text = JSON.stringify(event, null, 2);

  test("any spelling of an I-JSON event passes, and says what was not asked of it", async () => {
    const report = await checkRecord(encoder.encode(text));
    expect(check(report, "encoding")).toMatchObject({ status: "passed", findings: [{ code: "i-json-only" }] });
  });

  test.each([
    ["a number no double can hold", text.replace(`"working"`, `"working", "com.example.size": 1e400`)],
    ["a lone surrogate", text.replace(`"working"`, `"\\ud800"`)],
    ["a repeated member", text.replace(`"id": "evt-1",`, `"id": "evt-1", "id": "evt-2",`)],
    ["a repeated member spelled two ways", text.replace(`"id": "evt-1",`, `"id": "evt-1", "\\u0069d": "evt-2",`)],
    ["a repeated member in a nested object", text.replace(`"message": "working"`, `"message": "a", "message": "b"`)],
  ])("%s fails", async (_name, bytes) => {
    const report = await checkRecord(encoder.encode(bytes));
    expect(check(report, "encoding")).toMatchObject({ status: "failed", findings: [{ code: "not-i-json" }] });
  });

  test("a repeated member name in sibling objects is no repeat", async () => {
    const report = await checkRecord(encoder.encode(JSON.stringify({ ...event, "com.example.a": { x: 1 }, "com.example.b": { x: 1 } })));
    expect(check(report, "encoding").status).toBe("passed");
  });
});

describe("§21.3: an extension that contradicts a core field", () => {
  test.each([
    ["an absolute-URI key", "x-jinn-example.test/protocolOverride"],
    ["a reverse-DNS key", "com.example.protocolOverride"],
  ])("%s is an invalid document where a validator can see it", async (_name, key) => {
    const report = await checkRecord(canonicalJsonBytes({ ...TASK, [key]: "https://not-the-real-protocol.example/v9" }));
    expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "invalid-document", path: key }] });
  });

  test("one that repeats the core value contradicts nothing", async () => {
    const report = await checkRecord(canonicalJsonBytes({ ...TASK, "com.example.protocolOverride": TASK.protocol }));
    expect(check(report, "schema").status).toBe("passed");
  });

  test("a bare key is no namespaced extension, and one naming no core field overrides nothing", async () => {
    for (const key of ["protocolOverride", "com.example.colorOverride"]) {
      // eslint-disable-next-line no-await-in-loop -- two small records.
      const report = await checkRecord(canonicalJsonBytes({ ...TASK, [key]: "anything" }));
      expect(check(report, "schema").status).toBe("passed");
    }
  });
});

describe("a published facts profile is pinned by the release manifest, not a canonical form", () => {
  const facts = {
    protocol: "https://spec.jinn.network/record-discovery/v1",
    kind: "https://spec.jinn.network/records/task/v1",
    profile: "https://spec.jinn.network/facts/task/v2",
    fields: [{ name: "profileUri", class: "record" }, { name: "profileDigest", class: "record", referenceBearing: true }],
  };

  test("its pretty-printed bytes do not fail, and its kind field names what it describes", async () => {
    const report = await checkRecord(encoder.encode(JSON.stringify(facts, null, 2)));
    expect(report).toMatchObject({ kind: "application/vnd.jinn.record-discovery.facts-profile.v1+json", outcome: "checked" });
    expect(statuses(report)).toMatchObject({ encoding: "skipped", schema: "passed", signature: "skipped" });
    expect(check(report, "encoding").findings[0]).toMatchObject({ code: "encoding-not-required" });
  });

  test("one that does not parse as a facts profile fails its schema", async () => {
    const report = await checkRecord(encoder.encode(JSON.stringify({ ...facts, fields: [{ name: "a", class: "record" }, { name: "a", class: "record" }] })));
    expect(check(report, "schema")).toMatchObject({ status: "failed", findings: [{ code: "invalid-document" }] });
  });
});

describe("unknown kinds", () => {
  const APPLICATION_TYPE = "https://spec.jinn.network/binary-judgment/judge-observation/v1";

  test("a record naming a type nobody registered gets digest and encoding only, and says so", async () => {
    const report = await checkRecord(canonicalJsonBytes({ protocol: APPLICATION_TYPE, verdict: "yes" }));
    expect(report).toMatchObject({ kind: "unknown", names: APPLICATION_TYPE, outcome: "unknown-kind" });
    expect(report.family).toBeUndefined();
    expect(statuses(report)).toEqual({
      digest: "skipped",
      encoding: "passed",
      schema: "skipped",
      signature: "skipped",
      "trust-binding": "skipped",
    });
    for (const id of ["schema", "signature", "trust-binding"] as const) {
      expect(check(report, id).findings[0]).toMatchObject({ code: "unknown-kind" });
    }
  });

  test("a signed Statement of a predicate nobody registered names that predicate", async () => {
    const predicateType = "https://spec.jinn.network/attestations/not-registered/v1";
    const bytes = sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes({ _type: "https://in-toto.io/Statement/v1", predicateType }),
      signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:z" }],
    });
    expect(await checkRecord(bytes)).toMatchObject({ kind: "unknown", names: predicateType, outcome: "unknown-kind" });
  });

  test("a signed payload of a Jinn media type with no type field names the media type", async () => {
    const payloadType = "application/vnd.jinn.not-registered.v1+json";
    const bytes = sealDsseEnvelope({
      payloadType,
      payloadBytes: canonicalJsonBytes({}),
      signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:z" }],
    });
    expect(await checkRecord(bytes)).toMatchObject({ kind: "unknown", names: payloadType });
  });

  test("a record naming a type is held to the encoding rule", async () => {
    const report = await checkRecord(encoder.encode(JSON.stringify({ protocol: APPLICATION_TYPE }, null, 2)));
    expect(check(report, "encoding").status).toBe("failed");
    expect(report.outcome).toBe("failed");
  });

  test.each([
    ["bytes that are not text", Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe), "not-json"],
    ["text that is not JSON", encoder.encode("# A prompt\n"), "not-json"],
    ["JSON naming no type, not canonical", encoder.encode(`{ "label": "yes" }`), "not-canonical"],
  ])("%s claim to be no record, so the encoding rule is not applied", async (_name, bytes, code) => {
    const report = await checkRecord(bytes);
    expect(report).toMatchObject({ kind: "unknown", outcome: "unknown-kind" });
    expect(report.names).toBeUndefined();
    expect(check(report, "encoding").status).toBe("skipped");
    expect(check(report, "encoding").findings).toEqual([
      expect.objectContaining({ code: "not-a-record", detail: expect.stringContaining(code === "not-json" ? "not JSON" : "RFC 8785") }),
    ]);
  });

  test("canonical JSON naming no type passes the one check it can", async () => {
    const report = await checkRecord(canonicalJsonBytes({ label: "yes" }));
    expect(report).toMatchObject({ kind: "unknown", outcome: "unknown-kind" });
    expect(check(report, "encoding").status).toBe("passed");
  });
});

describe("caller kinds", () => {
  const TYPE = "https://example.test/records/note/v1";
  const note: RecordKind = {
    family: "example",
    identify: ({ document }) => (document as { protocol?: unknown } | undefined)?.protocol === TYPE,
    unsignedBecause: "notes are not signed",
    validate: ({ document }) =>
      typeof (document as { text?: unknown }).text === "string"
        ? []
        : [{ code: "invalid-document", path: "text", detail: "text must be a string" }],
  };

  test("a caller can add a kind beside the defaults", async () => {
    const kinds = { ...defaultRecordKinds, [TYPE]: note };
    const good = await checkRecord(canonicalJsonBytes({ protocol: TYPE, text: "hello" }), { kinds });
    expect(good).toMatchObject({ kind: TYPE, family: "example", outcome: "checked" });
    const bad = await checkRecord(canonicalJsonBytes({ protocol: TYPE }), { kinds });
    expect(check(bad, "schema").findings[0]).toMatchObject({ path: "text" });
    expect(await checkRecord(sealTask(TASK), { kinds })).toMatchObject({ kind: RECORD_KINDS.task });
  });

  test("a validator that throws is a failed check, not a thrown error", async () => {
    const kinds = { [TYPE]: { ...note, validate: () => { throw new Error("validator bug"); } } };
    const report = await checkRecord(canonicalJsonBytes({ protocol: TYPE }), { kinds });
    expect(check(report, "schema").status).toBe("failed");
    expect(check(report, "schema").findings[0]).toMatchObject({ code: "check-threw", detail: "validator bug" });
  });

  test("an identify that throws matches nothing", async () => {
    const kinds = { [TYPE]: { ...note, identify: () => { throw new Error("identify bug"); } } };
    expect(await checkRecord(canonicalJsonBytes({ protocol: TYPE }), { kinds })).toMatchObject({ kind: "unknown" });
  });

  test("two kinds claiming one record is reported, not silently resolved", async () => {
    const kinds = { [TYPE]: note, "https://example.test/records/also-note/v1": note };
    const report = await checkRecord(canonicalJsonBytes({ protocol: TYPE, text: "hello" }), { kinds });
    expect(codes(check(report, "schema"))).toEqual(["ambiguous-kind"]);
  });
});

describe("signature", () => {
  test("an evaluation signed by a did:key verifies from the key in its own keyid", async () => {
    const key = ed25519();
    const report = await checkRecord(signedEvaluation(key));
    expect(report.kind).toBe(RECORD_KINDS.resultEvaluation);
    expect(check(report, "signature")).toEqual({ id: "signature", status: "passed", findings: [] });
  });

  test("a signature that does not verify fails and names the key", async () => {
    const key = ed25519();
    const other = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(other))) as {
      signatures: { keyid: string }[];
    };
    envelope.signatures[0]!.keyid = key.keyid;
    const report = await checkRecord(encoder.encode(JSON.stringify(envelope)));
    expect(check(report, "signature").status).toBe("failed");
    expect(check(report, "signature").findings).toEqual([
      expect.objectContaining({ code: "signature-invalid", subject: key.keyid }),
    ]);
  });

  test("a keyid no key is known for says skipped, never passed", async () => {
    const key = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(key))) as {
      signatures: { keyid: string }[];
    };
    envelope.signatures[0]!.keyid = "evaluator-key-1";
    const bytes = encoder.encode(JSON.stringify(envelope));
    const report = await checkRecord(bytes);
    expect(check(report, "signature").status).toBe("skipped");
    expect(check(report, "signature").findings).toEqual([
      expect.objectContaining({ code: "no-verification-key", subject: "evaluator-key-1" }),
    ]);
    const supplied = await checkRecord(bytes, { trust: { keys: [{ keyId: "evaluator-key-1", publicKey: key.publicKey }] } });
    expect(check(supplied, "signature").status).toBe("passed");
  });

  test("a supplied key of another algorithm is not verified and not passed", async () => {
    const key = ed25519();
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const report = await checkRecord(signedEvaluation(key), { trust: { keys: [{ keyId: key.keyid, publicKey }] } });
    expect(check(report, "signature").status).toBe("skipped");
  });

  test("evidence claims may be respelled: the family text requires a DSSE object, not an encoding", async () => {
    const key = ed25519();
    const report = await checkRecord(signedEvaluation(key));
    expect(check(report, "encoding").status).toBe("skipped");
    expect(check(report, "encoding").findings[0]).toMatchObject({ code: "encoding-not-required" });
    expect(check(report, "encoding").findings[0]!.detail).toContain("Execution Evidence Profile");
    expect(check(report, "schema").status).toBe("passed");
  });

  test("a signed Delivery is held to the sealed encoding and verified against its payload", async () => {
    const key = ed25519();
    const payloadBytes = sealDelivery(DELIVERY);
    const { envelopeBytes } = await sealSignedPayload({
      payloadBytes,
      payloadType: DELIVERY_MEDIA_TYPE,
      signer: async ({ preAuthEncoding }) => [
        { keyid: key.keyid, signature: new Uint8Array(sign(null, preAuthEncoding, key.privateKey)) },
      ],
    });
    const report = await checkRecord(envelopeBytes);
    expect(report).toMatchObject({ kind: RECORD_KINDS.delivery, outcome: "checked" });
    expect(statuses(report)).toMatchObject({ encoding: "passed", schema: "passed", signature: "passed" });
  });

  test("a respelled envelope of a sealed family fails encoding and signature, and the strict reader is not relaxed", async () => {
    const key = ed25519();
    const { envelopeBytes } = await sealSignedPayload({
      payloadBytes: sealDelivery(DELIVERY),
      payloadType: DELIVERY_MEDIA_TYPE,
      signer: async ({ preAuthEncoding }) => [
        { keyid: key.keyid, signature: new Uint8Array(sign(null, preAuthEncoding, key.privateKey)) },
      ],
    });
    const respelled = encoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(envelopeBytes)), null, 2));
    const report = await checkRecord(respelled);
    expect(codes(check(report, "encoding"))).toEqual(["not-canonical"]);
    expect(check(report, "signature").status).toBe("failed");
  });

  test("a signed record whose payload is not canonical fails encoding", async () => {
    const key = ed25519();
    const { envelopeBytes } = await sealSignedPayload({
      payloadBytes: encoder.encode(JSON.stringify(DELIVERY, null, 2)),
      payloadType: DELIVERY_MEDIA_TYPE,
      signer: async ({ preAuthEncoding }) => [
        { keyid: key.keyid, signature: new Uint8Array(sign(null, preAuthEncoding, key.privateKey)) },
      ],
    });
    const report = await checkRecord(envelopeBytes);
    expect(codes(check(report, "encoding"))).toEqual(["not-canonical"]);
    expect(check(report, "signature").status).toBe("passed");
  });

  test("one verified signature beside one with no key passes, and says what it did not cover", async () => {
    const key = ed25519();
    const payloadBytes = canonicalJsonBytes(evaluationStatement());
    const signature = new Uint8Array(sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), key.privateKey));
    const bytes = sealDsseEnvelope({
      payloadBytes,
      signatures: [{ keyid: key.keyid, signature }, { keyid: "evaluator-key-1", signature }],
    });
    expect(check(await checkRecord(bytes), "signature")).toMatchObject({
      status: "passed",
      findings: [{ code: "no-verification-key", subject: "evaluator-key-1" }],
    });
  });

  test("naming the bound key is not being signed by it", async () => {
    const other = ed25519();
    const secp256k1 = "did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme";
    const payloadBytes = canonicalJsonBytes({
      protocol: "https://spec.jinn.network/trust/key-binding/v1",
      agent: AGENT,
      key: { publicKey: secp256k1, keyid: secp256k1, algorithm: "secp256k1", didKey: secp256k1 },
      voucher: { kind: "account", did: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", contractAccount: false },
      relationship: "controls",
      scope: ["verdicts"],
      validFrom: "2026-07-28T00:00:00Z",
      ceremony: { type: "eoa", digest: `sha256:${"a".repeat(64)}` },
      strength: "strong",
      anchors: [],
    });
    const payloadType = "application/vnd.jinn.trust.key-binding.v1+json";
    const bytes = sealDsseEnvelope({
      payloadType,
      payloadBytes,
      signatures: [
        { keyid: secp256k1, signature: Uint8Array.of(1, 2, 3) },
        { keyid: other.keyid, signature: new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), other.privateKey)) },
      ],
    });
    expect(check(await checkRecord(bytes), "signature").status).toBe("skipped");
  });

  describe("a revocation names who signed it", () => {
    const revocation = (revokedBy: string) => ({
      protocol: "https://spec.jinn.network/trust/revocation/v1",
      target: `sha256:${"b".repeat(64)}`,
      revokedBy,
      effectiveFrom: "2026-07-29T00:00:00Z",
      anchors: [],
    });
    const payloadType = "application/vnd.jinn.trust.revocation.v1+json";

    test("a key other than its did:key revokedBy is refused", async () => {
      const revoker = ed25519();
      const { envelopeBytes } = await signedRecord(ed25519(), revocation(revoker.keyid), payloadType);
      expect(check(await checkRecord(envelopeBytes), "signature")).toMatchObject({
        status: "failed",
        findings: [{ code: "required-signer-missing", subject: revoker.keyid }],
      });
    });

    test("its own did:key passes", async () => {
      const revoker = ed25519();
      const { envelopeBytes } = await signedRecord(revoker, revocation(revoker.keyid), payloadType);
      expect(check(await checkRecord(envelopeBytes), "signature").status).toBe("passed");
    });

    describe("under a voucher account's did:pkh", () => {
      const account = "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
      const payloadBytes = canonicalJsonBytes(revocation(account));
      const stranger = ed25519();
      const strangerSignature = {
        keyid: stranger.keyid,
        signature: new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), stranger.privateKey)),
      };

      test("a stranger's signature does not stand in for it", async () => {
        const report = await checkRecord(sealDsseEnvelope({ payloadType, payloadBytes, signatures: [strangerSignature] }));
        expect(check(report, "signature")).toMatchObject({
          status: "failed",
          findings: [{ code: "required-signer-missing", subject: account }],
        });
      });

      test("a signature naming it is no key this can verify, so it says skipped", async () => {
        const report = await checkRecord(sealDsseEnvelope({ payloadType, payloadBytes, signatures: [{ keyid: account, signature: Uint8Array.of(1) }] }));
        expect(check(report, "signature").status).toBe("skipped");
      });

      test("a stranger's valid signature beside it does not make that passed", async () => {
        const report = await checkRecord(sealDsseEnvelope({
          payloadType,
          payloadBytes,
          signatures: [{ keyid: account, signature: Uint8Array.of(1) }, strangerSignature],
        }));
        expect(check(report, "signature").status).toBe("skipped");
      });
    });
  });

  test("a key binding must be signed by the working key it binds", async () => {
    const working = ed25519();
    const stranger = ed25519();
    const binding = {
      protocol: "https://spec.jinn.network/trust/key-binding/v1",
      agent: AGENT,
      key: { publicKey: working.keyid, keyid: working.keyid, algorithm: "ed25519", didKey: working.keyid },
      voucher: { kind: "account", did: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", contractAccount: false },
      relationship: "controls",
      scope: ["verdicts"],
      validFrom: "2026-07-28T00:00:00Z",
      ceremony: { type: "eoa", digest: `sha256:${"a".repeat(64)}` },
      strength: "strong",
      anchors: [],
    };
    const { envelopeBytes: wrong } = await signedRecord(stranger, binding, "application/vnd.jinn.trust.key-binding.v1+json");
    const wrongReport = await checkRecord(wrong);
    expect(check(wrongReport, "signature").status).toBe("failed");
    expect(check(wrongReport, "signature").findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "required-signer-missing", subject: working.keyid })]),
    );
    const { envelopeBytes: right } = await signedRecord(working, binding, "application/vnd.jinn.trust.key-binding.v1+json");
    expect(check(await checkRecord(right), "signature").status).toBe("passed");
  });
});

describe("what a report counts about signatures", () => {
  const unsigned = { total: 0, verified: 0, verifiedWithSuppliedKey: 0, invalid: 0, unverified: 0 };

  test("an unsigned record has none", async () => {
    expect((await checkRecord(sealTask(TASK))).signatures).toEqual(unsigned);
  });

  test("a signature verified from the key in its own keyid is not a supplied key", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()));
    expect(report.signatures).toEqual({ ...unsigned, total: 1, verified: 1 });
    expect(check(report, "signature").findings).toEqual([]);
  });

  test("a signature verified against a supplied key says exactly that, and trust binding stays skipped", async () => {
    const key = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(key))) as { signatures: { keyid: string }[] };
    envelope.signatures[0]!.keyid = "evaluator-key-1";
    const report = await checkRecord(encoder.encode(JSON.stringify(envelope)), {
      trust: { keys: [{ keyId: "evaluator-key-1", publicKey: key.publicKey }] },
    });
    expect(report.signatures).toEqual({ ...unsigned, total: 1, verified: 1, verifiedWithSuppliedKey: 1 });
    expect(check(report, "signature")).toMatchObject({
      status: "passed",
      findings: [{ code: "verified-with-supplied-key", subject: "evaluator-key-1", detail: expect.stringContaining("not whose key it is") }],
    });
    expect(check(report, "trust-binding")).toMatchObject({ status: "skipped", findings: [{ code: "no-binding-resolver" }] });
  });

  test("a signature with no key is unverified", async () => {
    const key = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(key))) as { signatures: { keyid: string }[] };
    envelope.signatures[0]!.keyid = "unknown-key";
    expect((await checkRecord(encoder.encode(JSON.stringify(envelope)))).signatures).toEqual({ ...unsigned, total: 1, unverified: 1 });
  });

  test("a signature that does not verify is invalid", async () => {
    const key = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(ed25519()))) as { signatures: { keyid: string }[] };
    envelope.signatures[0]!.keyid = key.keyid;
    expect((await checkRecord(encoder.encode(JSON.stringify(envelope)))).signatures).toEqual({ ...unsigned, total: 1, invalid: 1 });
  });

  test("one valid signature does not vouch for others under its keyid", async () => {
    const key = ed25519();
    const payloadBytes = canonicalJsonBytes(evaluationStatement());
    const good = new Uint8Array(sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), key.privateKey));
    const bytes = sealDsseEnvelope({
      payloadBytes,
      signatures: [{ keyid: key.keyid, signature: good }, ...new Array(3).fill({ keyid: key.keyid, signature: new Uint8Array(64) })],
    });
    const report = await checkRecord(bytes);
    expect(report.signatures).toEqual({ ...unsigned, total: 4, verified: 1, invalid: 3 });
    expect(check(report, "signature").status).toBe("failed");
  });

  test("one key signing twice is two signatures", async () => {
    const key = ed25519();
    const payloadBytes = canonicalJsonBytes(evaluationStatement());
    const signature = new Uint8Array(sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), key.privateKey));
    const report = await checkRecord(sealDsseEnvelope({ payloadBytes, signatures: [{ keyid: key.keyid, signature }, { keyid: key.keyid, signature }] }));
    expect(report.signatures).toEqual({ ...unsigned, total: 2, verified: 2 });
  });

  test("a record of unknown kind has no envelope rule, so a respelled envelope still verifies", async () => {
    const key = ed25519();
    const payloadType = "application/vnd.jinn.not-registered.v1+json";
    const payloadBytes = canonicalJsonBytes({});
    const signature = new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), key.privateKey));
    const sealed = sealDsseEnvelope({ payloadType, payloadBytes, signatures: [{ signature, keyid: key.keyid }] });
    const respelled = encoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(sealed)), null, 2));
    expect((await checkRecord(respelled)).signatures).toEqual({ ...unsigned, total: 1, verified: 1 });
  });

  test("a bad signature on a record of unknown kind fails, whatever the record is", async () => {
    const key = ed25519();
    const bytes = sealDsseEnvelope({
      payloadType: "application/vnd.jinn.not-registered.v1+json",
      payloadBytes: canonicalJsonBytes({}),
      signatures: [{ signature: new Uint8Array(64), keyid: key.keyid }],
    });
    const report = await checkRecord(bytes);
    expect(report).toMatchObject({ kind: "unknown", outcome: "failed", signatures: { ...unsigned, total: 1, invalid: 1 } });
  });

  test("a good signature on a record of unknown kind verifies, and does not make the kind known", async () => {
    const key = ed25519();
    const payloadType = "application/vnd.jinn.not-registered.v1+json";
    const payloadBytes = canonicalJsonBytes({});
    const signature = new Uint8Array(sign(null, dssePreAuthEncoding(payloadType, payloadBytes), key.privateKey));
    const report = await checkRecord(sealDsseEnvelope({ payloadType, payloadBytes, signatures: [{ signature, keyid: key.keyid }] }));
    expect(report).toMatchObject({ kind: "unknown", outcome: "unknown-kind", signatures: { ...unsigned, total: 1, verified: 1 } });
    expect(check(report, "signature").status).toBe("passed");
    expect(check(report, "schema").status).toBe("skipped");
  });

  test("a signed record of unknown kind is counted unverified and says it is signed", async () => {
    const bytes = sealDsseEnvelope({
      payloadType: "application/vnd.jinn.not-registered.v1+json",
      payloadBytes: canonicalJsonBytes({}),
      signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:z" }],
    });
    const report = await checkRecord(bytes);
    expect(report.signatures).toEqual({ ...unsigned, total: 1, unverified: 1 });
    expect(check(report, "signature")).toMatchObject({ status: "skipped", findings: [{ code: "unknown-kind", detail: expect.stringContaining("1 signature") }] });
  });
});

describe("a corrupted signed record", () => {
  const key = ed25519();
  const payloadBytes = encoder.encode(JSON.stringify(evaluationStatement()));
  const envelope = {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payloadBytes).toString("base64"),
    signatures: [{ keyid: key.keyid, sig: sign(null, dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes), key.privateKey).toString("base64") }],
  };

  test.each([
    ["a signature that is not base64", { signatures: [{ keyid: key.keyid, sig: "not base64!!" }] }],
    ["no signatures", { signatures: [] }],
    ["a payload that is not base64", { payload: "not base64!!" }],
    ["signatures that are not a list", { signatures: {} }],
    ["a payload that is not a string", { payload: 5 }],
    ["a payloadType that is not a string", { payloadType: 5 }],
  ])("%s fails: it claims to be signed, so it is not an artifact of unknown kind", async (_name, damage) => {
    const report = await checkRecord(encoder.encode(JSON.stringify({ ...envelope, ...damage })));
    expect(report.outcome).toBe("failed");
    expect(check(report, "encoding")).toMatchObject({ status: "failed", findings: [{ code: "malformed-envelope" }] });
  });

  test.each(["payload", "payloadType", "signatures"] as const)("with no %s it is not an envelope, so nothing claims to be signed", async (member) => {
    const { [member]: _dropped, ...partial } = envelope;
    expect((await checkRecord(encoder.encode(JSON.stringify(partial)))).outcome).toBe("unknown-kind");
  });

  test("the same bytes unbroken read as the claim they are", async () => {
    expect(await checkRecord(encoder.encode(JSON.stringify(envelope)))).toMatchObject({ kind: RECORD_KINDS.resultEvaluation, outcome: "checked" });
  });
});

describe("trust binding", () => {
  function resolving(binding: Partial<ResolvedBinding["binding"]>): BindingResolver {
    const resolved = {
      binding: {
        agent: AGENT,
        scope: ["verdicts"],
        relationship: "controls",
        validFrom: "2026-01-01T00:00:00Z",
        voucher: { kind: "agentId", caip19: "eip155:1/erc721:0x0000000000000000000000000000000000000000/1" },
        ceremony: { type: "agentId", digest: `sha256:${"a".repeat(64)}` },
        ...binding,
      },
      envelopeBytes: new Uint8Array(),
      bindingDigest: `sha256:${"b".repeat(64)}`,
      effectiveStart: "2026-01-01T00:00:00Z",
      isGenesis: true,
      revocations: [],
    } as unknown as ResolvedBinding;
    return { resolveBinding: async () => resolved };
  }

  test("with no resolver the check is skipped, whatever the signature did", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()));
    expect(check(report, "trust-binding").status).toBe("skipped");
    expect(check(report, "trust-binding").findings[0]).toMatchObject({ code: "no-binding-resolver" });
  });

  test("a resolved binding for the claimed agent, in scope at the record's own time, passes", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()), { trust: { bindingResolver: resolving({}) } });
    expect(check(report, "trust-binding")).toEqual({ id: "trust-binding", status: "passed", findings: [] });
  });

  test("a binding outside the record's family fails and carries trust-core's reason", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()), {
      trust: { bindingResolver: resolving({ scope: ["deliveries"] }) },
    });
    expect(check(report, "trust-binding").status).toBe("failed");
    expect(codes(check(report, "trust-binding"))).toEqual(["scope-violation"]);
    expect(report.outcome).toBe("failed");
  });

  test("§7.5b: a signed Submission's requester may be bound by signs-for alone", async () => {
    const key = ed25519();
    const { envelopeBytes } = await signedRecord(key, SUBMISSION, "application/vnd.jinn.task-execution.submission.v1+json");
    const report = await checkRecord(envelopeBytes, {
      trust: {
        bindingResolver: resolving({ agent: SUBMISSION.requester, relationship: "signs-for", scope: ["deliveries"] }),
        atTime: "2026-01-15T00:00:00Z",
      },
    });
    expect(check(report, "trust-binding").status).toBe("passed");
  });

  test("a binding for another agent is not this agent's", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()), {
      trust: { bindingResolver: resolving({ agent: "urn:uuid:22222222-2222-4222-8222-222222222222" }) },
    });
    expect(codes(check(report, "trust-binding"))).toEqual(["binding-not-resolved"]);
  });

  test("an unverified signature gives the binding nothing to bind", async () => {
    const key = ed25519();
    const envelope = JSON.parse(new TextDecoder().decode(signedEvaluation(key))) as {
      signatures: { keyid: string }[];
    };
    envelope.signatures[0]!.keyid = "unknown-key";
    const report = await checkRecord(encoder.encode(JSON.stringify(envelope)), {
      trust: { bindingResolver: resolving({}) },
    });
    expect(check(report, "trust-binding").status).toBe("skipped");
    expect(check(report, "trust-binding").findings[0]).toMatchObject({ code: "no-verified-signer" });
  });

  test("a witness verifier that throws is an outage too", async () => {
    const bindingResolver = resolving({ ceremony: { type: "safe", digest: `sha256:${"a".repeat(64)}` } as never });
    const resolved = await bindingResolver.resolveBinding({ key: "", agent: "" }, "");
    const report = await checkRecord(signedEvaluation(ed25519()), {
      trust: {
        bindingResolver: { resolveBinding: async () => ({ ...resolved!, witness: {} as never }) },
        witnessVerifier: { verify1271Witness: async () => { throw new Error("no route to host"); } },
      },
    });
    expect(check(report, "trust-binding")).toMatchObject({ status: "skipped", findings: [{ code: "binding-dependency-failed" }] });
  });

  test("a resolver that throws is an outage, not a verdict on the record", async () => {
    const bindingResolver: BindingResolver = { resolveBinding: async () => { throw new Error("no route to host"); } };
    const report = await checkRecord(signedEvaluation(ed25519()), { trust: { bindingResolver } });
    expect(check(report, "trust-binding").status).toBe("skipped");
    expect(check(report, "trust-binding").findings[0]).toMatchObject({
      code: "binding-dependency-failed",
      detail: expect.stringContaining("no route to host"),
    });
  });

  test("a resolver decides: a refusal from it fails, and its outage skips", async () => {
    const refusing: BindingResolver = { resolveBinding: async () => null };
    const refused = await checkRecord(signedEvaluation(ed25519()), { trust: { bindingResolver: refusing } });
    expect(check(refused, "trust-binding")).toMatchObject({ status: "failed", findings: [{ code: "binding-not-resolved" }] });
    expect(refused.outcome).toBe("failed");

    const down: BindingResolver = { resolveBinding: async () => { throw new Error("no route to host"); } };
    const unreached = await checkRecord(signedEvaluation(ed25519()), { trust: { bindingResolver: down } });
    expect(check(unreached, "trust-binding")).toMatchObject({ status: "skipped", findings: [{ code: "binding-dependency-failed" }] });
    expect(unreached.outcome).toBe("checked");
  });

  test("a refusal for one signer and an outage for the next is an outage: the record could still bind", async () => {
    const first = ed25519();
    const second = ed25519();
    const payloadBytes = encoder.encode(JSON.stringify(evaluationStatement(), null, 2));
    const encoded = dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, payloadBytes);
    const twoSigners = encoder.encode(JSON.stringify({
      payloadType: DSSE_PAYLOAD_TYPE,
      payload: Buffer.from(payloadBytes).toString("base64"),
      signatures: [first, second].map(({ keyid, privateKey }) => ({ keyid, sig: sign(null, encoded, privateKey).toString("base64") })),
    }, null, 2));
    let asked = 0;
    const bindingResolver: BindingResolver = {
      resolveBinding: async () => {
        asked += 1;
        if (asked === 1) return null;
        throw new Error("no route to host");
      },
    };
    const report = await checkRecord(twoSigners, { trust: { bindingResolver } });
    expect(asked).toBe(2);
    expect(check(report, "trust-binding")).toMatchObject({ status: "skipped", findings: [{ code: "binding-dependency-failed" }] });
  });

  describe("over the real resolver", () => {
    const CEREMONY = `sha256:${"c".repeat(64)}` as const;

    /** A store holding one binding the host must verify, and nothing else this package can read. */
    function realResolver(options: {
      readonly key: ReturnType<typeof ed25519>;
      readonly type?: "oidc-machine" | "safe";
      readonly verifyHostedCeremony: () => Promise<boolean>;
      readonly witness?: Eip1271Witness;
    }): BindingResolver {
      const { key, type = "oidc-machine", verifyHostedCeremony, witness } = options;
      const binding = {
        protocol: "https://spec.jinn.network/trust/key-binding/v1",
        agent: AGENT,
        key: { publicKey: key.keyid, keyid: key.keyid, algorithm: "ed25519", didKey: key.keyid },
        voucher: { kind: "oidc-machine", subject: "repo:example/example:ref:refs/heads/main" },
        relationship: "controls",
        scope: ["verdicts"],
        validFrom: "2026-01-01T00:00:00Z",
        ceremony: { type, digest: CEREMONY },
        strength: "strong",
        anchors: [],
      } as unknown as KeyBinding;
      const record: SealedKeyBindingRecord = {
        binding,
        envelopeBytes: Uint8Array.of(1),
        bindingDigest: `sha256:${"d".repeat(64)}`,
        ...(witness === undefined ? {} : { witness }),
      };
      return createBindingResolver({
        bindings: { listBindingsForAgent: async () => [record], listRevocationsForTargets: async () => [] },
        anchors: { lookupAnchor: async () => null },
        requireAnchors: false,
        recordSignedByItsKey: () => true,
        verifyHostedCeremony,
      });
    }

    test("a host's refusal fails the record", async () => {
      const key = ed25519();
      const report = await checkRecord(signedEvaluation(key), {
        trust: { bindingResolver: realResolver({ key, verifyHostedCeremony: async () => false }) },
      });
      expect(check(report, "trust-binding")).toMatchObject({ status: "failed", findings: [{ code: "binding-not-resolved" }] });
      expect(report.outcome).toBe("failed");
    });

    test("a host's outage is not a refusal: it says the binding could not be resolved, and nothing passes", async () => {
      const key = ed25519();
      const report = await checkRecord(signedEvaluation(key), {
        trust: {
          bindingResolver: realResolver({
            key,
            verifyHostedCeremony: async () => {
              throw new Error("no route to host");
            },
          }),
        },
      });
      expect(check(report, "trust-binding")).toMatchObject({
        status: "skipped",
        findings: [{ code: "binding-dependency-failed", detail: expect.stringContaining("no route to host") }],
      });
      expect(report.outcome).toBe("checked");
    });

    test("a witness archive that cannot be read is an outage, and one that answers no fails the record", async () => {
      const key = ed25519();
      const statement = {
        chainId: 84532,
        blockNumber: 12345,
        blockHash: `0x${"cc".repeat(32)}`,
        verifier: "urn:uuid:44444444-4444-4444-8444-444444444444",
        safe: "0x4444444444444444444444444444444444444444",
        hash: `0x${"aa".repeat(32)}`,
        signature: `0x${"bb".repeat(65)}`,
        result: "0x1626ba7e",
      };
      const witness: Eip1271Witness = {
        chainId: statement.chainId,
        blockNumber: statement.blockNumber,
        blockHash: statement.blockHash,
        verifier: statement.verifier,
        envelopeBytes: sealDsseEnvelope({
          payloadBytes: encoder.encode(JSON.stringify(statement)),
          payloadType: DSSE_PAYLOAD_TYPE,
          signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:zWitness" }],
        }),
      };
      const reportWith = (readContract: () => Promise<unknown>) => checkRecord(signedEvaluation(key), {
        trust: {
          bindingResolver: realResolver({ key, type: "safe", verifyHostedCeremony: async () => true, witness }),
          witnessVerifier: createWitnessVerifier({ archiveClient: { readContract } }),
        },
      });

      const down = await reportWith(async () => {
        throw new Error("no route to host");
      });
      expect(check(down, "trust-binding")).toMatchObject({ status: "skipped", findings: [{ code: "binding-dependency-failed" }] });

      const refused = await reportWith(async () => "0xdeadbeef");
      expect(check(refused, "trust-binding")).toMatchObject({ status: "failed", findings: [{ code: "ceremony-verification-failed" }] });
    });
  });

  test("a key binding record is attributed to its own agent, scope and start", async () => {
    const working = ed25519();
    const { envelopeBytes } = await signedRecord(working, {
      protocol: "https://spec.jinn.network/trust/key-binding/v1",
      agent: AGENT,
      key: { publicKey: working.keyid, keyid: working.keyid, algorithm: "ed25519", didKey: working.keyid },
      voucher: { kind: "account", did: "did:pkh:eip155:8453:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", contractAccount: false },
      relationship: "controls",
      scope: ["verdicts"],
      validFrom: "2026-07-28T00:00:00Z",
      ceremony: { type: "agentId", digest: `sha256:${"a".repeat(64)}` },
      strength: "strong",
      anchors: [],
    }, "application/vnd.jinn.trust.key-binding.v1+json");
    const seen: unknown[] = [];
    const bindingResolver: BindingResolver = {
      resolveBinding: async (query, atTime) => {
        seen.push([query.agent, atTime]);
        return resolving({}).resolveBinding(query, atTime);
      },
    };
    expect(check(await checkRecord(envelopeBytes, { trust: { bindingResolver } }), "trust-binding").status).toBe("passed");
    expect(seen[0]).toEqual([AGENT, "2026-07-28T00:00:00Z"]);
  });

  test("a kind that names no agent is skipped and says why", async () => {
    const report = await checkRecord(sealTask(TASK), { trust: { bindingResolver: resolving({}) } });
    expect(check(report, "trust-binding").status).toBe("skipped");
  });

  test("the caller's atTime overrides the record's own time", async () => {
    const report = await checkRecord(signedEvaluation(ed25519()), {
      trust: { bindingResolver: resolving({ expiresAt: "2026-02-01T00:00:00Z" }), atTime: "2026-01-15T00:00:00Z" },
    });
    expect(check(report, "trust-binding").status).toBe("passed");
    const late = await checkRecord(signedEvaluation(ed25519()), {
      trust: { bindingResolver: resolving({ expiresAt: "2026-02-01T00:00:00Z" }) },
    });
    expect(codes(check(late, "trust-binding"))).toEqual(["window-violation"]);
  });
});

describe("a bad record never throws", () => {
  test.each([
    ["empty bytes", new Uint8Array()],
    ["invalid UTF-8", Uint8Array.of(0xc3, 0x28)],
    ["null", encoder.encode("null")],
    ["an array", encoder.encode("[1,2,3]")],
    ["a number", encoder.encode("7")],
    ["an unterminated object", encoder.encode(`{"protocol":`)],
    ["deep nesting", encoder.encode(`${"[".repeat(200_000)}${"]".repeat(200_000)}`)],
    ["a lone surrogate", encoder.encode(`{"protocol":"https://spec.jinn.network/x/v1","a":"\\ud800"}`)],
    ["a prototype key", encoder.encode(`{"__proto__":{"protocol":"${TASK_EXECUTION_PROTOCOL_URI}"}}`)],
    ["a DSSE envelope with a bad payload", encoder.encode(`{"payload":"!!!","payloadType":"${DSSE_PAYLOAD_TYPE}","signatures":[]}`)],
    ["a DSSE envelope with no signatures", encoder.encode(`{"payload":"e30=","payloadType":"${DSSE_PAYLOAD_TYPE}","signatures":[]}`)],
    ["a signature with a bad keyid", sealDsseEnvelope({ payloadBytes: encoder.encode("{}"), signatures: [{ signature: Uint8Array.of(1), keyid: "did:key:z" }] })],
  ])("%s", async (_name, bytes) => {
    const report = await checkRecord(bytes, { digest: "not a digest" });
    expect(report.checks).toHaveLength(5);
    expect(check(report, "digest").status).toBe("failed");
  });
});
