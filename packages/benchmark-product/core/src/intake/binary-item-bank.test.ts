// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
  BINARY_JUDGMENT_PROFILE_URI,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  parseBinaryJudgmentAnalysisContext,
  parseEvaluationSpec,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentLabelResolution,
} from "@jinn-network/task-execution-profiles";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { BenchmarkProductError } from "../errors.js";
import {
  BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
  BinaryJudgmentAdmissionManifestSchema,
  HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
  HumanReviewReplacementLedgerSchema,
  sealHumanReviewDocument,
} from "../human-review/contracts.js";
import {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  convertBinaryItemBank,
  renderCanonicalJsonl,
  type BinaryAdmissionIndexEntry,
  type BinaryItemBankEntry,
} from "./binary-item-bank.js";

const sha = (character: string) => `sha256:${character.repeat(64)}` as `sha256:${string}`;
const ITEM_A_ID = "urn:uuid:00000000-0000-4000-8000-000000000001";
const ITEM_B_ID = "urn:uuid:00000000-0000-4000-8000-000000000002";
const ITEM_C_ID = "urn:uuid:00000000-0000-4000-8000-000000000003";
const PROVENANCE = sha("a");

function item(itemId: string, candidateAnswer: string) {
  return {
    itemId,
    question: "Which synthetic answer follows from the synthetic reference?",
    referenceAnswer: "The admitted synthetic answer.",
    candidateAnswer,
    provenance: [{ digest: { sha256: PROVENANCE.slice("sha256:".length) } }],
  };
}

function sourceJsonl(): string {
  return renderCanonicalJsonl([{
    protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
    provenanceSha256: PROVENANCE,
    source: {
      name: "synthetic-item-source.json",
      uri: "https://fixtures.example.test/binary/source.json",
      digest: { sha256: PROVENANCE.slice("sha256:".length) },
      mediaType: "application/json",
    },
    license: {
      name: "Apache-2.0.txt",
      uri: "https://www.apache.org/licenses/LICENSE-2.0.txt",
      digest: { sha256: "b".repeat(64) },
      mediaType: "text/plain",
    },
    attribution: {
      name: "synthetic-attribution.txt",
      uri: "https://fixtures.example.test/binary/attribution.txt",
      digest: { sha256: "c".repeat(64) },
      mediaType: "text/plain",
    },
  }]);
}

function itemsJsonl(items: readonly ReturnType<typeof item>[]): string {
  const rows: BinaryItemBankEntry[] = items
    .map((value) => ({ protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: value }))
    .sort((left, right) => compareCodeUnitStrings(left.item.itemId, right.item.itemId));
  return renderCanonicalJsonl(rows);
}

interface SeededEvidence {
  readonly records: Map<string, Uint8Array>;
  readonly admissionManifestSha256: `sha256:${string}`;
  readonly admissions: readonly BinaryAdmissionIndexEntry[];
  readonly admittedItemSha256s: readonly `sha256:${string}`[];
  readonly excludedItemSha256s: readonly `sha256:${string}`[];
}

