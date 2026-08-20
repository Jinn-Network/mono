// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import {
  BINARY_JUDGMENT_PROFILE_URI,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  parseBinaryJudgmentAnalysisContext,
  parseEvaluationSpec,
  recordDigest,
} from "@jinn-network/task-execution-profiles";
import {
  isBinaryJudgmentEvaluationSpecification,
} from "@jinn-network/task-execution-evaluator-adapters";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { BenchmarkProductError } from "../errors.js";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED } from "../human-review/application.js";
import { buildBinaryJudgmentAdmissionClosureWorkspacePorts } from "../human-review/verification-workspace.js";
import { admitHumanTruth } from "../operations/human-review.js";
import { createDraft } from "../operations/drafts.js";
import { initWorkspace } from "../operations/init.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
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
const digest = (value: string) => value as `sha256:${string}`;
const ITEM_A_ID = "urn:uuid:00000000-0000-4000-8000-000000000001";
const ITEM_B_ID = "urn:uuid:00000000-0000-4000-8000-000000000002";
const ITEM_C_ID = "urn:uuid:00000000-0000-4000-8000-000000000003";
const ITEM_D_ID = "urn:uuid:00000000-0000-4000-8000-000000000004";
const PROVENANCE = sha("a");
const PUBLISHED_AT = "2026-03-09T00:00:00Z";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function item(itemId: string, candidateAnswer: string) {
  return {
    itemId,
    question: "Which synthetic answer follows from the synthetic reference?",
    referenceAnswer: "The admitted synthetic answer.",
    candidateAnswer,
    provenance: { sourceCommitment: PROVENANCE, timestamp: PUBLISHED_AT },
    sources: [{ digest: { sha256: PROVENANCE.slice("sha256:".length) } }],
  };
}

