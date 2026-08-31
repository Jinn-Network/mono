/**
 * The sealed report presentation (`presentation.json`), and the projection that binds it to the
 * bundle it travels in.
 *
 * A published bundle already carries everything a machine needs. It does not carry what a READER
 * needs: a title, a summary, the pre-registered questions in the words they were posted in, the
 * limitations in the author's own sentences. Colophon's site builds its page from a bundle member
 * named `presentation.json`, and until now the only producer of that member was a per-report export
 * script that could emit nothing but the frozen evidence-native `/5` closure. A report that is
 * anchored and qualification-projecting — the closure that carries the OpenTimestamps proof and the
 * binary qualification — had no way to be presented at all without being downgraded first, which
 * would have dropped exactly the evidence that makes it checkable.
 *
 * Four disciplines, each of them the reason this is a module in the VERIFIER package rather than a
 * shape the producer keeps to itself:
 *
 * - **Single-sourced, not mirrored.** `@colophon-claims/core` already depends on this package, so
 *   the producer that seals the member and the reader that authenticates it parse it through one
 *   schema. Two copies of a presentation contract would drift, and the thing that drifted would be
 *   the text a reader is shown.
 * - **Display copy is still sealed.** The member is an ordinary manifest entry, so its bytes are
 *   inside the bundle digest. Changing a word changes the bundle identity. That is the whole
 *   integrity claim being made here, and it is deliberately not more: the presentation enters no
 *   claim package and no signed envelope, and it proves nothing about the numbers it repeats.
 * - **It must name the report it presents.** The one failure this projection exists to make
 *   impossible is a presentation describing one report while travelling in another's bundle. The
 *   member names its report and report-envelope digests, and this function refuses unless they are
 *   the bundle's own. Without that check a verifier could report "all checks passed" over a page
 *   that describes a different experiment.
 * - **Optional, so silence costs nothing.** A run that never set a presentation publishes exactly
 *   the bytes it published before this member existed. The closure version does not move, no
 *   mandatory member list grows, and the only bundles that change are the ones that opted in.
 *
 * Naming note: `assets.ts` already uses "presentation profile" for the asset RENDERING profile a
 * closure selects (`index.html`, `badge.svg`, `README.md`). That is a different thing. This module
 * is always the "report presentation".
 */

import { z } from "zod";
import { canonicalJsonBytes } from "@jinn-network/trust-core";

/** The member path. Fixed, because the consuming site looks it up by name and not by role. */
export const REPORT_PRESENTATION_MEMBER = "presentation.json" as const;

/**
 * `colophon.report-presentation/2`.
 *
 * Version 1 is the frozen evidence-native contract: it pins `verification.bundleFormat` to
 * `benchmark-product-public-bundle/5`, and its `result`, `population`, `accounting`, and
 * `manipulationCheck` sub-shapes describe a paired-delta effect estimate over an informative task
 * subset. None of that can describe a binary-instrument report, whose result is a per-arm agreement
 * table, whose population is a stratified item bank, and whose accounting counts judge calls rather
 * than cells of a paired comparison. Reusing `/1` would have meant either declaring a bundle format
 * this bundle does not have, or bending four sub-shapes to carry values they were not named for.
 *
 * Version 2 therefore keeps `/1`'s TOP-LEVEL key set exactly — a consumer's projection stays a
 * key-for-key copy — and re-specifies the sub-shapes that could not be honest.
 */
export const REPORT_PRESENTATION_SCHEMA_ID = "colophon.report-presentation/2" as const;

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase sha256 hex digest");
const NonEmpty = z.string().min(1);
/** The same shape the consuming site accepts on its own `--slug` argument. */
const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u, "must be a lowercase hyphenated slug");
const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
  "must be an RFC 3339 UTC instant",
);
/**
 * Rates and interval bounds are carried as the sealed Report carries them: decimal STRINGS, at the
 * precision the analysis fixed. Reading them back as JSON numbers would re-round them, and a
 * presentation that re-rounds is a presentation whose numbers no longer byte-match the record a
 * reader is told to check them against.
 */
const DecimalSchema = z.string().regex(/^-?\d+\.\d+$/u, "must be a fixed-precision decimal string");

const ProportionSchema = z.strictObject({
  numerator: z.number().int().nonnegative(),
  denominator: z.number().int().positive(),
  estimate: DecimalSchema,
  wilsonInterval: z.strictObject({ low: DecimalSchema, high: DecimalSchema }),
});

