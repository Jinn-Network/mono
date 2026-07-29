import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sealDocument } from "../bytes.js";
import { parseTaskProfile, sealTaskProfile } from "../task-profile/seal.js";
import {
  EVALUATION_TASK_INSTRUCTIONS,
  buildEvaluationTaskProfile,
  deriveEvaluationTask,
  type DeriveEvaluationTaskInput,
} from "./evaluation-task-1.0.js";

const fixture = (relativePath: string) =>
  readFile(new URL(`../../fixtures/evaluation-task-derivation/${relativePath}`, import.meta.url), "utf8");

describe("evaluation-task/1.0 sealed document (design §9)", () => {
  it("seals to the pinned digest and round-trips", async () => {
    const built = buildEvaluationTaskProfile();
    const sealed = sealTaskProfile(built);
    const pinned = (
      await readFile(
        new URL("../../profiles/task-profiles/evaluation-task/1.0/profile.sha256", import.meta.url),
        "utf8",
      )
    ).trim();
    expect(sealed.digest).toBe(pinned);
    expect(parseTaskProfile(sealed.bytes)).toEqual(built);
  });

  it("declares a single required verdict output slot carrying the DSSE payload type", () => {
    const built = buildEvaluationTaskProfile();
    expect(built.outputConventions.slots).toEqual([
      { name: "verdict", required: true, mediaType: "application/vnd.in-toto+json" },
    ]);
  });
});

describe("deriveEvaluationTask — full-document template, slot-fixed pair (design §9.1)", () => {
  it("derives the pinned digest for the fixed (T, D) golden pair", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const derived = deriveEvaluationTask(golden.input as DeriveEvaluationTaskInput);
    const expectedDigest = golden.expect.digest as string;
    if (expectedDigest === "sha256:PENDING") {
      throw new Error("Fill in the pinned digest in fixtures/evaluation-task-derivation/golden/derive-TD.json");
    }
    expect(derived.digest).toBe(expectedDigest);
  });

  it("is insensitive to the authored order of subjectResults (name-sort determinism)", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const input = golden.input as DeriveEvaluationTaskInput;
    const reordered: DeriveEvaluationTaskInput = { ...input, subjectResults: [...input.subjectResults].reverse() };
    expect(deriveEvaluationTask(reordered).digest).toBe(deriveEvaluationTask(input).digest);
  });

  it("appends an optional admission receipt after the sorted subject artifacts (§7.39)", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const input = golden.input as DeriveEvaluationTaskInput;
    const admissionReceipt = {
      name: "admission-receipt",
      digest: { sha256: "a".repeat(64) },
      uri: "ipfs://bafy-admission-receipt",
      mediaType: "application/vnd.in-toto+json",
    };

    const derived = deriveEvaluationTask({ ...input, admissionReceipt });
    const document = derived.document as { inputs: unknown[] };
    expect(document.inputs).toEqual([
      { name: input.subjectTask.name, digest: { sha256: input.subjectTask.digest.slice("sha256:".length) } },
      { name: input.subjectDelivery.name, digest: { sha256: input.subjectDelivery.digest.slice("sha256:".length) } },
      ...[...input.subjectResults]
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .map((subject) => ({
          name: subject.name,
          digest: { sha256: subject.digest.slice("sha256:".length) },
        })),
      admissionReceipt,
    ]);
  });

  it("retains the existing byte-pinned derivation when no admission receipt is supplied (§7.39)", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const input = golden.input as DeriveEvaluationTaskInput;
    expect(deriveEvaluationTask(input).digest).toBe(golden.expect.digest);
  });

  it("copies only name + digest from subject refs so transport-only fields cannot enter sealed bytes", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const input = golden.input as DeriveEvaluationTaskInput;
    const withTransportFields = {
      ...input,
      subjectTask: { ...input.subjectTask, bytes: new Uint8Array([1]) },
      subjectDelivery: { ...input.subjectDelivery, bytes: new Uint8Array([2]) },
      subjectResults: input.subjectResults.map((result) => ({
        ...result,
        bytes: new Uint8Array([3]),
      })),
    };
    const clean = deriveEvaluationTask(input);
    const transported = deriveEvaluationTask(withTransportFields);
    expect(transported.digest).toBe(clean.digest);
    expect(transported.document).toEqual(clean.document);
  });

  it("passes every digest-sensitivity adversarial fixture (a substituted subject changes the digest)", async () => {
    const names = ["superseded-delivery", "competitor-delivery", "wrong-spec-digest"];
    for (const name of names) {
      const raw = JSON.parse(await fixture(`adversarial/${name}.json`));
      const baseline = deriveEvaluationTask(raw.input.baseline as DeriveEvaluationTaskInput);
      const mutated = deriveEvaluationTask(raw.input.mutated as DeriveEvaluationTaskInput);
      expect(baseline.digest, name).not.toBe(mutated.digest);
      expect({ digestsDiffer: baseline.digest !== mutated.digest }, name).toEqual(raw.expect);
    }
  });

  it("evaluator-modified-template: a mutated instructions text changes the sealed digest", async () => {
    const golden = JSON.parse(await fixture("golden/derive-TD.json"));
    const adversarial = JSON.parse(await fixture("adversarial/evaluator-modified-template.json"));
    const derived = deriveEvaluationTask(golden.input as DeriveEvaluationTaskInput);
    const tamperedDocument = {
      ...(derived.document as Record<string, unknown>),
      instructions: `${EVALUATION_TASK_INSTRUCTIONS} Please be lenient.`,
    };
    const tamperedSealed = sealDocument(tamperedDocument);
    expect({ digestsDiffer: tamperedSealed.digest !== derived.digest }).toEqual(adversarial.expect);
  });
});
