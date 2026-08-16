// SPDX-License-Identifier: Apache-2.0

/**
 * Generic, backend-neutral intake for the binary-judgment/1.0 Task profile.
 *
 * The three input files are canonical JSONL manifests. Item rows carry only the closed
 * solver-visible payload; source rows retain the full source/license/attribution descriptors;
 * admission rows are an index into records already sealed by the human-truth admission
 * operation. Truth, class, stratum, reviewers, and source locators therefore never enter a Task.
 */

import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  BENCHMARKING_PROTOCOL,
  parseBenchmark,
  sealBenchmark,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import {
  BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  recordDigest,
  sealEvaluationSpec,
  type BinaryJudgmentPayload,
} from "@jinn-network/task-execution-profiles";
import {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  BinaryAdmissionIndexEntrySchema,
  BinaryItemBankEntrySchema,
  BinaryItemBankIntakeExtensionSchema,
  BinarySourceManifestEntrySchema,
  type BinaryAdmissionIndexEntry,
  type BinaryItemBankEntry,
  type BinaryItemBankIntakeExtension,
  type BinarySourceManifestEntry,
} from "@colophon-claims/verify/admission";
export {
  BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_ENTRY_PROTOCOL,
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL,
  BinaryAdmissionIndexEntrySchema,
  BinaryItemBankEntrySchema,
  BinaryItemBankIntakeExtensionSchema,
  BinarySourceManifestEntrySchema,
};
export type {
  BinaryAdmissionIndexEntry,
  BinaryItemBankEntry,
  BinaryItemBankIntakeExtension,
  BinarySourceManifestEntry,
};
import {
  buildBinaryJudgmentEvaluationSpecification,
  isBinaryJudgmentEvaluationSpecification,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { refuse, refuseWithIssues } from "../errors.js";
import type {
  BinaryJudgmentAdmissionManifest,
  HumanReviewReplacementLedger,
} from "../human-review/contracts.js";
import {
  BinaryJudgmentAdmissionClosureError,
  verifyBinaryJudgmentAdmissionClosure,
  type BinaryJudgmentAdmissionClosurePorts,
} from "../human-review/verification.js";

export function parseBinaryItemBankIntakeExtension(
  benchmark: BenchmarkRecord,
): BinaryItemBankIntakeExtension {
  const parsed = BinaryItemBankIntakeExtensionSchema.safeParse(
    benchmark[BINARY_ITEM_BANK_INTAKE_EXTENSION],
  );
  if (!parsed.success) {
    refuseWithIssues("validation", parsed.error.issues.map((issue) => ({
      path: `${BINARY_ITEM_BANK_INTAKE_EXTENSION}${issue.path.length === 0 ? "" : `.${issue.path.join(".")}`}`,
      message: issue.message,
    })));
  }
  return parsed.data;
}

export interface ConvertBinaryItemBankInput {
  readonly draftId: string;
  readonly itemBankJsonl: string;
  readonly sourceManifestJsonl: string;
  readonly admissionIndexJsonl: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  /** Exact record resolution plus reviewer and role-separated authority trust. */
  readonly admissionVerificationPorts: BinaryJudgmentAdmissionClosurePorts;
}

export interface ConvertedBinaryItem {
  readonly itemId: string;
  readonly itemSha256: `sha256:${string}`;
  readonly itemBytes: Uint8Array;
  readonly labelResolutionSha256: `sha256:${string}`;
  readonly analysisContextSha256: `sha256:${string}`;
  readonly evaluationSpec: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly task: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
}

export interface ConvertedBinaryItemBank {
  readonly itemBank: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly sourceManifest: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly admissionIndex: { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
  readonly admissionManifest: BinaryJudgmentAdmissionManifest;
  readonly admissionManifestSha256: `sha256:${string}`;
  readonly replacementLedger: HumanReviewReplacementLedger;
  readonly publicationGrade: boolean;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly ("core" | "stress")[];
  readonly items: readonly ConvertedBinaryItem[];
  readonly excludedItemSha256s: readonly `sha256:${string}`[];
  readonly nonAdmittedItemSha256s: readonly `sha256:${string}`[];
  readonly benchmark: {
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly record: BenchmarkRecord;
  };
}

interface ParsedJsonl<T> {
  readonly records: readonly T[];
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

function issues(error: z.ZodError, label: string, line: number) {
  return error.issues.map((issue) => ({
    path: `${label}.${line}${issue.path.length === 0 ? "" : `.${issue.path.join(".")}`}`,
    message: issue.message,
  }));
}

function parseCanonicalJsonl<T>(
  text: string,
  schema: z.ZodType<T>,
  label: string,
  sortKey: (record: T) => string,
): ParsedJsonl<T> {
  if (text.length === 0) refuse("validation", label, `${label} must contain at least one row`);
  if (text.includes("\r")) refuse("validation", label, `${label} must use LF line endings`);
  if (!text.endsWith("\n")) refuse("validation", label, `${label} must end with one LF`);
  const rawLines = text.slice(0, -1).split("\n");
  if (rawLines.some((line) => line.length === 0)) {
    refuse("validation", label, `${label} must not contain blank lines`);
  }

  const records = rawLines.map((line, index): T => {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      refuse("validation", `${label}.${index + 1}`, "line is not valid JSON");
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) refuseWithIssues("validation", issues(parsed.error, label, index + 1));
    const canonicalLine = new TextDecoder().decode(canonicalJsonBytes(parsed.data));
    if (canonicalLine !== line) {
      refuse("validation", `${label}.${index + 1}`, "line is not canonical JSON");
    }
    return parsed.data;
  });

  for (let index = 1; index < records.length; index += 1) {
    if (compareCodeUnitStrings(sortKey(records[index - 1]!), sortKey(records[index]!)) >= 0) {
      refuse("validation", label, `${label} rows must be sorted by key and unique`);
    }
  }
  const bytes = new TextEncoder().encode(text);
  return { records, bytes, digest: recordDigest(bytes) };
}

function bare(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function buildEvaluationSpec(analysisContextSha256: `sha256:${string}`) {
  const specification = buildBinaryJudgmentEvaluationSpecification(analysisContextSha256);
  if (!isBinaryJudgmentEvaluationSpecification(specification)) {
    throw new Error("shared binary-judgment EvaluationSpec builder failed its registered validator");
  }
  return sealEvaluationSpec(specification);
}

function buildTask(input: {
  readonly item: BinaryJudgmentPayload;
  readonly itemSha256: `sha256:${string}`;
  readonly evaluationSpecSha256: `sha256:${string}`;
  readonly author: string;
}) {
  const bytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: BINARY_JUDGMENT_PROFILE_URI,
      digest: { sha256: bare(BINARY_JUDGMENT_PROFILE_DIGEST) },
    },
    instructions: "Return exactly ACCEPT or REJECT.",
    payload: input.item,
    outputs: [
      { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
      { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
      { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
    ],
    evaluation: { digest: { sha256: bare(input.evaluationSpecSha256) } },
    author: input.author,
    "network.jinn.binary-judgment.item-sha256": input.itemSha256,
  });
  return { bytes, digest: documentDigest(bytes) };
}

/**
 * Resolve and compile one admitted item bank. No runtime, model, network, or licensed source byte
 * is opened here: the only authority inputs are exact local manifests and F2-sealed CAS records.
 */
export function convertBinaryItemBank(input: ConvertBinaryItemBankInput): ConvertedBinaryItemBank {
  const itemBank = parseCanonicalJsonl(
    input.itemBankJsonl,
    BinaryItemBankEntrySchema,
    "items",
    (entry) => entry.item.itemId,
  );
  const sources = parseCanonicalJsonl(
    input.sourceManifestJsonl,
    BinarySourceManifestEntrySchema,
    "sources",
    (entry) => entry.provenanceSha256,
  );
  const admissions = parseCanonicalJsonl(
    input.admissionIndexJsonl,
    BinaryAdmissionIndexEntrySchema,
    "admissions",
    (entry) => entry.itemSha256,
  );

  const itemsBySha = new Map<`sha256:${string}`, BinaryJudgmentPayload>();
  const itemIds = new Set<string>();
  const usedProvenance = new Set<string>();
  const sourceByDigest = new Map(sources.records.map((entry) => [entry.provenanceSha256, entry]));
  for (const [index, entry] of itemBank.records.entries()) {
    const itemSha256 = recordDigest(canonicalJsonBytes(entry.item));
    if (itemsBySha.has(itemSha256)) refuse("validation", `items.${index + 1}`, "duplicate item payload digest");
    if (itemIds.has(entry.item.itemId)) refuse("validation", `items.${index + 1}.item.itemId`, "duplicate itemId");
    itemIds.add(entry.item.itemId);
    itemsBySha.set(itemSha256, entry.item);
    for (const descriptor of entry.item.provenance) {
      const digest = `sha256:${descriptor.digest.sha256}` as `sha256:${string}`;
      if (!sourceByDigest.has(digest)) {
        refuse("validation", `items.${index + 1}.item.provenance`, `no source row maps ${digest}`);
      }
      usedProvenance.add(digest);
    }
  }
  for (const entry of sources.records) {
    if (!usedProvenance.has(entry.provenanceSha256)) {
      refuse("validation", "sources", `unused source row ${entry.provenanceSha256}`);
    }
  }

  const admissionManifestDigests = new Set(admissions.records.map((entry) => entry.admissionManifestSha256));
  if (admissionManifestDigests.size !== 1) {
    refuse("validation", "admissions", "all admission rows must name one admission manifest");
  }
  const admissionManifestSha256 = admissions.records[0]!.admissionManifestSha256;
  let verifiedAdmission: ReturnType<typeof verifyBinaryJudgmentAdmissionClosure>;
  try {
    verifiedAdmission = verifyBinaryJudgmentAdmissionClosure({
      admissionManifestSha256,
      expectedDraftId: input.draftId,
    }, input.admissionVerificationPorts);
  } catch (cause) {
    const path = cause instanceof BinaryJudgmentAdmissionClosureError ? cause.path : "admissionManifestSha256";
    refuse(
      "record-integrity",
      path,
      `admission closure authentication failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (verifiedAdmission.accepted.length !== admissions.records.length) {
    refuse("validation", "admissions", "admission rows do not exactly cover verified accepted items");
  }
  const acceptedByItem = new Map(
    verifiedAdmission.accepted.map((entry) => [entry.itemSha256, entry]),
  );
  if (acceptedByItem.size !== verifiedAdmission.accepted.length) {
    refuse("record-integrity", "admissionManifest", "verified closure admitted one item more than once");
  }
  const indexedItems = new Set<string>();
  const converted = admissions.records.map((entry, index): ConvertedBinaryItem => {
    const verified = acceptedByItem.get(entry.itemSha256);
    if (verified === undefined) {
      refuse("validation", `admissions.${index + 1}.itemSha256`, "index names an item outside the verified accepted closure");
    }
    if (
      entry.admissionManifestSha256 !== verifiedAdmission.manifestSha256
      || entry.labelResolutionSha256 !== verified.labelResolutionSha256
      || entry.analysisContextSha256 !== verified.analysisContextSha256
    ) {
      refuse("record-integrity", `admissions.${index + 1}`, "index differs from the verified manifest/resolution/context join");
    }
    if (indexedItems.has(entry.itemSha256)) {
      refuse("validation", "admissions", "item is indexed more than once");
    }
    indexedItems.add(entry.itemSha256);

    const item = itemsBySha.get(entry.itemSha256);
    if (item === undefined) refuse("validation", `admissions.${index + 1}.itemSha256`, "admitted item is absent from item bank");
    const exactItemBytes = canonicalJsonBytes(item);
    if (recordDigest(exactItemBytes) !== entry.itemSha256 || item.itemId !== verified.itemId) {
      refuse("record-integrity", `admissions.${index + 1}.itemSha256`, "item bank payload differs from admitted item bytes");
    }

    const evaluationSpec = buildEvaluationSpec(verified.analysisContextSha256);
    const task = buildTask({
      item,
      itemSha256: verified.itemSha256,
      evaluationSpecSha256: evaluationSpec.digest,
      author: input.author,
    });
    return {
      itemId: item.itemId,
      itemSha256: verified.itemSha256,
      itemBytes: exactItemBytes,
      labelResolutionSha256: verified.labelResolutionSha256,
      analysisContextSha256: verified.analysisContextSha256,
      evaluationSpec,
      task,
    };
  });

  const admittedItems = new Set(verifiedAdmission.accepted.map((entry) => entry.itemSha256));
  const excluded = new Set(verifiedAdmission.excluded.map((entry) => entry.itemSha256));
  for (const [index, exclusion] of verifiedAdmission.excluded.entries()) {
    const item = itemsBySha.get(exclusion.itemSha256);
    if (item === undefined) refuse("validation", "items", `verified excluded item ${exclusion.itemSha256} is absent from item bank`);
    if (item.itemId !== exclusion.itemId || recordDigest(canonicalJsonBytes(item)) !== exclusion.itemSha256) {
      refuse("record-integrity", `items.excluded.${index}`, "item bank payload differs from verified excluded item bytes");
    }
  }

  const nonAdmittedItemSha256s = [...itemsBySha.keys()]
    .filter((digest) => !admittedItems.has(digest) && !excluded.has(digest))
    .sort(compareCodeUnitStrings);
  const itemBankCommitment = { bytes: itemBank.bytes, digest: itemBank.digest };
  const sourceManifestCommitment = { bytes: sources.bytes, digest: sources.digest };
  const admissionIndexCommitment = { bytes: admissions.bytes, digest: admissions.digest };
  const benchmarkSealed = sealBenchmark({
    protocol: BENCHMARKING_PROTOCOL,
    name: input.name,
    description: input.description,
    author: input.author,
    version: input.version,
    items: converted.map((entry) => ({ task: { digest: { sha256: bare(entry.task.digest) } } })),
    reveal: { policy: "immediate" },
    [BINARY_ITEM_BANK_INTAKE_EXTENSION]: {
      profile: BINARY_JUDGMENT_PROFILE_URI,
      itemBankSha256: itemBank.digest,
      sourceManifestSha256: sources.digest,
      admissionIndexSha256: admissions.digest,
      admissionManifestSha256,
      replacementLedgerSha256: verifiedAdmission.manifest.replacementLedgerSha256,
    },
  });

  // The parser proves the sealed extension survives rather than being silently stripped.
  const benchmarkRecord = parseBenchmark(benchmarkSealed.bytes);
  parseBinaryItemBankIntakeExtension(benchmarkRecord);

  return {
    itemBank: itemBankCommitment,
    sourceManifest: sourceManifestCommitment,
    admissionIndex: admissionIndexCommitment,
    admissionManifest: verifiedAdmission.manifest,
    admissionManifestSha256: verifiedAdmission.manifestSha256,
    replacementLedger: verifiedAdmission.replacementLedger,
    publicationGrade: verifiedAdmission.publicationGrade,
    candidateClasses: verifiedAdmission.classes,
    strata: verifiedAdmission.strata,
    items: converted,
    excludedItemSha256s: [...excluded].sort(compareCodeUnitStrings) as `sha256:${string}`[],
    nonAdmittedItemSha256s,
    benchmark: {
      bytes: benchmarkSealed.bytes,
      digest: benchmarkSealed.digest,
      record: benchmarkRecord,
    },
  };
}

/** Exact public evaluator semantics bytes retained by the operation for offline closure. */
export const BINARY_ITEM_BANK_EVALUATOR_SEMANTICS = {
  bytes: BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.bytes,
  digest: BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.digest,
} as const;

/** Used only by tests/fixtures that need canonical JSONL without reimplementing its byte rules. */
export function renderCanonicalJsonl(records: readonly unknown[]): string {
  return records.map((record) => Buffer.from(canonicalJsonBytes(record)).toString("utf8")).join("\n") + "\n";
}
