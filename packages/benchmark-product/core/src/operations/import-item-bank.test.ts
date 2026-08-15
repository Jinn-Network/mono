// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  canonicalJsonBytes,
  recordDigest,
} from "@jinn-network/task-execution-profiles";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import { readAuditEntries } from "../audit/journal.js";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED } from "../human-review/application.js";
import {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  renderCanonicalJsonl,
} from "../intake/binary-item-bank.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { createDraft } from "./drafts.js";
import {
  admitHumanTruth,
  createHumanReviewPackets,
  signHumanReviewResponse,
} from "./human-review.js";
import { importBinaryItemBank } from "./import-item-bank.js";
import { initWorkspace } from "./init.js";

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function setup(): { context: OperationContext; draftId: string; setClock: (value: string) => void } {
  const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-binary-import-"));
  workspaces.push(workspaceDir);
  let now = "2026-08-15T10:00:00.000Z";
  const context: OperationContext = {
    workspaceDir,
    principal: "sponsor-1",
    clock: () => now,
  };
  expect(initWorkspace(context).ok).toBe(true);
  const created = createDraft(context, { draftId: "binary-draft", name: "Binary intake" });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return {
    context,
    draftId: created.result.draft.draftId,
    setClock: (value) => { now = value; },
  };
}

async function reviewItem(
  context: OperationContext,
  draftId: string,
  item: {
    readonly itemId: string;
    readonly question: string;
    readonly referenceAnswer: string;
    readonly candidateAnswer: string;
    readonly provenance: readonly [{ readonly digest: { readonly sha256: string } }];
  },
  labels: readonly ["CORRECT" | "WRONG", "CORRECT" | "WRONG"],
) {
  const reviewers = ["urn:jinn:reviewer:a", "urn:jinn:reviewer:b"] as const;
  const packets = createHumanReviewPackets(context, {
    draftId,
    item,
    evaluatorIds: reviewers,
  });
  if (!packets.ok) throw new Error(JSON.stringify(packets));
  const verdicts = await Promise.all(packets.result.packets.map((packet, index) =>
    signHumanReviewResponse(context, {
      draftId,
      configuredEvaluatorIds: reviewers,
      activeEvaluatorId: packet.reviewerId,
      packetSha256: packet.packetSha256,
      visibilityReceiptSha256: packet.visibilityReceiptSha256,
      label: labels[index]!,
      complete: true,
      completedAt: `2026-08-15T10:0${index + 1}:00.000Z`,
    })));
  if (!verdicts[0]?.ok || !verdicts[1]?.ok) throw new Error(JSON.stringify(verdicts));
  return {
    packets: packets.result,
    verdictSha256s: [
      verdicts[0].result.verdictSha256,
      verdicts[1].result.verdictSha256,
    ] as const,
  };
}

