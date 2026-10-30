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
import type { BindingResolver, DsseProducedSignature, ResolvedBinding } from "@jinn-network/trust-core";
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

  test("a resolver that throws is an outage, not a verdict on the record", async () => {
    const bindingResolver: BindingResolver = { resolveBinding: async () => { throw new Error("no route to host"); } };
    const report = await checkRecord(signedEvaluation(ed25519()), { trust: { bindingResolver } });
    expect(check(report, "trust-binding").status).toBe("skipped");
    expect(check(report, "trust-binding").findings[0]).toMatchObject({
      code: "binding-dependency-failed",
      detail: expect.stringContaining("no route to host"),
    });
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
