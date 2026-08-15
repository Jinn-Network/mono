// SPDX-License-Identifier: Apache-2.0

import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import {
  buildBinaryJudgmentProfile,
  sealTaskProfile,
} from "@jinn-network/task-execution-profiles";
import type { DraftDocument } from "../domain/draft.js";
import {
  BINARY_ITEM_BANK_EVALUATOR_SEMANTICS,
  convertBinaryItemBank,
} from "../intake/binary-item-bank.js";
import { buildBinaryJudgmentAdmissionClosureWorkspacePorts } from "../human-review/verification-workspace.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { refuse } from "../errors.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { attachBenchmarkToDraft } from "./attach.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export const BINARY_ITEM_BANK_PROFILE = "binary-judgment@1" as const;

export interface ImportBinaryItemBankInput {
  readonly profile: typeof BINARY_ITEM_BANK_PROFILE;
  readonly draftId: string;
  readonly itemBankJsonl: string;
  readonly sourceManifestJsonl: string;
  readonly admissionIndexJsonl: string;
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
}

export interface ImportBinaryItemBankResult {
  readonly draft: DraftDocument;
  readonly benchmarkSha256: string;
  readonly taskSha256s: readonly string[];
  readonly evaluationSpecSha256s: readonly string[];
  readonly itemBankSha256: string;
  readonly sourceManifestSha256: string;
  readonly admissionIndexSha256: string;
  readonly admissionManifestSha256: string;
  readonly replacementLedgerSha256: string;
  readonly excludedItemSha256s: readonly string[];
  readonly nonAdmittedItemSha256s: readonly string[];
  readonly truthAdmission: "two-human-unanimous" | "operator-only";
  readonly publicationGrade: boolean;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly ("core" | "stress")[];
}

function bare(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function storeExact(workspaceDir: string, bytes: Uint8Array, expected: string, label: string): string {
  const stored = putSealedBytes(workspaceDir, bytes);
  if (stored !== bare(expected)) {
    throw new Error(`${label} digest mismatch: intake reported ${expected}, store computed sha256:${stored}`);
  }
  return stored;
}

/**
 * Seals admitted binary items into the ordinary Task/EvaluationSpec/Benchmark stack and attaches
 * the Benchmark to a draft. Existing human admission records are resolved from the workspace CAS;
 * no reviewer, source, model, Inspect, or Harbor implementation is duplicated here.
 */
export function importBinaryItemBank(
  context: OperationContext,
  input: ImportBinaryItemBankInput,
): OperationResult<ImportBinaryItemBankResult> {
  const at = context.clock();
  const clocked: OperationContext = { ...context, clock: () => at };
  return operate({
    context: clocked,
    action: "import.item-bank",
    subject: input.draftId,
    inputs: input,
    run: () => {
      if (input.profile !== BINARY_ITEM_BANK_PROFILE) {
        refuse("validation", "profile", `profile must be ${BINARY_ITEM_BANK_PROFILE}`);
      }
      const draft = readDraftDocument(clocked.workspaceDir, input.draftId);
      const author = loadOrCreateReportSigningKey(clocked.workspaceDir).keyId;
      const converted = convertBinaryItemBank({
        draftId: input.draftId,
        itemBankJsonl: input.itemBankJsonl,
        sourceManifestJsonl: input.sourceManifestJsonl,
        admissionIndexJsonl: input.admissionIndexJsonl,
        name: input.name ?? draft.spec.name,
        description: input.description ?? draft.spec.description ?? "",
        version: input.version ?? "1.0.0",
        author,
        admissionVerificationPorts: buildBinaryJudgmentAdmissionClosureWorkspacePorts(
          clocked.workspaceDir,
        ),
      });

      // Retain protocol/profile/evaluator semantics as exact offline dependencies, not copied code.
      putSealedBytes(clocked.workspaceDir, sealTaskProfile(buildBinaryJudgmentProfile()).bytes);
      putSealedBytes(clocked.workspaceDir, BINARY_ITEM_BANK_EVALUATOR_SEMANTICS.bytes);
      storeExact(clocked.workspaceDir, converted.itemBank.bytes, converted.itemBank.digest, "item bank");
      storeExact(
        clocked.workspaceDir,
        converted.sourceManifest.bytes,
        converted.sourceManifest.digest,
        "source manifest",
      );
      storeExact(
        clocked.workspaceDir,
        converted.admissionIndex.bytes,
        converted.admissionIndex.digest,
        "admission index",
      );

      const taskSha256s: string[] = [];
      const evaluationSpecSha256s: string[] = [];
      for (const item of converted.items) {
        // The admitted item existed already; re-putting verifies and retains the exact canonical
        // payload used to seal the Task without introducing a second representation.
        storeExact(
          clocked.workspaceDir,
          item.itemBytes,
          item.itemSha256,
          `item ${item.itemId}`,
        );
        const evaluationSpecSha256 = storeExact(
          clocked.workspaceDir,
          item.evaluationSpec.bytes,
          item.evaluationSpec.digest,
          `EvaluationSpec ${item.itemId}`,
        );
        const taskSha256 = storeExact(
          clocked.workspaceDir,
          item.task.bytes,
          item.task.digest,
          `Task ${item.itemId}`,
        );
        recordWorkspaceAuthorship({
          workspaceDir: clocked.workspaceDir,
          recordSha256: taskSha256,
          recordKind: RECORD_KINDS.task,
          authoredAt: at,
        });
        evaluationSpecSha256s.push(evaluationSpecSha256);
        taskSha256s.push(taskSha256);
      }

      const benchmarkSha256 = storeExact(
        clocked.workspaceDir,
        converted.benchmark.bytes,
        converted.benchmark.digest,
        "Benchmark",
      );
      recordWorkspaceAuthorship({
        workspaceDir: clocked.workspaceDir,
        recordSha256: benchmarkSha256,
        recordKind: BENCHMARK_RECORD_KIND,
        authoredAt: at,
      });
      const attached = attachBenchmarkToDraft(clocked.workspaceDir, input.draftId, benchmarkSha256, at);

      return {
        draft: attached,
        benchmarkSha256,
        taskSha256s,
        evaluationSpecSha256s,
        itemBankSha256: bare(converted.itemBank.digest),
        sourceManifestSha256: bare(converted.sourceManifest.digest),
        admissionIndexSha256: bare(converted.admissionIndex.digest),
        admissionManifestSha256: bare(converted.admissionManifestSha256),
        replacementLedgerSha256: bare(converted.admissionManifest.replacementLedgerSha256),
        excludedItemSha256s: converted.excludedItemSha256s.map(bare),
        nonAdmittedItemSha256s: converted.nonAdmittedItemSha256s.map(bare),
        truthAdmission: converted.admissionManifest.truthAdmission,
        publicationGrade: converted.publicationGrade,
        candidateClasses: converted.candidateClasses,
        strata: converted.strata,
      };
    },
  });
}
