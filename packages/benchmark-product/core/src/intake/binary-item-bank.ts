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
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BinaryJudgmentPayloadSchema,
  BinaryJudgmentSourceDescriptorSchema,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  canonicalJsonBytes,
  compareCodeUnitStrings,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentLabelResolution,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentLabelResolution,
  sealEvaluationSpec,
  type BinaryJudgmentAnalysisContext,
  type BinaryJudgmentLabelResolution,
  type BinaryJudgmentPayload,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import { refuse, refuseWithIssues } from "../errors.js";
import {
  BinaryJudgmentAdmissionManifestSchema,
  HumanReviewReplacementLedgerSchema,
  parseCanonicalHumanReviewBytes,
  type BinaryJudgmentAdmissionManifest,
  type HumanReviewReplacementLedger,
} from "../human-review/contracts.js";

export const BINARY_ITEM_BANK_ENTRY_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/item-bank-entry/v1" as const;
export const BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/source-manifest-entry/v1" as const;
export const BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/admission-index-entry/v1" as const;
export const BINARY_ITEM_BANK_INTAKE_EXTENSION =
  "https://product.jinn.network/extensions/binary-judgment-intake/v1" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
  .transform((value) => value as `sha256:${string}`);

export const BinaryItemBankEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_ITEM_BANK_ENTRY_PROTOCOL),
  item: BinaryJudgmentPayloadSchema,
});
export type BinaryItemBankEntry = z.infer<typeof BinaryItemBankEntrySchema>;

export const BinarySourceManifestEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_SOURCE_MANIFEST_ENTRY_PROTOCOL),
  provenanceSha256: DigestSchema,
  source: BinaryJudgmentSourceDescriptorSchema,
  license: BinaryJudgmentSourceDescriptorSchema,
  attribution: BinaryJudgmentSourceDescriptorSchema,
}).superRefine((entry, ctx) => {
  if (`sha256:${entry.source.digest.sha256}` !== entry.provenanceSha256) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "digest", "sha256"],
      message: "source digest must equal provenanceSha256",
    });
  }
});
export type BinarySourceManifestEntry = z.infer<typeof BinarySourceManifestEntrySchema>;

export const BinaryAdmissionIndexEntrySchema = z.strictObject({
  protocol: z.literal(BINARY_ADMISSION_INDEX_ENTRY_PROTOCOL),
  admissionManifestSha256: DigestSchema,
  itemSha256: DigestSchema,
  labelResolutionSha256: DigestSchema,
  analysisContextSha256: DigestSchema,
});
export type BinaryAdmissionIndexEntry = z.infer<typeof BinaryAdmissionIndexEntrySchema>;

export const BinaryItemBankIntakeExtensionSchema = z.strictObject({
  profile: z.literal(BINARY_JUDGMENT_PROFILE_URI),
  itemBankSha256: DigestSchema,
  sourceManifestSha256: DigestSchema,
  admissionIndexSha256: DigestSchema,
  admissionManifestSha256: DigestSchema,
  replacementLedgerSha256: DigestSchema,
});
export type BinaryItemBankIntakeExtension = z.infer<typeof BinaryItemBankIntakeExtensionSchema>;

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
  /** Exact workspace CAS resolver. The intake layer never invents or fetches admission evidence. */
  readonly resolveRecord: (sha256: string) => Uint8Array;
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function resolveCanonical<T>(input: {
  readonly digest: `sha256:${string}`;
  readonly label: string;
  readonly resolveRecord: (sha256: string) => Uint8Array;
  readonly parse: (bytes: Uint8Array) => T;
  readonly reseal: (value: T) => { readonly bytes: Uint8Array; readonly digest: `sha256:${string}` };
}): { readonly value: T; readonly bytes: Uint8Array } {
  const bytes = input.resolveRecord(bare(input.digest));
  if (recordDigest(bytes) !== input.digest) {
    refuse("record-integrity", input.label, `${input.label} bytes do not match ${input.digest}`);
  }
  let value: T;
  try {
    value = input.parse(bytes);
  } catch (cause) {
    refuse("validation", input.label, cause instanceof Error ? cause.message : String(cause));
  }
  const sealed = input.reseal(value);
  if (sealed.digest !== input.digest || !bytesEqual(sealed.bytes, bytes)) {
    refuse("record-integrity", input.label, `${input.label} is not in canonical sealed form`);
  }
  return { value, bytes };
}

