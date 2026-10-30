// SPDX-License-Identifier: Apache-2.0

/**
 * The published conformance vectors, driven through `checkRecord` and `checkRecordSet`. Every vector
 * is read through its package's digest manifest, so one that changed fails here as a vector.
 *
 * `conformance.test.ts` runs the primitives over some of the same files; this suite is about what a
 * reader is told. Where a vector states its expected outcome as data, that data is the assertion.
 */

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  TRUST_POLICY_MEDIA_TYPE,
  canonicalJsonBytes,
  sealAnchorEvidence,
  sealAuthorization,
  sealKeyBinding,
  sealRevocation,
  sealTrustPolicy,
} from "@jinn-network/trust-core";
import type { DsseSigner, SealedRecord, TrustPolicy } from "@jinn-network/trust-core";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";

import { OBSERVATION_KIND, checkRecord, checkRecordSet, evaluateAnchors, recordDigest } from "./index.js";
import type { CheckResult, RecordCheckId, RecordReport, RecordSetInputRecord } from "./index.js";

const require = createRequire(import.meta.url);

interface Manifest {
  readonly entries: readonly { readonly id: string; readonly sha256: string }[];
}

function fixtures(packageName: string) {
  const directory = `${packageName}/fixtures`;
  const manifest = JSON.parse(readFileSync(require.resolve(`${directory}/manifest.sha256.json`), "utf8")) as Manifest;
  const digests = new Map(manifest.entries.map(({ id, sha256 }) => [id, `sha256:${sha256}`]));
  const bytes = (id: string): Uint8Array => {
    const read = new Uint8Array(readFileSync(require.resolve(`${directory}/${id}`)));
    expect(recordDigest(read), `${id} changed against its manifest`).toBe(digests.get(id));
    return read;
  };
  return { bytes, json: <T>(id: string): T => JSON.parse(new TextDecoder().decode(bytes(id))) as T, ids: [...digests.keys()] };
}

const trust = fixtures("@jinn-network/trust-core");
const tasks = fixtures("@jinn-network/task-execution-protocol");
const evidence = fixtures("@jinn-network/evidence-protocol");
const offers = fixtures("@jinn-network/evidence-offer");

function check(report: RecordReport, id: RecordCheckId): CheckResult<RecordCheckId> {
  return report.checks.find((candidate) => candidate.id === id)!;
}

function statuses(report: RecordReport): Record<string, string> {
  return Object.fromEntries(report.checks.map(({ id, status }) => [id, status]));
}

function digestOf(reports: readonly RecordReport[], kind: string): readonly string[] {
  return reports.filter((report) => report.kind === kind).map(({ digest }) => digest);
}

describe("trust-core sealing-v1", () => {
  const placeholder = (keyid: string, ...signature: number[]): DsseSigner =>
    async () => [{ signature: new Uint8Array(signature), keyid }];
  const WORKING_KEY = "did:key:z6MkfriendlyWorkingKey";
  const POLICY_KEY = "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz";
  const expected = trust.json<Record<string, string>>("sealing-v1/expected-digests.json");

  test.each<[string, string, (document: never) => Promise<SealedRecord>, string]>([
    // Sealed by a placeholder rather than the key it binds. The vector pins a digest, and this says so.
    ["key-binding", RECORD_KINDS.keyBinding, (document) => sealKeyBinding(document, placeholder(WORKING_KEY, 1, 2, 3)), "failed"],
    ["revocation", "https://spec.jinn.network/trust/revocation/v1", (document) => sealRevocation(document, placeholder(WORKING_KEY, 4, 5, 6)), "skipped"],
    ["authorization", RECORD_KINDS.authorization, (document) => sealAuthorization(document, placeholder(WORKING_KEY, 7, 8, 9)), "skipped"],
    // This keyid is a real Ed25519 did:key, so its placeholder signature can be checked, and fails.
    ["policy", RECORD_KINDS.trustPolicy, (document) => sealTrustPolicy(document, placeholder(POLICY_KEY, 1)), "failed"],
  ])("the %s vector seals to its pinned digest and reads as %s", async (name, kind, seal, signature) => {
    const { envelopeBytes } = await seal(trust.json<never>(`sealing-v1/${name}.json`));
    const report = await checkRecord(envelopeBytes, { digest: expected[`${name}-golden`]! });
    expect(report.kind).toBe(kind);
    expect(statuses(report)).toEqual({
      digest: "passed",
      encoding: "passed",
      schema: "passed",
      signature,
      "trust-binding": "skipped",
    });
  });

  test("the key-binding vector's signature names a key other than the one it binds", async () => {
    const { envelopeBytes } = await sealKeyBinding(trust.json<never>("sealing-v1/key-binding.json"), placeholder(WORKING_KEY, 1, 2, 3));
    expect(check(await checkRecord(envelopeBytes), "signature").findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "required-signer-missing", subject: POLICY_KEY })]),
    );
  });

  test("the bare documents are not records: a signed record is an envelope", async () => {
    const report = await checkRecord(trust.bytes("sealing-v1/key-binding.json"));
    expect(check(report, "schema").status).toBe("failed");
  });
});