describe("importBinaryItemBank", () => {
  test("composes F2 admission into ordinary stored Task/EvaluationSpec/Benchmark records", () => {
    const { context, draftId } = setup();
    const provenanceSha256 = `sha256:${"a".repeat(64)}` as const;
    const admittedItem = {
      itemId: "urn:uuid:10000000-0000-4000-8000-000000000001",
      question: "Synthetic question?",
      referenceAnswer: "Synthetic reference.",
      candidateAnswer: "Synthetic candidate.",
      provenance: [{ digest: { sha256: provenanceSha256.slice("sha256:".length) } }],
    };
    const heldBackItem = {
      ...admittedItem,
      itemId: "urn:uuid:10000000-0000-4000-8000-000000000002",
      candidateAnswer: "Held-back reserve.",
    };
    const admittedItemBytes = canonicalJsonBytes(admittedItem);
    const admittedItemSha256 = recordDigest(admittedItemBytes);
    putSealedBytes(context.workspaceDir, admittedItemBytes);

    const admitted = admitHumanTruth(context, {
      draftId,
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256: admittedItemSha256,
        itemId: admittedItem.itemId,
        humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
        candidateClass: "synthetic",
        stratum: "core",
        poolPosition: 1,
        operatorTruthLabel: "CORRECT",
      }],
    });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");

    const items = renderCanonicalJsonl([
      { protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: admittedItem },
      { protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: heldBackItem },
    ]);
    const sources = renderCanonicalJsonl([{
      protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
      provenanceSha256,
      source: {
        uri: "https://fixtures.example.test/source.json",
        digest: { sha256: provenanceSha256.slice("sha256:".length) },
      },
      license: {
        uri: "https://www.apache.org/licenses/LICENSE-2.0.txt",
        digest: { sha256: "b".repeat(64) },
      },
      attribution: {
        uri: "https://fixtures.example.test/attribution.txt",
        digest: { sha256: "c".repeat(64) },
      },
    }]);
    const admissions = renderCanonicalJsonl(admitted.result.resolutions.map((resolution) => ({
      protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
      admissionManifestSha256: admitted.result.admissionManifestSha256,
      itemSha256: resolution.itemSha256,
      labelResolutionSha256: resolution.labelResolutionSha256,
      analysisContextSha256: resolution.analysisContextSha256,
    })));

    const imported = importBinaryItemBank(context, {
      profile: "binary-judgment@1",
      draftId,
      itemBankJsonl: items,
      sourceManifestJsonl: sources,
      admissionIndexJsonl: admissions,
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) throw new Error("unreachable");
    expect(imported.result.taskSha256s).toHaveLength(1);
    expect(imported.result.nonAdmittedItemSha256s).toEqual([
      recordDigest(canonicalJsonBytes(heldBackItem)).slice("sha256:".length),
    ]);
    expect(imported.result.truthAdmission).toBe("operator-only");
    expect(imported.result.publicationGrade).toBe(false);
    expect(imported.result.candidateClasses).toEqual(["synthetic"]);
    expect(imported.result.strata).toEqual(["core"]);
    expect(imported.result.draft.spec.taskSet).toEqual({
      kind: "benchmark",
      benchmarkSha256: imported.result.benchmarkSha256,
    });

    const task = TaskSpecificationSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, imported.result.taskSha256s[0]!),
    )));
    expect(task.outputs).toEqual([
      { name: "judge-response", mediaType: "text/plain; charset=utf-8", required: true },
      {
        name: "judge-observation",
        mediaType: "application/vnd.jinn.binary-judgment.observation.v1+json",
        required: true,
      },
      { name: "inspect-log", mediaType: "application/vnd.inspect-ai.eval-log+json", required: false },
    ]);
    expect(task.requirements).toBeUndefined();
    expect(() => getSealedBytes(context.workspaceDir, imported.result.evaluationSpecSha256s[0]!)).not.toThrow();
    expect(() => getSealedBytes(context.workspaceDir, imported.result.sourceManifestSha256)).not.toThrow();
    expect(readAuditEntries(context.workspaceDir).filter((entry) => entry.action === "import.item-bank"))
      .toEqual([expect.objectContaining({ actor: "sponsor-1", outcome: "ok" })]);

    const wrongProfile = importBinaryItemBank(context, {
      profile: "binary-judgment@2" as "binary-judgment@1",
      draftId,
      itemBankJsonl: items,
      sourceManifestJsonl: sources,
      admissionIndexJsonl: admissions,
    });
    expect(wrongProfile).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  test("authenticates human-review exclusion evidence and imports only its later same-slice replacement", async () => {
    const { context, draftId, setClock } = setup();
    const provenanceSha256 = `sha256:${"d".repeat(64)}` as const;
    const disputedItem = {
      itemId: "urn:uuid:30000000-0000-4000-8000-000000000001",
      question: "Synthetic disputed question?",
      referenceAnswer: "Synthetic reference.",
      candidateAnswer: "Synthetic disputed candidate.",
      provenance: [{ digest: { sha256: provenanceSha256.slice("sha256:".length) } }] as const,
    };
    const replacementItem = {
      ...disputedItem,
      itemId: "urn:uuid:30000000-0000-4000-8000-000000000002",
      candidateAnswer: "Synthetic admitted reserve.",
    };
    const disputed = await reviewItem(context, draftId, disputedItem, ["CORRECT", "WRONG"]);
    const replacement = await reviewItem(context, draftId, replacementItem, ["WRONG", "WRONG"]);
    const reviewerRoster = [
      { evaluatorId: "urn:jinn:reviewer:a", personId: "person-a", role: "domain-reviewer", conflicts: [] },
      { evaluatorId: "urn:jinn:reviewer:b", personId: "person-b", role: "domain-reviewer", conflicts: [] },
    ] as const;
    setClock("2026-08-15T10:10:00.000Z");
    const admitted = admitHumanTruth(context, {
      draftId,
      truthAdmission: "two-human-unanimous",
      candidates: [
        {
          itemSha256: disputed.packets.itemSha256,
          itemId: disputedItem.itemId,
          humanReviewEvaluationSpecSha256: disputed.packets.humanReviewEvaluationSpecSha256,
          candidateClass: "factual",
          stratum: "core",
          poolPosition: 1,
          reviewVerdictSha256s: disputed.verdictSha256s,
          reviewers: reviewerRoster,
        },
        {
          itemSha256: replacement.packets.itemSha256,
          itemId: replacementItem.itemId,
          humanReviewEvaluationSpecSha256: replacement.packets.humanReviewEvaluationSpecSha256,
          candidateClass: "factual",
          stratum: "core",
          poolPosition: 2,
          reviewVerdictSha256s: replacement.verdictSha256s,
          reviewers: reviewerRoster,
          replacesItemSha256: disputed.packets.itemSha256,
        },
      ],
    });
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");

    const imported = importBinaryItemBank(context, {
      profile: "binary-judgment@1",
      draftId,
      itemBankJsonl: renderCanonicalJsonl([
        { protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: disputedItem },
        { protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item: replacementItem },
      ]),
      sourceManifestJsonl: renderCanonicalJsonl([{
        protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
        provenanceSha256,
        source: { uri: "https://fixtures.example.test/replacement-source", digest: { sha256: "d".repeat(64) } },
        license: { uri: "https://fixtures.example.test/replacement-license", digest: { sha256: "e".repeat(64) } },
        attribution: { uri: "https://fixtures.example.test/replacement-attribution", digest: { sha256: "f".repeat(64) } },
      }]),
      admissionIndexJsonl: renderCanonicalJsonl(admitted.result.resolutions.map((resolution) => ({
        protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
        admissionManifestSha256: admitted.result.admissionManifestSha256,
        itemSha256: resolution.itemSha256,
        labelResolutionSha256: resolution.labelResolutionSha256,
        analysisContextSha256: resolution.analysisContextSha256,
      }))),
    });
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    if (!imported.ok) throw new Error("unreachable");
    expect(imported.result.publicationGrade).toBe(true);
    expect(imported.result.candidateClasses).toEqual(["factual"]);
    expect(imported.result.strata).toEqual(["core"]);
    expect(imported.result.excludedItemSha256s).toEqual([
      disputed.packets.itemSha256.slice("sha256:".length),
    ]);
    expect(imported.result.nonAdmittedItemSha256s).toEqual([]);
    expect(imported.result.taskSha256s).toHaveLength(1);
    const task = TaskSpecificationSchema.parse(JSON.parse(new TextDecoder().decode(
      getSealedBytes(context.workspaceDir, imported.result.taskSha256s[0]!),
    )));
    expect(task.payload).toEqual(replacementItem);
  });
});
