import { z } from "zod";

import { isHttpToken } from "./ascii.js";
import { topLevelRecordSchema } from "./extensions.js";
import { INFORMATION_WORLD_KIND } from "./identifiers.js";
import { compareCodeUnitStrings } from "./order.js";
import { canonicalRequestKeyFromParts } from "./request-key.js";
import { RequestKeyPolicySchema, assertRequestKeyPolicy } from "./request-key-policy.js";
import { parseExactWithSchema, sealWithSchema } from "./sealing.js";

const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const REQUEST_KEY = /^irk1:[0-9a-f]{64}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A closed world carries its miss response in its own sealed bytes (CF6-3). */
export const MISS_BODY_MAX_BYTES = 4096;

const encoder = new TextEncoder();

/** A byte-bearing dependency. Its digest is identity; a URI, when present, is only a locator. */
export const ResourceDescriptorSchema = z.strictObject({
  digest: z.string().regex(PREFIXED_SHA256),
  mediaType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  uri: z.string().min(1).optional(),
});

const HeaderNameSchema = z.string().refine(isHttpToken, {
  message: "field names are lowercase RFC 9110 tokens",
});

const QueryPairSchema = z.union([
  z.tuple([z.string()]),
  z.tuple([z.string(), z.string()]),
]);

/** Stored request parts are checked again by the Task 6 canonical-parts boundary at sealing. */
export const CanonicalRequestPartsSchema = z.strictObject({
  method: z.string().min(1),
  origin: z.string().min(1),
  path: z.string().startsWith("/"),
  query: z.array(QueryPairSchema),
  headers: z.record(HeaderNameSchema, z.array(z.string())),
  body: z.string().regex(PREFIXED_SHA256).nullable(),
});

export const CorpusEntrySchema = z.strictObject({
  requestKey: z.string().regex(REQUEST_KEY),
  request: CanonicalRequestPartsSchema,
  response: z.strictObject({
    status: z.number().int().min(100).max(599),
    headers: z.array(z.tuple([HeaderNameSchema, z.string()])),
    body: ResourceDescriptorSchema,
  }),
});

export const MissPolicySchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  headers: z.array(z.tuple([HeaderNameSchema, z.string()])),
  body: z.strictObject({
    inlineUtf8: z.string(),
    mediaType: z.string().min(1),
  }),
  reason: z.string().min(1),
});

export const CaptureProvenanceSchema = z.strictObject({
  fidelity: z.enum(["synthetic", "captured-snapshot"]),
  provenanceClass: z.literal("declared"),
  capturedAt: z.string().regex(RFC3339_UTC).optional(),
  capturer: ResourceDescriptorSchema.optional(),
  sources: z.array(z.strictObject({
    origin: z.string().min(1),
    capturedAt: z.string().regex(RFC3339_UTC),
    note: z.string().optional(),
  })).optional(),
});

const informationWorldShape = {
  kind: z.literal(INFORMATION_WORLD_KIND),
  requestKeyPolicy: RequestKeyPolicySchema,
  corpus: z.strictObject({
    origins: z.array(z.string().min(1)),
    entries: z.array(CorpusEntrySchema),
  }),
  missPolicy: MissPolicySchema,
  capture: CaptureProvenanceSchema,
  /** Static lineage pointer for a re-capture, never mutable record status. */
  supersedes: ResourceDescriptorSchema.optional(),
};

type CoreRecord = z.infer<z.ZodObject<typeof informationWorldShape>>;
type IssueContext = {
  addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void;
};