describe("trust-core anchor-evidence-v1", () => {
  const golden = trust.json<never>("anchor-evidence-v1/golden.json");
  const { bytes } = sealAnchorEvidence(golden);
  const pinned = trust.json<Record<string, string>>("anchor-evidence-v1/expected-digests.json");

  test("the golden record is a well-formed anchor", async () => {
    const report = await checkRecord(bytes, { digest: pinned["anchor-evidence-golden"]! });
    expect(report.kind).toBe("https://spec.jinn.network/records/anchor-evidence/v1");
    expect(statuses(report)).toEqual({
      digest: "passed",
      encoding: "passed",
      schema: "passed",
      signature: "skipped",
      "trust-binding": "skipped",
    });
    expect(check(report, "signature").findings[0]!.detail).toContain("sealed, not signed");
  });

  test("well-formed is not verified: its placeholder proof is invalid", () => {
    const { subject } = golden as { subject: { kind: string; digest: { sha256: string } } };
    const report = evaluateAnchors({
      records: [{ recordSha256: pinned["anchor-evidence-golden"]!.slice("sha256:".length), bytes }],
      subjects: [{ id: "run", sha256: subject.digest.sha256, kind: subject.kind }],
    });
    expect(report.anchors[0]).toMatchObject({ status: "invalid", subject: "run" });
    expect(report.subjects).toEqual([{ subject: "run", outcome: "absent" }]);
  });
});

describe("trust-core policy-chain-v1", () => {
  async function sealVersion(name: string, predecessor?: string) {
    const template = trust.json<TrustPolicy & { readonly signerSet: { readonly keys: readonly string[] } }>(`policy-chain-v1/${name}.json`);
    const signer: DsseSigner = async () => {
      const [first, ...rest] = template.signerSet.keys;
      return [
        { keyid: first!, signature: Uint8Array.of(1) },
        ...rest.map((keyid, index) => ({ keyid, signature: Uint8Array.of(index + 2) })),
      ];
    };
    return sealTrustPolicy({ ...template, ...(predecessor === undefined ? {} : { predecessor }) } as TrustPolicy, signer);
  }

  test("each version links to the one before by digest, and a missing link dangles", async () => {
    const genesis = await sealVersion("genesis");
    const v2 = await sealVersion("v2", genesis.recordDigest);
    const v3 = await sealVersion("v3", v2.recordDigest);
    const records = [genesis, v2, v3].map(({ envelopeBytes }) => ({ bytes: envelopeBytes }));

    const whole = await checkRecordSet({ records, roots: [v3.recordDigest] });
    expect(whole.summary.kinds).toEqual({ [RECORD_KINDS.trustPolicy]: 3 });
    expect(whole.checks[0]).toMatchObject({ status: "passed", reached: 3, resolved: 2, dangling: 0 });

    const broken = await checkRecordSet({ records: [records[0]!, records[2]!], roots: [v3.recordDigest] });
    expect(broken.checks[0]).toMatchObject({ status: "failed", dangling: 1 });
    expect(broken.checks[0].findings[0]).toMatchObject({ code: "dangling-reference", path: "/predecessor" });
  });

  test("a policy's envelope carries its own media type, not in-toto's", async () => {
    const { envelopeBytes } = await sealVersion("genesis");
    expect(JSON.parse(new TextDecoder().decode(envelopeBytes))).toMatchObject({ payloadType: TRUST_POLICY_MEDIA_TYPE });
  });
});