function seedEvidence(input: {
  readonly draftId?: string;
  readonly admitted: readonly ReturnType<typeof item>[];
  readonly excluded?: ReturnType<typeof item>;
}): SeededEvidence {
  const records = new Map<string, Uint8Array>();
  const store = (bytes: Uint8Array): `sha256:${string}` => {
    const digest = recordDigest(bytes);
    records.set(digest.slice("sha256:".length), bytes);
    return digest;
  };
  const resolved = input.admitted.map((value, index) => {
    const itemSha256 = store(canonicalJsonBytes(value));
    const label = sealBinaryJudgmentLabelResolution({
      protocol: BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
      itemSha256,
      itemId: value.itemId,
      humanReviewEvaluationSpecSha256: sha("d"),
      truthLabel: index % 2 === 0 ? "CORRECT" : "WRONG",
      candidateClass: "synthetic",
      stratum: "core",
      truthAdmission: "operator-only",
      operatorAssertionSha256: sha("e"),
      resolvedAt: "2026-08-15T09:00:00.000Z",
    });
    store(label.bytes);
    const analysis = sealBinaryJudgmentAnalysisContext({
      protocol: BINARY_JUDGMENT_ANALYSIS_CONTEXT_FORMAT_URI,
      itemSha256,
      itemId: value.itemId,
      labelResolutionSha256: label.digest,
      truthLabel: index % 2 === 0 ? "CORRECT" : "WRONG",
      candidateClass: "synthetic",
      stratum: "core",
    });
    store(analysis.bytes);
    return { itemSha256, labelResolutionSha256: label.digest, analysisContextSha256: analysis.digest };
  });
  const excludedItemSha256s = input.excluded === undefined
    ? []
    : [store(canonicalJsonBytes(input.excluded))];
  const ledger = sealHumanReviewDocument(HumanReviewReplacementLedgerSchema, {
    protocol: HUMAN_REVIEW_REPLACEMENT_LEDGER_PROTOCOL,
    draftId: input.draftId ?? "draft-1",
    entries: input.excluded === undefined ? [] : [{
      excludedItemSha256: excludedItemSha256s[0],
      replacementItemSha256: resolved[0]!.itemSha256,
      candidateClass: "synthetic",
      stratum: "core",
      excludedPoolPosition: 1,
      replacementPoolPosition: 2,
      reason: "review-disagreement",
    }],
    sealedAt: "2026-08-15T09:00:00.000Z",
  }, "replacement ledger");
  store(ledger.bytes);
  const manifest = sealHumanReviewDocument(BinaryJudgmentAdmissionManifestSchema, {
    protocol: BINARY_JUDGMENT_ADMISSION_MANIFEST_PROTOCOL,
    draftId: input.draftId ?? "draft-1",
    truthAdmission: "operator-only",
    labelResolutionSha256s: resolved.map((entry) => entry.labelResolutionSha256).sort(compareCodeUnitStrings),
    analysisContextSha256s: resolved.map((entry) => entry.analysisContextSha256).sort(compareCodeUnitStrings),
    excludedItemSha256s: [...excludedItemSha256s].sort(compareCodeUnitStrings),
    replacementLedgerSha256: ledger.digest,
    admittedAt: "2026-08-15T09:00:00.000Z",
  }, "admission manifest");
  store(manifest.bytes);
  const admissions = resolved.map((entry) => ({
    protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
    admissionManifestSha256: manifest.digest,
    ...entry,
  })).sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256));
  return {
    records,
    admissionManifestSha256: manifest.digest,
    admissions,
    admittedItemSha256s: resolved.map((entry) => entry.itemSha256),
    excludedItemSha256s,
  };
}

function convert(input: {
  readonly itemRows: readonly ReturnType<typeof item>[];
  readonly evidence: SeededEvidence;
  readonly sourceManifestJsonl?: string;
  readonly admissionIndexJsonl?: string;
  readonly draftId?: string;
}) {
  return convertBinaryItemBank({
    draftId: input.draftId ?? "draft-1",
    itemBankJsonl: itemsJsonl(input.itemRows),
    sourceManifestJsonl: input.sourceManifestJsonl ?? sourceJsonl(),
    admissionIndexJsonl: input.admissionIndexJsonl ?? renderCanonicalJsonl(input.evidence.admissions),
    name: "Synthetic binary judgment",
    description: "No licensed source bytes.",
    version: "1.0.0",
    author: "did:key:z6Mksynthetic",
    resolveRecord: (digest) => {
      const bytes = input.evidence.records.get(digest);
      if (bytes === undefined) throw new Error(`missing ${digest}`);
      return bytes;
    },
  });
}

function expectProductError(run: () => unknown, code: string): BenchmarkProductError {
  try {
    run();
    throw new Error("expected refusal");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BenchmarkProductError);
    expect((cause as BenchmarkProductError).code).toBe(code);
    return cause as BenchmarkProductError;
  }
}