function sourceRow(character: string, publishedAt: string) {
  const provenanceSha256 = sha(character);
  return {
    protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
    provenanceSha256,
    source: {
      name: "synthetic-item-source.json",
      uri: `https://fixtures.example.test/binary/source-${character}.json`,
      digest: { sha256: provenanceSha256.slice("sha256:".length) },
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
    publishedAt,
  };
}

function sourceJsonl(): string {
  return renderCanonicalJsonl([sourceRow("a", PUBLISHED_AT)]);
}

function itemsJsonl(items: readonly ReturnType<typeof item>[]): string {
  const rows: BinaryItemBankEntry[] = items
    .map((value) => ({ protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: value }))
    .sort((left, right) => compareCodeUnitStrings(left.item.itemId, right.item.itemId));
  return renderCanonicalJsonl(rows);
}

interface SeededEvidence {
  readonly workspaceDir: string;
  readonly admissionVerificationPorts: ReturnType<typeof buildBinaryJudgmentAdmissionClosureWorkspacePorts>;
  readonly admissionManifestSha256: `sha256:${string}`;
  readonly admissions: readonly BinaryAdmissionIndexEntry[];
  readonly admittedItemSha256s: readonly `sha256:${string}`[];
}

function seedEvidence(input: {
  readonly draftId?: string;
  readonly admitted: readonly ReturnType<typeof item>[];
  /** One stratum per admitted item, in order. Defaults to "core" for every item (today's shape,
   * spec §10.2 ruling 3). */
  readonly strata?: readonly string[];
}): SeededEvidence {
  const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-item-intake-"));
  roots.push(workspaceDir);
  const draftId = input.draftId ?? "draft-1";
  const context = {
    workspaceDir,
    principal: "operator",
    clock: () => "2026-08-15T09:00:00.000Z",
  };
  expect(initWorkspace(context).ok).toBe(true);
  expect(createDraft(context, { draftId, name: "Synthetic intake" }).ok).toBe(true);
  const strata = input.strata ?? input.admitted.map(() => "core");
  const candidates = input.admitted.map((value, index) => {
    const itemSha256 = recordDigest(canonicalJsonBytes(value));
    putSealedBytes(workspaceDir, canonicalJsonBytes(value));
    return {
      itemSha256,
      itemId: value.itemId,
      humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
      candidateClass: "synthetic",
      stratum: strata[index] ?? "core",
      poolPosition: index + 1,
      operatorTruthLabel: index % 2 === 0 ? "CORRECT" as const : "WRONG" as const,
    };
  });
  const admitted = admitHumanTruth(context, {
    draftId,
    truthAdmission: "operator-only",
    candidates,
  });
  if (!admitted.ok) throw new Error(JSON.stringify(admitted));
  const admissions = admitted.result.resolutions.map((entry) => ({
    protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
    admissionManifestSha256: digest(admitted.result.admissionManifestSha256),
    itemSha256: digest(entry.itemSha256),
    labelResolutionSha256: digest(entry.labelResolutionSha256),
    analysisContextSha256: digest(entry.analysisContextSha256),
  })).sort((left, right) => compareCodeUnitStrings(left.itemSha256, right.itemSha256));
  return {
    workspaceDir,
    admissionVerificationPorts: buildBinaryJudgmentAdmissionClosureWorkspacePorts(workspaceDir),
    admissionManifestSha256: digest(admitted.result.admissionManifestSha256),
    admissions,
    admittedItemSha256s: admitted.result.resolutions.map((entry) => digest(entry.itemSha256)),
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
    admissionVerificationPorts: input.evidence.admissionVerificationPorts,
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
    const reserve = item(ITEM_C_ID, "unselected reserve");
    const evidence = seedEvidence({ admitted: [admitted] });

    const result = convert({ itemRows: [admitted, reserve], evidence });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.itemSha256).toBe(evidence.admittedItemSha256s[0]);
    expect(result.excludedItemSha256s).toEqual([]);
    expect(result.nonAdmittedItemSha256s).toEqual([recordDigest(canonicalJsonBytes(reserve))]);
    expect(result.replacementLedger.entries).toEqual([]);
    expect(result.publicationGrade).toBe(false);
    expect(result.candidateClasses).toEqual(["synthetic"]);
    expect(result.strata).toEqual(["core"]);

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
    expect(isBinaryJudgmentEvaluationSpecification(specification)).toBe(true);
    expect((specification.familyBlock as { testMaterial: Array<{ digest: { sha256: string } }> }).testMaterial[0]?.digest.sha256)
      .toBe(result.items[0]!.analysisContextSha256.slice("sha256:".length));
    const context = parseBinaryJudgmentAnalysisContext(
      evidence.admissionVerificationPorts.resolveExactRecord(result.items[0]!.analysisContextSha256),
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

  // Spec §3.1 sites 18/19: the declared vocabulary is the observed set, not a registered pair.
  test("imports a four-category bank, carrying all four declared strata in the summary", () => {
    const items = [ITEM_A_ID, ITEM_B_ID, ITEM_C_ID, ITEM_D_ID].map((id, index) => item(id, `answer-${index}`));
    const strata = ["category-1", "category-2", "category-3", "category-4"];
    const evidence = seedEvidence({ admitted: items, strata });

    const result = convert({ itemRows: items, evidence });

    expect(result.items).toHaveLength(4);
    expect(result.strata).toEqual(strata);
  });

  // Spec §3.2: the import path checks grammar only -- there is no declared list to check
  // membership against at import time, because the list is the observed set. Calls
  // `admitHumanTruth` directly (rather than through `seedEvidence`, which throws on refusal)
  // so the assertion is against the typed result, not a substring of a serialized envelope.
  test("refuses a non-grammar-conforming stratum at admission with a validation refusal", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-item-intake-"));
    roots.push(workspaceDir);
    const draftId = "draft-1";
    const context = {
      workspaceDir,
      principal: "operator",
      clock: () => "2026-08-15T09:00:00.000Z",
    };
    expect(initWorkspace(context).ok).toBe(true);
    expect(createDraft(context, { draftId, name: "Synthetic intake" }).ok).toBe(true);
    const admitted = item(ITEM_A_ID, "answer");
    const itemSha256 = recordDigest(canonicalJsonBytes(admitted));
    putSealedBytes(workspaceDir, canonicalJsonBytes(admitted));
    const result = admitHumanTruth(context, {
      draftId,
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256,
        itemId: admitted.itemId,
        humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
        candidateClass: "synthetic",
        stratum: "1bad",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT" as const,
      }],
    });
    expect(result).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  test("rejects a missing source mapping and does not accept source locators in the strict item payload", () => {
    const admitted = item(ITEM_A_ID, "answer");
    const evidence = seedEvidence({ admitted: [admitted] });
    const wrongSource = sourceJsonl().replaceAll(PROVENANCE, sha("f")).replaceAll("a".repeat(64), "f".repeat(64));
    expectProductError(
      () => convert({ itemRows: [admitted], evidence, sourceManifestJsonl: wrongSource }),
      "validation",
    );

    const leaking = { ...admitted, sources: [{ digest: { sha256: "a".repeat(64) }, uri: "https://secret" }] };
    expectProductError(
      () => convertBinaryItemBank({
        draftId: "draft-1",
        itemBankJsonl: renderCanonicalJsonl([{ protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: leaking }]),
        sourceManifestJsonl: sourceJsonl(),
        admissionIndexJsonl: renderCanonicalJsonl(evidence.admissions),
        name: "x", description: "x", version: "1.0.0", author: "did:key:z",
        admissionVerificationPorts: evidence.admissionVerificationPorts,
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
          admissionVerificationPorts: evidence.admissionVerificationPorts,
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
      "record-integrity",
    );
    expectProductError(
      () => convert({ itemRows: [{ ...first, candidateAnswer: "tampered" }, second], evidence }),
      "validation",
    );
  });

  test("rejects a structurally valid closure when its authority signature is not trusted", () => {
    const admitted = item(ITEM_A_ID, "signed but untrusted");
    const evidence = seedEvidence({ admitted: [admitted] });
    expectProductError(
      () => convertBinaryItemBank({
        draftId: "draft-1",
        itemBankJsonl: itemsJsonl([admitted]),
        sourceManifestJsonl: sourceJsonl(),
        admissionIndexJsonl: renderCanonicalJsonl(evidence.admissions),
        name: "x",
        description: "x",
        version: "1.0.0",
        author: "did:key:z",
        admissionVerificationPorts: {
          ...evidence.admissionVerificationPorts,
          verifyAuthoritySignature: () => false,
        },
      }),
      "record-integrity",
    );
  });
});

describe("convertBinaryItemBank — evidence uniformity, anti-truth-channel, and provenance verification (§2.4)", () => {
  test("rejects a source-digest sources entry with no matching source row", () => {
    const admitted = item(ITEM_A_ID, "answer");
    const evidence = seedEvidence({ admitted: [admitted] });
    const unmapped = { ...admitted, sources: [{ digest: { sha256: "f".repeat(64) } }] };
    const error = expectProductError(
      () => convert({ itemRows: [unmapped], evidence }),
      "validation",
    );
    expect(error.issues).toEqual([{
      path: "items.1.item.sources",
      message: `no source row maps ${sha("f")}`,
    }]);
  });

  test("rejects a source row that no item's sources reference as unused", () => {
    const admitted = item(ITEM_A_ID, "answer");
    const evidence = seedEvidence({ admitted: [admitted] });
    const error = expectProductError(
      () => convert({
        itemRows: [admitted],
        evidence,
        sourceManifestJsonl: renderCanonicalJsonl([sourceRow("a", PUBLISHED_AT), sourceRow("d", "2026-04-01T00:00:00Z")]),
      }),
      "validation",
    );
    expect(error.issues).toEqual([{ path: "sources", message: `unused source row ${sha("d")}` }]);
  });

  test("refuses a bank mixing evidence-carrying and evidence-free items", () => {
    const withEvidence = { ...item(ITEM_A_ID, "answer one"), evidence: "Direct synthetic check one." };
    const withoutEvidence = item(ITEM_B_ID, "answer two");
    const evidence = seedEvidence({ admitted: [withEvidence] });
    const error = expectProductError(
      () => convert({ itemRows: [withEvidence, withoutEvidence], evidence }),
      "validation",
    );
    expect(error.issues).toEqual([{
      path: "items",
      message: "evidence must be present on every item or on none",
    }]);
  });

  test("imports cleanly when every item in the bank carries evidence", () => {
    // Distinct questions, so the anti-truth-channel invariant is not what this case exercises.
    const first = {
      ...item(ITEM_A_ID, "answer one"),
      question: "Which synthetic answer follows from the first synthetic reference?",
      evidence: "Direct synthetic check one.",
    };
    const second = {
      ...item(ITEM_B_ID, "answer two"),
      question: "Which synthetic answer follows from the second synthetic reference?",
      evidence: "Direct synthetic check two.",
    };
    const evidence = seedEvidence({ admitted: [first, second] });
    const result = convert({ itemRows: [first, second], evidence });
    expect(result.items).toHaveLength(2);
    expect(result.items.map((entry) => entry.itemId).sort()).toEqual([ITEM_A_ID, ITEM_B_ID]);
  });

  test("refuses two items sharing question bytes but carrying different evidence", () => {
    const question = "Shared synthetic question across two colliding items?";
    const first = { ...item(ITEM_A_ID, "answer one"), question, evidence: "Evidence A." };
    const second = { ...item(ITEM_B_ID, "answer two"), question, evidence: "Evidence B." };
    const evidence = seedEvidence({ admitted: [first] });
    const error = expectProductError(
      () => convert({ itemRows: [first, second], evidence }),
      "validation",
    );
    expect(error.issues).toEqual([{
      path: "items.2.item.evidence",
      message: "items sharing a question must carry identical evidence",
    }]);
  });

  test("imports cleanly when two items sharing question bytes carry identical evidence", () => {
    const question = "Shared synthetic question across two agreeing items?";
    const first = { ...item(ITEM_A_ID, "answer one"), question, evidence: "Same synthetic evidence." };
    const second = { ...item(ITEM_B_ID, "answer two"), question, evidence: "Same synthetic evidence." };
    const evidence = seedEvidence({ admitted: [first, second] });
    const result = convert({ itemRows: [first, second], evidence });
    expect(result.items).toHaveLength(2);
  });

  test("refuses a sourceCommitment that is not the code-unit-least digest among the item's sources", () => {
    const wrongItem = {
      itemId: ITEM_A_ID,
      question: "Which synthetic answer follows from the two-source reference?",
      referenceAnswer: "The admitted synthetic answer.",
      candidateAnswer: "answer",
      // "f" sorts after "a"; the least digest is PROVENANCE ("a"), so naming "f" here is wrong.
      provenance: { sourceCommitment: sha("f"), timestamp: "2026-05-20T00:00:00Z" },
      sources: [
        { digest: { sha256: PROVENANCE.slice("sha256:".length) } },
        { digest: { sha256: "f".repeat(64) } },
      ],
    };
    const evidence = seedEvidence({ admitted: [item(ITEM_C_ID, "unrelated")] });
    const error = expectProductError(
      () => convert({
        itemRows: [wrongItem],
        evidence,
        sourceManifestJsonl: renderCanonicalJsonl([sourceRow("a", PUBLISHED_AT), sourceRow("f", "2026-05-20T00:00:00Z")]),
      }),
      "validation",
    );
    expect(error.issues).toEqual([{
      path: "items.1.item.provenance.sourceCommitment",
      message: "sourceCommitment must be the code-unit-least digest in the item's sources",
    }]);
  });

  test("refuses a timestamp that disagrees with the named source row's publishedAt", () => {
    const wrongTimestamp = {
      ...item(ITEM_A_ID, "answer"),
      provenance: { sourceCommitment: PROVENANCE, timestamp: "2099-01-01T00:00:00Z" },
    };
    const evidence = seedEvidence({ admitted: [item(ITEM_C_ID, "unrelated")] });
    const error = expectProductError(
      () => convert({ itemRows: [wrongTimestamp], evidence }),
      "validation",
    );
    expect(error.issues).toEqual([{
      path: "items.1.item.provenance.timestamp",
      message: "timestamp must equal the publishedAt of the source row named by sourceCommitment",
    }]);
  });
});