describe("task-execution golden-task-execution-v1", () => {
  const ROOT = "golden-task-execution-v1";
  const report = tasks.json<{
    taskDigest: string;
    scenarios: Record<string, { submissionDigest: string; attempt: string; deliveryDigest: string }>;
  }>(`${ROOT}/conformance-report.json`);

  function scenario(name: string): readonly RecordSetInputRecord[] {
    const expected = report.scenarios[name]!;
    const observations = tasks.json<readonly unknown[]>(`${ROOT}/${name}/observations.json`);
    return [
      { bytes: tasks.bytes(`${ROOT}/task.json`), digest: report.taskDigest },
      { bytes: tasks.bytes(`${ROOT}/${name}/submission.json`), digest: expected.submissionDigest },
      { bytes: tasks.bytes(`${ROOT}/${name}/delivery.json`), digest: expected.deliveryDigest },
      { bytes: tasks.bytes(`${ROOT}/artifacts/patch.diff`) },
      ...observations.map((event) => ({ bytes: new TextEncoder().encode(JSON.stringify(event)) })),
    ];
  }

  test.each(["local", "marketplace"])("the %s scenario checks clean and folds to delivered", async (name) => {
    const expected = report.scenarios[name]!;
    const records = scenario(name);
    const result = await checkRecordSet({ records, roots: [expected.deliveryDigest, expected.submissionDigest] });
    expect(result.summary).toMatchObject({
      recordsFailed: 0,
      kinds: {
        [RECORD_KINDS.task]: 1,
        [RECORD_KINDS.submission]: 1,
        [RECORD_KINDS.delivery]: 1,
        [OBSERVATION_KIND]: records.length - 4,
        unknown: 1,
      },
    });
    expect(result.records.slice(0, 3).map(({ checks }) => checks[0]!.status)).toEqual(["passed", "passed", "passed"]);
    expect(digestOf(result.records, RECORD_KINDS.task)).toEqual([report.taskDigest]);
    expect(result.checks[1]).toMatchObject({
      status: "passed",
      attempts: [{
        attempt: expected.attempt,
        state: "delivered",
        terminal: true,
        contradictory: false,
        deliveries: [expected.deliveryDigest],
      }],
      deliveriesWithoutObservations: 0,
    });
  });

  test.each(["local", "marketplace"])("the %s scenario does not carry its Task's profile document, and that is all it lacks", async (name) => {
    const expected = report.scenarios[name]!;
    const [references] = (await checkRecordSet({ records: scenario(name), roots: [expected.deliveryDigest] })).checks;
    expect(references).toMatchObject({ status: "failed", dangling: 1 });
    expect(references.findings.filter(({ code }) => code === "dangling-reference")).toEqual([
      expect.objectContaining({ path: "/profile/digest/sha256" }),
    ]);
  });

  test("two authors of one Task seal the same bytes", async () => {
    const { digest } = tasks.json<{ digest: string }>(`${ROOT}/equivalence/expected-digest.json`);
    for (const variant of ["a", "b"]) {
      // eslint-disable-next-line no-await-in-loop -- two small files.
      const report = await checkRecord(tasks.bytes(`${ROOT}/equivalence/task-${variant}.json`), { digest });
      expect(statuses(report)).toMatchObject({ digest: "passed", encoding: "passed", schema: "passed" });
    }
  });
});