const ArmSchema = z.strictObject({
  id: NonEmpty,
  label: NonEmpty,
  /** The sealed judge instrument this arm was pinned to, `sha256:`-prefixed as the Run records it. */
  instrumentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});

/**
 * One pre-registered question, its answer, and — the part that matters — WHICH bundle proves the
 * answer. This report's five questions are not all answered by one run: two are answered by
 * separately published companion bundles with their own digests. A presentation that stated all
 * five as though this bundle backed them would be asking a reader to check something here that is
 * not here.
 */
const PreRegisteredQuestionSchema = z.strictObject({
  id: z.string().regex(/^q[1-5]$/u),
  question: NonEmpty,
  answer: NonEmpty,
  /** `this-bundle`, or the `companionBundles[].name` of the bundle that carries the evidence. */
  provenBy: NonEmpty,
});

export const ReportPresentationSchema = z.strictObject({
  schema: z.literal(REPORT_PRESENTATION_SCHEMA_ID),
  slug: SlugSchema,
  title: NonEmpty,
  summary: NonEmpty,
  sealedAt: Rfc3339Schema,
  subject: z.strictObject({
    judgeModel: NonEmpty,
    harness: z.strictObject({ id: NonEmpty, version: NonEmpty }),
    benchmark: z.strictObject({
      name: NonEmpty,
      description: NonEmpty,
      sha256: Sha256HexSchema,
    }),
    arms: z.array(ArmSchema).min(1),
  }),
  question: z.strictObject({
    designUrl: z.string().url(),
    postedOn: NonEmpty,
    preRegistered: z.array(PreRegisteredQuestionSchema).min(1),
  }),
  execution: z.strictObject({
    judgePrompts: z.strictObject({ count: z.number().int().positive(), provenance: NonEmpty }),
    modelSnapshot: z.strictObject({ id: NonEmpty, temperature: NonEmpty, profile: NonEmpty }),
    replicates: z.number().int().positive(),
    reduction: NonEmpty,
    abstainPolicy: z.strictObject({ parserInvalid: NonEmpty, description: NonEmpty }),
    intervals: NonEmpty,
    truthAdmission: NonEmpty,
    venue: NonEmpty,
  }),
  result: z.strictObject({
    primary: NonEmpty,
    perArm: z.array(z.strictObject({
      armId: NonEmpty,
      agreement: ProportionSchema,
      acceptsSpecificWrong: ProportionSchema,
      acceptsVagueTopicalWrong: ProportionSchema,
      rejectsCorrect: ProportionSchema,
    })).min(1),
    spread: z.strictObject({
      lowestArmId: NonEmpty,
      highestArmId: NonEmpty,
      pointsBetween: DecimalSchema,
    }),
    interpretation: NonEmpty,
    methodStatement: NonEmpty,
  }),
  population: z.strictObject({
    items: z.number().int().positive(),
    perCandidateClass: z.array(z.strictObject({
      candidateClass: NonEmpty,
      items: z.number().int().positive(),
    })).min(1),
    perStratum: z.array(z.strictObject({
      stratum: NonEmpty,
      items: z.number().int().positive(),
    })).min(1),
    labels: NonEmpty,
  }),
  accounting: z.strictObject({
    cells: z.strictObject({
      expected: z.number().int().positive(),
      judged: z.number().int().nonnegative(),
      lost: z.number().int().nonnegative(),
    }),
    parserNeutral: z.strictObject({
      calls: z.number().int().nonnegative(),
      denominator: z.number().int().positive(),
      policy: NonEmpty,
      note: NonEmpty,
    }),
    excludedItems: z.strictObject({
      count: z.number().int().nonnegative(),
      byArm: z.array(z.strictObject({
        armId: NonEmpty,
        items: z.number().int().nonnegative(),
      })),
    }),
    completenessFloor: DecimalSchema,
    runOutcome: NonEmpty,
  }),
  manipulationCheck: z.strictObject({
    replicateInstability: z.strictObject({
      unstableItems: z.number().int().nonnegative(),
      gradedItems: z.number().int().positive(),
    }),
    conflictedCells: z.number().int().nonnegative(),
    /** Checks whose evidence is a companion bundle, named so a reader can go and check them. */
    companionChecks: z.array(z.strictObject({
      name: NonEmpty,
      finding: NonEmpty,
      provenBy: NonEmpty,
    })),
  }),
  limitations: z.array(NonEmpty).min(1),
  selfRunDisclosure: NonEmpty,
  verification: z.strictObject({
    bundleFormat: NonEmpty,
    checks: z.array(NonEmpty).min(1),
    command: NonEmpty,
    compatibleCommand: NonEmpty,
    readerAvailability: z.literal("available"),
    reportSha256: Sha256HexSchema,
    reportEnvelopeSha256: Sha256HexSchema,
  }),
  provenance: z.strictObject({
    runSha256: Sha256HexSchema,
    benchmarkSha256: Sha256HexSchema,
    matrixSha256: Sha256HexSchema,
    reportSha256: Sha256HexSchema,
    reportEnvelopeSha256: Sha256HexSchema,
    anchors: z.array(z.strictObject({
      subject: NonEmpty,
      provider: NonEmpty,
      recordSha256: Sha256HexSchema,
    })),
    siblingAnalyses: z.array(z.strictObject({
      method: NonEmpty,
      version: NonEmpty,
      reportSha256: Sha256HexSchema,
    })),
    companionBundles: z.array(z.strictObject({
      name: NonEmpty,
      runSha256: Sha256HexSchema,
      matrixSha256: Sha256HexSchema,
      bundleIdentity: Sha256HexSchema,
    })),
  }),
});