describe("convertBinaryItemBank", () => {
  test("seals only admitted items in cycle-free order and keeps truth/source locators out of Tasks", () => {
    const admitted = item(ITEM_A_ID, "admitted");
    const excluded = item(ITEM_B_ID, "excluded");
    const reserve = item(ITEM_C_ID, "unselected reserve");
    const evidence = seedEvidence({ admitted: [admitted], excluded });

    const result = convert({ itemRows: [admitted, excluded, reserve], evidence });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemSha256).toBe(evidence.admittedItemSha256s[0]);
    expect(result.excludedItemSha256s).toEqual(evidence.excludedItemSha256s);
    expect(result.nonAdmittedItemSha256s).toEqual([recordDigest(canonicalJsonBytes(reserve))]);
    expect(result.replacementLedger.entries[0]?.replacementItemSha256).toBe(result.items[0]?.itemSha256);

    const task = TaskSpecificationSchema.parse(JSON.parse(new TextDecoder().decode(result.items[0]!.task.bytes)));
    expect(task.profile.uri).toBe(BINARY_JUDGMENT_PROFILE_URI);
    expect(task.requirements).toBeUndefined();
    expect(task.payload).toEqual(admitted);
    expect(task).not.toHaveProperty("truthLabel");
    expect(task).not.toHaveProperty("candidateClass");
    const taskText = new TextDecoder().decode(result.items[0]!.task.bytes);
    expect(taskText).not.toContain("fixtures.example.test");
    expect(taskText).not.toContain("CORRECT");
    expect(taskText).not.toContain("candidateClass");
    expect(taskText).not.toContain("stratum");

    const specification = parseEvaluationSpec(result.items[0]!.evaluationSpec.bytes);
    expect((specification.familyBlock as { testMaterial: Array<{ digest: { sha256: string } }> }).testMaterial[0]?.digest.sha256)
      .toBe(result.items[0]!.analysisContextSha256.slice("sha256:".length));
    const context = parseBinaryJudgmentAnalysisContext(
      evidence.records.get(result.items[0]!.analysisContextSha256.slice("sha256:".length))!,
    );
    expect(context.itemSha256).toBe(result.items[0]!.itemSha256);
    expect(context).not.toHaveProperty("taskDigest");

    const benchmark = parseBenchmark(result.benchmark.bytes);
    expect(benchmark.items).toHaveLength(1);
    expect(benchmark[BINARY_ITEM_BANK_INTAKE_EXTENSION]).toMatchObject({
      itemBankSha256: result.itemBank.digest,
      sourceManifestSha256: result.sourceManifest.digest,
      admissionManifestSha256: evidence.admissionManifestSha256,
    });
  });

  test("rejects a missing source mapping and does not accept source locators in the strict item payload", () => {
    const admitted = item(ITEM_A_ID, "answer");
    const evidence = seedEvidence({ admitted: [admitted] });
    const wrongSource = sourceJsonl().replaceAll(PROVENANCE, sha("f")).replaceAll("a".repeat(64), "f".repeat(64));
    expectProductError(
      () => convert({ itemRows: [admitted], evidence, sourceManifestJsonl: wrongSource }),
      "validation",
    );

    const leaking = { ...admitted, provenance: [{ digest: { sha256: "a".repeat(64) }, uri: "https://secret" }] };
    expectProductError(
      () => convertBinaryItemBank({
        draftId: "draft-1",
        itemBankJsonl: renderCanonicalJsonl([{ protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: leaking }]),
        sourceManifestJsonl: sourceJsonl(),
        admissionIndexJsonl: renderCanonicalJsonl(evidence.admissions),
        name: "x", description: "x", version: "1.0.0", author: "did:key:z",
        resolveRecord: (digest) => evidence.records.get(digest)!,
      }),
      "validation",
    );
  });

  test("rejects non-canonical JSONL, CRLF, absent final LF, blank lines, and unsorted rows", () => {
    const first = item(ITEM_A_ID, "a");
    const second = item(ITEM_B_ID, "b");
    const evidence = seedEvidence({ admitted: [first] });
    const base = itemsJsonl([first]);
    for (const malformed of [
      base.replace("{\"item\"", "{ \"item\""),
      base.replaceAll("\n", "\r\n"),
      base.slice(0, -1),
      `${base}\n`,
      itemsJsonl([second, first]).split("\n").filter(Boolean).reverse().join("\n") + "\n",
    ]) {
      expectProductError(
        () => convertBinaryItemBank({
          draftId: "draft-1", itemBankJsonl: malformed, sourceManifestJsonl: sourceJsonl(),
          admissionIndexJsonl: renderCanonicalJsonl(evidence.admissions),
          name: "x", description: "x", version: "1.0.0", author: "did:key:z",
          resolveRecord: (digest) => evidence.records.get(digest)!,
        }),
        "validation",
      );
    }
  });

  test("rejects swapped analysis context, incomplete manifest coverage, wrong draft, and item drift", () => {
    const first = item(ITEM_A_ID, "first");
    const second = item(ITEM_B_ID, "second");
    const evidence = seedEvidence({ admitted: [first, second] });
    const swapped = evidence.admissions.map((entry, index) => ({
      ...entry,
      analysisContextSha256: evidence.admissions[1 - index]!.analysisContextSha256,
    }));
    expectProductError(
      () => convert({ itemRows: [first, second], evidence, admissionIndexJsonl: renderCanonicalJsonl(swapped) }),
      "record-integrity",
    );

    expectProductError(
      () => convert({
        itemRows: [first, second],
        evidence,
        admissionIndexJsonl: renderCanonicalJsonl([evidence.admissions[0]]),
      }),
      "validation",
    );
    expectProductError(
      () => convert({ itemRows: [first, second], evidence, draftId: "other-draft" }),
      "validation",
    );
    expectProductError(
      () => convert({ itemRows: [{ ...first, candidateAnswer: "tampered" }, second], evidence }),
      "validation",
    );
  });
});