describe("task-execution adversarial-v1", () => {
  const ROOT = "adversarial-v1";
  const manifest = tasks.json<{ fixtures: readonly { id: string; expectedDisposition: string }[] }>(`${ROOT}/manifest.json`);
  const disposition = (id: string) => manifest.fixtures.find((fixture) => fixture.id === id)!.expectedDisposition;

  function log(id: string, file = "observations.json"): readonly RecordSetInputRecord[] {
    return tasks.json<readonly unknown[]>(`${ROOT}/${id}/${file}`)
      .map((event) => ({ bytes: new TextEncoder().encode(JSON.stringify(event)) }));
  }

  test("digest-mismatch: the claimed digest is refused as content corruption", async () => {
    const { claimedDigest, actualDigest } = tasks.json<{ claimedDigest: string; actualDigest: string }>(`${ROOT}/digest-mismatch/claimed-digest.json`);
    const report = await checkRecord(tasks.bytes(`${ROOT}/digest-mismatch/document.json`), { digest: claimedDigest });
    expect(report.digest).toBe(actualDigest);
    expect(check(report, "digest").status).toBe("failed");
    expect(check(report, "digest").findings[0]!.code).toBe(disposition("digest-mismatch"));
  });

  test("malformed-document: a Task with no outputs is an invalid document", async () => {
    const report = await checkRecord(tasks.bytes(`${ROOT}/malformed-document/task.json`));
    expect(report.kind).toBe(RECORD_KINDS.task);
    expect(check(report, "schema").status).toBe("failed");
    expect(check(report, "schema").findings[0]).toMatchObject({ code: disposition("malformed-document"), path: "outputs" });
  });

  test("oversized-content: the observation's message is refused, and the inline content is not", async () => {
    expect(disposition("oversized-content")).toContain("the observation message IS rejected");
    expect(disposition("oversized-content")).toContain("the inline content is NOT rejected");
    const observation = await checkRecord(tasks.bytes(`${ROOT}/oversized-content/oversized-observation.json`));
    expect(observation.kind).toBe(OBSERVATION_KIND);
    expect(check(observation, "schema").status).toBe("failed");
    expect(check(observation, "schema").findings[0]).toMatchObject({ path: "data.message" });

    const descriptor = await checkRecord(tasks.bytes(`${ROOT}/oversized-content/resource-descriptor.json`));
    expect(descriptor).toMatchObject({ kind: "unknown", outcome: "unknown-kind" });
    expect(check(descriptor, "schema").status).toBe("skipped");
  });

  test("illegal-terminal-transition: the terminal state stays", async () => {
    const [, lifecycle] = (await checkRecordSet({ records: log("illegal-terminal-transition"), roots: [] })).checks;
    expect(lifecycle).toMatchObject({ attempts: [{ terminal: true, contradictory: false }] });
    expect(lifecycle.attempts[0]!.state).not.toBe("running");
  });

  test("replayed-and-out-of-order: duplicates drop and sequence decides", async () => {
    const [, lifecycle] = (await checkRecordSet({ records: log("replayed-and-out-of-order"), roots: [] })).checks;
    expect(lifecycle.status).toBe("passed");
  });

  test("contradictory-terminals: delivered, contradictory", async () => {
    const [, lifecycle] = (await checkRecordSet({ records: log("contradictory-terminals"), roots: [] })).checks;
    expect(lifecycle.status).toBe("failed");
    expect(lifecycle.attempts).toEqual([expect.objectContaining({ state: "delivered", contradictory: true })]);
  });

  test("lost-then-corrected: delivered, not contradictory", async () => {
    const [, lifecycle] = (await checkRecordSet({ records: log("lost-then-corrected"), roots: [] })).checks;
    expect(lifecycle.attempts).toEqual([expect.objectContaining({ state: "delivered", contradictory: false })]);
  });

  test("expired-then-late-terminal: the genuine terminal stands, with no contradiction", async () => {
    const [, lifecycle] = (await checkRecordSet({ records: log("expired-then-late-terminal", "log-with-terminal.json"), roots: [] })).checks;
    expect(lifecycle.attempts).toEqual([expect.objectContaining({ state: "delivered", contradictory: false })]);
  });

  test("forged-cross-attempt-supersedes: refused whenever both records are held", async () => {
    expect(disposition("forged-cross-attempt-supersedes")).toContain("invalid-document");
    const first = tasks.bytes(`${ROOT}/forged-cross-attempt-supersedes/delivery-a.json`);
    const forged = tasks.bytes(`${ROOT}/forged-cross-attempt-supersedes/delivery-b-forged-supersedes.json`);
    const [, lifecycle] = (await checkRecordSet({ records: [{ bytes: first }, { bytes: forged }], roots: [] })).checks;
    expect(lifecycle.status).toBe("failed");
    expect(lifecycle.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "supersedes-other-attempt", subject: recordDigest(forged) }),
    ]));
  });

  test("extension-override: invalid-document, because a validator can detect this one", async () => {
    expect(disposition("extension-override")).toContain("invalid-document");
    const sealed = canonicalJsonBytes(tasks.json(`${ROOT}/extension-override/task.json`));
    const report = await checkRecord(sealed);
    expect(check(report, "schema")).toMatchObject({
      status: "failed",
      findings: [{ code: "invalid-document", path: "x-jinn-example.test/protocolOverride" }],
    });
  });

  test("dispatch-context-grafting: a dispatch context names no type, and structure alone does not catch this", async () => {
    expect(disposition("dispatch-context-grafting")).toContain("NOT caught by structure alone");
    const report = await checkRecord(tasks.bytes(`${ROOT}/dispatch-context-grafting/grafted-dispatch-context.json`));
    expect(report).toMatchObject({ kind: "unknown", outcome: "unknown-kind" });
  });
});

