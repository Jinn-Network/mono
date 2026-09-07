// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/task-execution-profiles";
import { BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED } from "../human-review/application.js";
import {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  renderCanonicalJsonl,
} from "../intake/binary-item-bank.js";
import { createDraft } from "../operations/drafts.js";
import { admitHumanTruth } from "../operations/human-review.js";
import { initWorkspace } from "../operations/init.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { runCli } from "./main.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("colophon import item-bank", () => {
  test("accepts the exact profile + three-manifest interface and renders JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-item-bank-cli-"));
    roots.push(root);
    const workspaceDir = join(root, "workspace");
    let tick = 0;
    const operationContext = {
      workspaceDir,
      principal: "sponsor-1",
      clock: () => `2026-08-15T11:00:${String(tick++).padStart(2, "0")}.000Z`,
    };
    expect(initWorkspace(operationContext).ok).toBe(true);
    expect(createDraft(operationContext, { draftId: "d1", name: "Binary CLI" }).ok).toBe(true);
    const provenanceSha256 = `sha256:${"a".repeat(64)}` as const;
    const publishedAt = "2026-03-09T00:00:00Z";
    const item = {
      itemId: "urn:uuid:20000000-0000-4000-8000-000000000001",
      question: "Synthetic CLI question?",
      referenceAnswer: "Reference.",
      candidateAnswer: "Candidate.",
      provenance: { sourceCommitment: provenanceSha256, timestamp: publishedAt },
      sources: [{ digest: { sha256: provenanceSha256.slice("sha256:".length) } }],
    };
    const itemBytes = canonicalJsonBytes(item);
    const itemSha256 = recordDigest(itemBytes);
    putSealedBytes(workspaceDir, itemBytes);
    const admission = admitHumanTruth(operationContext, {
      draftId: "d1",
      truthAdmission: "operator-only",
      candidates: [{
        itemSha256,
        itemId: item.itemId,
        humanReviewEvaluationSpecSha256: BINARY_JUDGMENT_HUMAN_REVIEW_EVALUATION_SPEC_SEALED.digest,
        candidateClass: "synthetic",
        stratum: "stress",
        poolPosition: 1,
        operatorTruthLabel: "WRONG",
      }],
    });
    if (!admission.ok) throw new Error(JSON.stringify(admission));
    const resolution = admission.result.resolutions[0]!;

    const itemsPath = join(root, "items.jsonl");
    const sourcesPath = join(root, "sources.jsonl");
    const admissionsPath = join(root, "admissions.jsonl");
    writeFileSync(itemsPath, renderCanonicalJsonl([{ protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL, item }]));
    writeFileSync(sourcesPath, renderCanonicalJsonl([{
      protocol: BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
      provenanceSha256,
      source: { uri: "https://fixtures.example.test/source", digest: { sha256: "a".repeat(64) } },
      license: { uri: "https://fixtures.example.test/license", digest: { sha256: "b".repeat(64) } },
      attribution: { uri: "https://fixtures.example.test/attribution", digest: { sha256: "c".repeat(64) } },
      publishedAt,
    }]));
    writeFileSync(admissionsPath, renderCanonicalJsonl([{
      protocol: BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
      admissionManifestSha256: admission.result.admissionManifestSha256,
      itemSha256: resolution.itemSha256,
      labelResolutionSha256: resolution.labelResolutionSha256,
      analysisContextSha256: resolution.analysisContextSha256,
    }]));

    const invoked = await runCli([
      "import", "item-bank",
      "--workspace", workspaceDir,
      "--principal", "sponsor-1",
      "--profile", "binary-judgment@2",
      "--draft", "d1",
      "--items", itemsPath,
      "--sources", sourcesPath,
      "--admissions", admissionsPath,
      "--parser-invalid-policy", "abstain",
      "--json",
    ], { cwd: root, clock: () => "2026-08-15T11:01:00.000Z" });
    expect(invoked.exitCode, invoked.stderr).toBe(0);
    expect(JSON.parse(invoked.stdout)).toMatchObject({
      ok: true,
      result: {
        taskSha256s: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
        truthAdmission: "operator-only",
        publicationGrade: false,
      },
    });

    const wrongProfile = await runCli([
      "import", "item-bank",
      "--workspace", workspaceDir,
      "--principal", "sponsor-1",
      "--profile", "binary-judgment@1",
      "--draft", "d1",
      "--items", itemsPath,
      "--sources", sourcesPath,
      "--admissions", admissionsPath,
      "--json",
    ], { cwd: root, clock: () => "2026-08-15T11:01:01.000Z" });
    expect(wrongProfile.exitCode).toBe(2);
    expect(JSON.parse(wrongProfile.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });

    // Free text reaching `--license` seals a record whose licence the freeze-repository export
    // then refuses to render, after publication. The flag is where that costs a second.
    const freeText = await runCli([
      "import", "item-bank",
      "--workspace", workspaceDir,
      "--principal", "sponsor-1",
      "--profile", "binary-judgment@2",
      "--draft", "d1",
      "--items", itemsPath,
      "--sources", sourcesPath,
      "--admissions", admissionsPath,
      "--license", "internal use only",
      "--json",
    ], { cwd: root, clock: () => "2026-08-15T11:01:03.000Z" });
    expect(freeText.exitCode).toBe(2);
    expect(JSON.parse(freeText.stdout)).toMatchObject({
      ok: false,
      error: { code: "invalid-invocation", detail: expect.stringContaining("SPDX short identifier") },
    });

    writeFileSync(itemsPath, `\uFEFF${renderCanonicalJsonl([{
      protocol: BINARY_ITEM_BANK_ENTRY_PROTOCOL,
      item,
    }])}`);
    const bomPrefixed = await runCli([
      "import", "item-bank",
      "--workspace", workspaceDir,
      "--principal", "sponsor-1",
      "--profile", "binary-judgment@2",
      "--draft", "d1",
      "--items", itemsPath,
      "--sources", sourcesPath,
      "--admissions", admissionsPath,
      "--json",
    ], { cwd: root, clock: () => "2026-08-15T11:01:02.000Z" });
    expect(bomPrefixed.exitCode).toBe(1);
    expect(JSON.parse(bomPrefixed.stdout)).toMatchObject({
      ok: false,
      error: { code: "validation", detail: expect.stringContaining("BOM") },
    });
  });
});
