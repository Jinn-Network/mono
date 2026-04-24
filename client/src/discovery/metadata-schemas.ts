/**
 * ERC-8004 Identity Registry metadata schemas.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md
 * §3.1 (K4 source bundle), §3.3 (three-registry separation, envelope registration row).
 *
 * Each entity kind registered on the Identity Registry (via `register(agentURI,
 * metadata[])`) emits a set of (metadataKey, metadataValue) tuples. These
 * schemas describe the structured object form before encoding to tuples. Used
 * both on the write side (producing the tuples for the on-chain call) and the
 * read side (parsing the tuples returned by the subgraph into typed objects).
 *
 * Encoding: metadataValue is hex-encoded UTF-8 bytes of the JSON-stringified
 * primitive value. Numbers and strings are stringified. Hex values stay
 * hex-encoded (no double-encoding).
 */

import { z } from 'zod';

const HexStringSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

// ── Intent metadata ─────────────────────────────────────────────────────────

export const IntentMetadataSchema = z.object({
  documentType: z.literal('adw:Intent'),
  kind: z.string().min(1),
  creator: HexStringSchema, // safe address
  createdAt: z.number().int(),
  requestId: HexStringSchema,
});
export type IntentMetadata = z.infer<typeof IntentMetadataSchema>;

// ── Envelope metadata ───────────────────────────────────────────────────────

export const EnvelopeMetadataSchema = z.object({
  documentType: z.literal('adw:ExecutionEnvelope'),
  kind: z.string().min(1),
  role: z.enum(['restoration', 'verdict']),
  evidenceTier: z.enum(['self-signed', 'committed', 'consensus', 'attested', 'proved']),
  intentCid: z.string().min(1),
  parentEnvelopeCid: z.string().optional(), // only verdict envelopes set this
  measurement: HexStringSchema.optional(), // only attested tier sets this
  participant: HexStringSchema, // safe address of operator
  generatedAt: z.number().int(),
});
export type EnvelopeMetadata = z.infer<typeof EnvelopeMetadataSchema>;

// ── Source bundle metadata ──────────────────────────────────────────────────

export const SourceBundleMetadataSchema = z.object({
  documentType: z.literal('adw:SourceBundle'),
  measurement: HexStringSchema,
  buildRecipeKind: z.enum(['dockerfile', 'nix', 'bazel']),
  publishedBy: HexStringSchema,
  humanUrl: z.string().optional(),
});
export type SourceBundleMetadata = z.infer<typeof SourceBundleMetadataSchema>;

// ── Artifact metadata (extended) ────────────────────────────────────────────

export const ArtifactMetadataSchema = z.object({
  documentType: z.literal('adw:Artifact'),
  artifactId: z.string().min(1),
  title: z.string(),
  tags: z.array(z.string()).or(z.string()), // tags may round-trip as JSON string
  outcome: z.string(),
  endpoint: z.string(),
  parentEnvelopeCid: z.string().optional(), // added in Plan E
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

// ── Tuple <-> object conversion ─────────────────────────────────────────────

export interface MetadataTuple {
  metadataKey: string;
  metadataValue: `0x${string}`;
}

function encodeValue(value: unknown): `0x${string}` {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return ('0x' + Buffer.from(s, 'utf8').toString('hex')) as `0x${string}`;
}

function decodeValue(hex: `0x${string}`): string {
  return Buffer.from(hex.slice(2), 'hex').toString('utf8');
}

/**
 * Convert a structured metadata object to the on-chain tuple array expected by
 * the Identity Registry's `register(uri, metadata[])`.
 */
export function metadataToTuple(metadata: Record<string, unknown>): MetadataTuple[] {
  return Object.entries(metadata)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ metadataKey: k, metadataValue: encodeValue(v) }));
}

/**
 * Parse a metadata tuple array into a typed object matching the supplied schema.
 *
 * Accepts both:
 *  - `{ metadataKey, metadataValue }` — the on-chain / `metadataToTuple` form
 *  - `{ key, value }` — the subgraph query response form
 *
 * `metadataValue` / `value` may be hex-encoded UTF-8 (on-chain) or a plain
 * string (subgraph). Hex strings are decoded before parsing.
 */
export function tupleToMetadata<T extends z.ZodType>(
  tuples: Array<{ key?: string; metadataKey?: string; value?: string; metadataValue?: string }>,
  schema: T,
): z.infer<T> {
  const obj: Record<string, unknown> = {};
  for (const t of tuples) {
    const key = t.key ?? t.metadataKey ?? '';
    const raw = t.value ?? t.metadataValue ?? '';
    // Decode hex if value looks like a hex string (from on-chain metadataValue).
    const decoded = raw.startsWith('0x') ? decodeValue(raw as `0x${string}`) : raw;
    // Attempt JSON.parse so that tags (array) round-trips; fall back to raw.
    try {
      obj[key] = JSON.parse(decoded);
    } catch {
      obj[key] = decoded;
    }
    // Numeric fields: coerce if the schema expects a number.
    if (key === 'createdAt' || key === 'generatedAt') {
      const n = Number(decoded);
      if (Number.isFinite(n)) obj[key] = n;
    }
  }
  return schema.parse(obj) as z.infer<T>;
}