export type ReportPresentation = z.infer<typeof ReportPresentationSchema>;

/**
 * A presentation that does not parse, is not in its exact canonical encoding, or does not name this
 * bundle's own report. Thrown by the projection so both callers can turn it into their own typed
 * refusal — `record-integrity` in the product, a `report-presentation` check failure in the reader.
 */
export class ReportPresentationProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportPresentationProjectionError";
  }
}

export interface DeriveReportPresentationInput {
  readonly bytes: Uint8Array;
  /** The bundle's own sealed Report digest — the one the closure materialized from. */
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  /** The closure version this bundle declares, so the member cannot advertise another reader. */
  readonly bundleFormat: string;
}

/**
 * Parses the member and binds it to the bundle. Every refusal here is a substitution the reader
 * would otherwise have been shown: a foreign schema, re-encoded bytes, a presentation lifted from a
 * different report, or one advertising a closure this bundle is not on.
 */
export function deriveReportPresentation(input: DeriveReportPresentationInput): ReportPresentation {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch {
    throw new ReportPresentationProjectionError(`${REPORT_PRESENTATION_MEMBER} is not valid UTF-8 JSON`);
  }
  const schemaId = (raw as { readonly schema?: unknown } | null)?.schema;
  if (schemaId !== REPORT_PRESENTATION_SCHEMA_ID) {
    throw new ReportPresentationProjectionError(
      `unknown report presentation schema ${JSON.stringify(schemaId ?? null)}; expected ${REPORT_PRESENTATION_SCHEMA_ID}`,
    );
  }
  const parsed = ReportPresentationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ReportPresentationProjectionError(
      `${REPORT_PRESENTATION_MEMBER} does not satisfy ${REPORT_PRESENTATION_SCHEMA_ID}: `
      + `${issue?.path.join(".") ?? "(root)"} ${issue?.message ?? "is invalid"}`,
    );
  }
  if (!Buffer.from(canonicalJsonBytes(parsed.data)).equals(Buffer.from(input.bytes))) {
    throw new ReportPresentationProjectionError(
      `${REPORT_PRESENTATION_MEMBER} bytes are not the exact canonical encoding of the presentation they decode to`,
    );
  }
  const presentation = parsed.data;
  if (
    presentation.verification.reportSha256 !== input.reportSha256
    || presentation.provenance.reportSha256 !== input.reportSha256
  ) {
    throw new ReportPresentationProjectionError(
      `${REPORT_PRESENTATION_MEMBER} presents report ${presentation.provenance.reportSha256},`
      + ` but this bundle materializes report ${input.reportSha256}`,
    );
  }
  if (
    presentation.verification.reportEnvelopeSha256 !== input.reportEnvelopeSha256
    || presentation.provenance.reportEnvelopeSha256 !== input.reportEnvelopeSha256
  ) {
    throw new ReportPresentationProjectionError(
      `${REPORT_PRESENTATION_MEMBER} names a report envelope this bundle does not carry`,
    );
  }
  if (presentation.verification.bundleFormat !== input.bundleFormat) {
    throw new ReportPresentationProjectionError(
      `${REPORT_PRESENTATION_MEMBER} advertises ${presentation.verification.bundleFormat},`
      + ` but this bundle declares ${input.bundleFormat}`,
    );
  }
  return presentation;
}