describe("evidence golden-execution-evidence-v1", () => {
  const ROOT = "golden-execution-evidence-v1";
  const CLAIMS = ["result-evaluation", "execution-verification"] as const;

  function keyOf(claim: string) {
    const envelope = evidence.json<{ signatures: { keyid: string }[] }>(`${ROOT}/claims/${claim}/${claim}.dsse.json`);
    return {
      keyId: envelope.signatures[0]!.keyid,
      publicKey: createPublicKey(Buffer.from(evidence.bytes(`${ROOT}/claims/${claim}/public-key.pem`))),
    };
  }

  const held = evidence.ids
    .filter((id) => id.startsWith(`${ROOT}/`))
    .map((id) => ({ bytes: evidence.bytes(id), digest: recordDigest(evidence.bytes(id)) }));

  test("the execution record and its public derivative conform; neither is signed, and neither must be canonical", async () => {
    const report = evidence.json<{ executionEvidenceProfile: { sha256: string } }>(`${ROOT}/conformance-report.json`);
    const execution = await checkRecord(evidence.bytes(`${ROOT}/execution/ro-crate-metadata.json`), {
      digest: `sha256:${report.executionEvidenceProfile.sha256}`,
    });
    const derivative = await checkRecord(evidence.bytes(`${ROOT}/public/ro-crate-metadata.json`));
    for (const record of [execution, derivative]) {
      expect(record).toMatchObject({ kind: RECORD_KINDS.executionEvidence, family: "execution-evidence", outcome: "checked" });
      expect(check(record, "schema").status).toBe("passed");
      expect(check(record, "encoding")).toMatchObject({ status: "skipped", findings: [{ code: "encoding-not-required" }] });
      expect(check(record, "signature")).toMatchObject({ status: "skipped", findings: [{ code: "unsigned-record" }] });
    }
    expect(check(execution, "digest").status).toBe("passed");
  });

  test("the generic download crate is not a fourth record family", async () => {
    const report = await checkRecord(evidence.bytes(`${ROOT}/ro-crate-metadata.json`));
    expect(report).toMatchObject({ kind: "unknown", outcome: "unknown-kind" });
  });

  test.each(CLAIMS)("the %s claim verifies under the key its caller supplies, and only then", async (claim) => {
    const bytes = evidence.bytes(`${ROOT}/claims/${claim}/${claim}.dsse.json`);
    const key = keyOf(claim);
    const bare = await checkRecord(bytes);
    expect(check(bare, "schema").status).toBe("passed");
    expect(check(bare, "signature")).toMatchObject({ status: "skipped", findings: [{ code: "no-verification-key", subject: key.keyId }] });

    const keyed = await checkRecord(bytes, { trust: { keys: [key] } });
    expect(statuses(keyed)).toMatchObject({ encoding: "skipped", schema: "passed", signature: "passed" });
    expect(keyed.outcome).toBe("checked");
  });

  test.each(CLAIMS)("the %s claim fails when one payload byte changes", async (claim) => {
    const envelope = evidence.json<Record<string, unknown> & { payload: string }>(`${ROOT}/claims/${claim}/${claim}.dsse.json`);
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as { predicate: { limitations?: string[] } };
    payload.predicate.limitations = [...(payload.predicate.limitations ?? []), "tampered"];
    const tampered = new TextEncoder().encode(JSON.stringify({
      ...envelope,
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
    }));
    const report = await checkRecord(tampered, { trust: { keys: [keyOf(claim)] } });
    expect(check(report, "schema").status).toBe("passed");
    expect(check(report, "signature")).toMatchObject({ status: "failed", findings: [{ code: "signature-invalid" }] });
  });

  test("the whole fixture is a closed set: every claim and crate resolves to bytes it carries", async () => {
    const claims = CLAIMS.map((claim) => recordDigest(evidence.bytes(`${ROOT}/claims/${claim}/${claim}.dsse.json`)));
    const crates = ["execution", "public"].map((side) => recordDigest(evidence.bytes(`${ROOT}/${side}/ro-crate-metadata.json`)));
    const report = await checkRecordSet({
      records: held,
      roots: [...claims, ...crates],
      trust: { keys: CLAIMS.map(keyOf) },
    });
    expect(report.summary.kinds).toMatchObject({
      [RECORD_KINDS.executionEvidence]: 2,
      // Each claim's envelope, and the bare Statement beside it that §4 does not accept as a record.
      [RECORD_KINDS.resultEvaluation]: 2,
      [RECORD_KINDS.executionVerification]: 2,
    });
    expect(report.records.filter(({ outcome }) => outcome === "failed").map(({ digest }) => digest).sort()).toEqual(
      CLAIMS.map((claim) => recordDigest(evidence.bytes(`${ROOT}/claims/${claim}/statement.json`))).sort(),
    );
    expect(report.summary.checks.digest).toEqual({ passed: held.length, failed: 0, skipped: 0 });
    expect(report.checks[0]).toMatchObject({ status: "passed", dangling: 0 });
  });

  test("a verification whose crate is not held dangles; an evaluation's artifacts may be withheld", async () => {
    const verification = evidence.bytes(`${ROOT}/claims/execution-verification/execution-verification.dsse.json`);
    const evaluation = evidence.bytes(`${ROOT}/claims/result-evaluation/result-evaluation.dsse.json`);
    const [references] = (await checkRecordSet({
      records: [{ bytes: verification }, { bytes: evaluation }],
      roots: [recordDigest(verification), recordDigest(evaluation)],
    })).checks;
    expect(references).toMatchObject({ status: "failed", dangling: 1 });
    expect(references.findings[0]).toMatchObject({ subject: recordDigest(verification), path: "/subject/0/digest/sha256" });
    expect(references.unavailable).toBeGreaterThan(0);
  });
});