function sameSorted(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function buildEvaluationSpec(analysisContextSha256: `sha256:${string}`) {
  return sealEvaluationSpec({
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
      digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      accessClass: "public",
    },
    familyBlock: {
      image: {
        name: "binary-judgment-evaluation-parser-semantics.json",
        digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "analysis-context.json",
        digest: { sha256: bare(analysisContextSha256) },
        mediaType: BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
        accessClass: "private",
      }],
      parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [
      { name: "judgeDecision", type: "string", required: true },
      { name: "truthLabel", type: "string", required: true },
      { name: "agreement", type: "boolean", required: true },
      { name: "parseValid", type: "boolean", required: true },
      { name: "candidateClass", type: "string", required: true },
      { name: "stratum", type: "string", required: true },
      { name: "labelResolutionSha256", type: "string", required: true },
      { name: "instrumentSha256", type: "string", required: true },
    ],
    verdictRule: { threshold: { measurement: "agreement", op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: ["label-resolution.json"] },
  });
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
  const admissionManifestBytes = input.resolveRecord(bare(admissionManifestSha256));
  if (recordDigest(admissionManifestBytes) !== admissionManifestSha256) {
    refuse("record-integrity", "admissionManifestSha256", "admission manifest digest mismatch");
  }
  const admissionManifest = parseCanonicalHumanReviewBytes(
    BinaryJudgmentAdmissionManifestSchema,
    admissionManifestBytes,
    "admission manifest",
  );
  if (admissionManifest.draftId !== input.draftId) {
    refuse("validation", "admissionManifest.draftId", "admission manifest belongs to another draft");
  }

  const indexedLabels = admissions.records.map((entry) => entry.labelResolutionSha256).sort(compareCodeUnitStrings);
  const indexedContexts = admissions.records.map((entry) => entry.analysisContextSha256).sort(compareCodeUnitStrings);
  if (!sameSorted(indexedLabels, admissionManifest.labelResolutionSha256s)) {
    refuse("validation", "admissions", "admission rows do not exactly cover manifest label resolutions");
  }
  if (!sameSorted(indexedContexts, admissionManifest.analysisContextSha256s)) {
    refuse("validation", "admissions", "admission rows do not exactly cover manifest analysis contexts");
  }

  const admittedItems = new Set<string>();
  const converted = admissions.records.map((entry, index): ConvertedBinaryItem => {
    const item = itemsBySha.get(entry.itemSha256);
    if (item === undefined) refuse("validation", `admissions.${index + 1}.itemSha256`, "admitted item is absent from item bank");
    if (admittedItems.has(entry.itemSha256)) refuse("validation", "admissions", "item is admitted more than once");
    admittedItems.add(entry.itemSha256);

    const exactItemBytes = canonicalJsonBytes(item);
    const storedItemBytes = input.resolveRecord(bare(entry.itemSha256));
    if (!bytesEqual(exactItemBytes, storedItemBytes) || recordDigest(storedItemBytes) !== entry.itemSha256) {
      refuse("record-integrity", `admissions.${index + 1}.itemSha256`, "item bank payload differs from admitted item bytes");
    }

    const label = resolveCanonical<BinaryJudgmentLabelResolution>({
      digest: entry.labelResolutionSha256,
      label: `admissions.${index + 1}.labelResolutionSha256`,
      resolveRecord: input.resolveRecord,
      parse: parseBinaryJudgmentLabelResolution,
      reseal: sealBinaryJudgmentLabelResolution,
    });
    const analysis = resolveCanonical<BinaryJudgmentAnalysisContext>({
      digest: entry.analysisContextSha256,
      label: `admissions.${index + 1}.analysisContextSha256`,
      resolveRecord: input.resolveRecord,
      parse: parseBinaryJudgmentAnalysisContext,
      reseal: sealBinaryJudgmentAnalysisContext,
    });
    const resolution = label.value;
    const context = analysis.value;
    const joins: readonly [boolean, string][] = [
      [resolution.itemSha256 === entry.itemSha256, "resolution itemSha256"],
      [context.itemSha256 === entry.itemSha256, "analysis itemSha256"],
      [resolution.itemId === item.itemId, "resolution itemId"],
      [context.itemId === item.itemId, "analysis itemId"],
      [context.labelResolutionSha256 === entry.labelResolutionSha256, "analysis label resolution"],
      [context.truthLabel === resolution.truthLabel, "truth label"],
      [context.candidateClass === resolution.candidateClass, "candidate class"],
      [context.stratum === resolution.stratum, "stratum"],
      [resolution.truthAdmission === admissionManifest.truthAdmission, "truth admission"],
    ];
    for (const [matches, name] of joins) {
      if (!matches) refuse("record-integrity", `admissions.${index + 1}`, `${name} join failed`);
    }

    const evaluationSpec = buildEvaluationSpec(entry.analysisContextSha256);
    const task = buildTask({
      item,
      itemSha256: entry.itemSha256,
      evaluationSpecSha256: evaluationSpec.digest,
      author: input.author,
    });
    return {
      itemId: item.itemId,
      itemSha256: entry.itemSha256,
      itemBytes: exactItemBytes,
      labelResolutionSha256: entry.labelResolutionSha256,
      analysisContextSha256: entry.analysisContextSha256,
      evaluationSpec,
      task,
    };
  });

  const excluded = new Set(admissionManifest.excludedItemSha256s);
  for (const digest of excluded) {
    if (admittedItems.has(digest)) refuse("record-integrity", "admissionManifest", "an excluded item is also admitted");
    if (!itemsBySha.has(digest as `sha256:${string}`)) {
      refuse("validation", "items", `excluded item ${digest} is absent from item bank`);
    }
    const itemBytes = canonicalJsonBytes(itemsBySha.get(digest as `sha256:${string}`)!);
    const storedItemBytes = input.resolveRecord(bare(digest));
    if (!bytesEqual(itemBytes, storedItemBytes) || recordDigest(storedItemBytes) !== digest) {
      refuse("record-integrity", "admissionManifest.excludedItemSha256s", `excluded item ${digest} does not resolve exactly`);
    }
  }
  const replacementLedgerBytes = input.resolveRecord(bare(admissionManifest.replacementLedgerSha256));
  if (recordDigest(replacementLedgerBytes) !== admissionManifest.replacementLedgerSha256) {
    refuse("record-integrity", "replacementLedgerSha256", "replacement ledger digest mismatch");
  }
  const replacementLedger = parseCanonicalHumanReviewBytes(
    HumanReviewReplacementLedgerSchema,
    replacementLedgerBytes,
    "replacement ledger",
  );
  if (replacementLedger.draftId !== input.draftId) {
    refuse("record-integrity", "replacementLedger.draftId", "replacement ledger belongs to another draft");
  }
  const ledgerExcluded = replacementLedger.entries.map((entry) => entry.excludedItemSha256).sort(compareCodeUnitStrings);
  if (!sameSorted(ledgerExcluded, admissionManifest.excludedItemSha256s)) {
    refuse("record-integrity", "replacementLedger", "replacement ledger does not exactly cover excluded items");
  }
  const convertedByItem = new Map(converted.map((entry) => [entry.itemSha256, entry]));
  for (const [index, ledgerEntry] of replacementLedger.entries.entries()) {
    const replacement = convertedByItem.get(ledgerEntry.replacementItemSha256 as `sha256:${string}`);
    if (replacement === undefined) {
      refuse("record-integrity", `replacementLedger.entries.${index}`, "replacement is not an admitted item");
    }
    const context = parseBinaryJudgmentAnalysisContext(input.resolveRecord(bare(replacement.analysisContextSha256)));
    if (context.candidateClass !== ledgerEntry.candidateClass || context.stratum !== ledgerEntry.stratum) {
      refuse("record-integrity", `replacementLedger.entries.${index}`, "replacement changed class or stratum");
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
      replacementLedgerSha256: admissionManifest.replacementLedgerSha256,
    },
  });

  // The parser proves the sealed extension survives rather than being silently stripped.
  const benchmarkRecord = parseBenchmark(benchmarkSealed.bytes);
  parseBinaryItemBankIntakeExtension(benchmarkRecord);

  return {
    itemBank: itemBankCommitment,
    sourceManifest: sourceManifestCommitment,
    admissionIndex: admissionIndexCommitment,
    admissionManifest,
    admissionManifestSha256,
    replacementLedger,
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