function checkCorpus(record: CoreRecord, ctx: IssueContext): void {
  const { requestKeyPolicy: policy, corpus } = record;
  try {
    assertRequestKeyPolicy(policy);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["requestKeyPolicy"],
      message: error instanceof Error ? error.message : "invalid request-key policy",
    });
    return;
  }

  const declaredHeaders = new Set(policy.headerSubset);
  const declaredOrigins = new Set(corpus.origins);
  for (let index = 1; index < corpus.origins.length; index += 1) {
    if (compareCodeUnitStrings(corpus.origins[index - 1] as string, corpus.origins[index] as string) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["corpus", "origins", index],
        message: "declared origins must be strictly ascending by code unit",
      });
    }
  }

  corpus.entries.forEach((entry, index) => {
    const path = ["corpus", "entries", index] as (string | number)[];
    for (const name of Object.keys(entry.request.headers)) {
      if (!declaredHeaders.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "request", "headers", name],
          message: `header "${name}" is not in the declared request-key header subset`,
        });
      }
    }

    if (!declaredOrigins.has(entry.request.origin)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "request", "origin"],
        message: `origin "${entry.request.origin}" is not declared in corpus.origins`,
      });
    }

    let recomputed: string;
    try {
      recomputed = canonicalRequestKeyFromParts(entry.request, policy);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "request"],
        message: error instanceof Error ? error.message : "request parts are not canonical",
      });
      return;
    }
    if (recomputed !== entry.requestKey) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "requestKey"],
        message: "declared request key does not match the canonical key of this entry's request parts",
      });
    }

    if (index === 0) return;
    const previous = corpus.entries[index - 1] as { requestKey: string };
    const order = compareCodeUnitStrings(previous.requestKey, entry.requestKey);
    if (order === 0) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "requestKey"],
        message: "two corpus entries resolve to the same request key",
      });
    } else if (order > 0) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "requestKey"],
        message: "corpus entries must be strictly ascending by request key",
      });
    }
  });
}

function checkMissPolicy(missPolicy: z.infer<typeof MissPolicySchema>, ctx: IssueContext): void {
  if (missPolicy.status >= 300 && missPolicy.status <= 399) {
    ctx.addIssue({
      code: "custom",
      path: ["missPolicy", "status"],
      message: "the declared miss response must not redirect outside the sealed world",
    });
  }
  const size = encoder.encode(missPolicy.body.inlineUtf8).length;
  if (size > MISS_BODY_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: ["missPolicy", "body", "inlineUtf8"],
      message: `the inline miss body must be at most ${MISS_BODY_MAX_BYTES} bytes; it is ${size}`,
    });
  }
}

function checkCapture(capture: z.infer<typeof CaptureProvenanceSchema>, ctx: IssueContext): void {
  const claims = [capture.capturedAt, capture.capturer, capture.sources];
  if (capture.fidelity === "synthetic") {
    if (claims.some((value) => value !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["capture"],
        message: "a synthetic corpus must not carry capture provenance",
      });
    }
    return;
  }
  if (capture.capturedAt === undefined || capture.capturer === undefined
    || capture.sources === undefined || capture.sources.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["capture"],
      message: "a captured-snapshot corpus must declare its capture time, pinned capturer, and sources",
    });
  }
}

export const InformationWorldRecordSchema = topLevelRecordSchema(informationWorldShape)
  .superRefine((record, ctx) => {
    checkCorpus(record as CoreRecord, ctx as IssueContext);
    checkMissPolicy((record as CoreRecord).missPolicy, ctx as IssueContext);
    checkCapture((record as CoreRecord).capture, ctx as IssueContext);
  });

export type InformationWorldRecord = z.infer<typeof InformationWorldRecordSchema>;
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;
export type MissPolicy = z.infer<typeof MissPolicySchema>;

/** Validate and canonicalize the record once; those bytes are the durable record. */
export function sealInformationWorldRecord(record: unknown): Uint8Array {
  return sealWithSchema(InformationWorldRecordSchema, record);
}

/** Parse only the one exact canonical encoding, never a merely equivalent JSON document. */
export function parseInformationWorldRecord(bytes: Uint8Array): InformationWorldRecord {
  return parseExactWithSchema(InformationWorldRecordSchema, bytes);
}