describe("the published prediction-forecast/1.0 profile", () => {
  test("fails the §6.4 check its own package applies, and the report says which pattern", async () => {
    const bytes = new Uint8Array(readFileSync(require.resolve(
      "@jinn-network/task-execution-profiles/profiles/task-profiles/prediction-forecast/1.0/profile.json",
    )));
    const report = await checkRecord(bytes);
    expect(check(report, "schema")).toMatchObject({
      status: "failed",
      findings: [{ code: "invalid-document", path: "payloadSchema", detail: expect.stringContaining("consensusProbabilityYes") }],
    });
  });
});

describe("evidence-offer offer", () => {
  test.each(["free", "priced", "superseding"])("the %s offer is a conforming signed record", async (name) => {
    const report = await checkRecord(offers.bytes(`offer/${name}.json`));
    expect(report).toMatchObject({ kind: "https://spec.jinn.network/records/offer/v1", outcome: "checked" });
    expect(statuses(report)).toMatchObject({ encoding: "passed", schema: "passed" });
  });

  test.each(offers.ids.filter((id) => /^offer\/invalid-.*\.json$/u.test(id)))("%s is refused", async (id) => {
    const report = await checkRecord(offers.bytes(id));
    expect(report.kind).toBe("https://spec.jinn.network/records/offer/v1");
    expect(check(report, "schema").status).toBe("failed");
  });
});
