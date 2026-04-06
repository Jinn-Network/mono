import { z } from 'zod';
import { pushJsonToIpfs } from '@jinn-network/mech-client-ts/dist/ipfs.js';
import { createHash } from 'crypto';

// ============================================================================
// Type-Specific Measurement Schemas (Discriminated Union)
// ============================================================================

const floorMeasurementSchema = z.object({
  invariant_type: z.literal('FLOOR'),
  invariant_id: z.string().min(1).describe('The invariant ID being measured'),
  measured_value: z.number().describe('Actual numeric value measured'),
  min_threshold: z.number().describe('The min threshold from the invariant'),
  context: z.string().min(1).describe('Explanation of the measurement'),
  idempotencyKey: z.string().min(1).optional(),
});

const ceilingMeasurementSchema = z.object({
  invariant_type: z.literal('CEILING'),
  invariant_id: z.string().min(1).describe('The invariant ID being measured'),
  measured_value: z.number().describe('Actual numeric value measured'),
  max_threshold: z.number().describe('The max threshold from the invariant'),
  context: z.string().min(1).describe('Explanation of the measurement'),
  idempotencyKey: z.string().min(1).optional(),
});

const rangeMeasurementSchema = z.object({
  invariant_type: z.literal('RANGE'),
  invariant_id: z.string().min(1).describe('The invariant ID being measured'),
  measured_value: z.number().describe('Actual numeric value measured'),
  min_threshold: z.number().describe('The min threshold from the invariant'),
  max_threshold: z.number().describe('The max threshold from the invariant'),
  context: z.string().min(1).describe('Explanation of the measurement'),
  idempotencyKey: z.string().min(1).optional(),
});

const booleanMeasurementSchema = z.object({
  invariant_type: z.literal('BOOLEAN'),
  invariant_id: z.string().min(1).describe('The invariant ID being measured'),
  passed: z.boolean().describe('Whether the condition was satisfied'),
  context: z.string().min(1).describe('Explanation of the measurement'),
  idempotencyKey: z.string().min(1).optional(),
});

export const createMeasurementParams = z.discriminatedUnion('invariant_type', [
  floorMeasurementSchema,
  ceilingMeasurementSchema,
  rangeMeasurementSchema,
  booleanMeasurementSchema,
]);

// All possible properties for MCP schema - must include all fields Gemini might send
export const createMeasurementFlatParams = z.object({
  invariant_type: z.string().optional(),
  invariant_id: z.string().optional(),
  measured_value: z.number().optional(),
  min_threshold: z.number().optional(),
  max_threshold: z.number().optional(),
  passed: z.boolean().optional(),
  context: z.string().optional(),
  // Common fields Gemini might add
  type: z.string().optional(),
  score: z.union([z.number(), z.boolean()]).optional(),
  value: z.number().optional(),
  threshold: z.any().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export type CreateMeasurementParams = z.infer<typeof createMeasurementParams>;

// ============================================================================
// Standardized Measurement Payload
// ============================================================================

interface MeasurementPayload {
  invariant_id: string;
  invariant_type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  score: number | boolean;
  measured_value?: number;
  threshold?: { min?: number; max?: number };
  passed: boolean;
  context: string;
}

type MeasurementResult = {
  cid: string;
  name: string;
  topic: 'MEASUREMENT';
  contentPreview: string;
  invariant_id: string;
  passed: boolean;
  warnings?: string[];
};

const measurementDedupeCache = new Map<string, MeasurementResult>();

function getMeasurementDedupeKey(
  params: CreateMeasurementParams,
  payload: MeasurementPayload
): string {
  const requestId = process.env.JINN_CTX_REQUEST_ID || process.env.JINN_CTX_WORKSTREAM_ID || 'unknown_request';
  const idempotencyKey = (params as any).idempotencyKey;
  const stablePart = typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0
    ? idempotencyKey.trim()
    : createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${requestId}:${params.invariant_type}:${params.invariant_id}:${stablePart}`;
}

// ============================================================================
// Schema for MCP Registration
// ============================================================================

export const createMeasurementSchema = {
  description: `Creates a structured measurement artifact for an invariant. Computes pass/fail automatically based on type.

IMPORTANT: Use the EXACT invariant ID from your blueprint (e.g., "GOAL-CONTENT", "GOAL-MISSION").
Do NOT invent custom IDs - the measurement must match an existing invariant ID to be displayed correctly.

INVARIANT TYPES:
- FLOOR: measured_value >= min_threshold (e.g., min 3 posts)
- CEILING: measured_value <= max_threshold (e.g., max 100ms)
- RANGE: measured_value between min and max
- BOOLEAN: passed true/false

Examples:
- FLOOR: { invariant_type: 'FLOOR', invariant_id: 'GOAL-CONTENT', measured_value: 85, min_threshold: 70, context: 'Content quality score 85/100' }
- BOOLEAN: { invariant_type: 'BOOLEAN', invariant_id: 'GOAL-MISSION', passed: true, context: 'Content aligns with mission' }`,
  inputSchema: createMeasurementFlatParams.shape,
};

// ============================================================================
// Handler
// ============================================================================

function computePassFail(params: CreateMeasurementParams): boolean {
  switch (params.invariant_type) {
    case 'FLOOR':
      return params.measured_value >= params.min_threshold;
    case 'CEILING':
      return params.measured_value <= params.max_threshold;
    case 'RANGE':
      return params.measured_value >= params.min_threshold && params.measured_value <= params.max_threshold;
    case 'BOOLEAN':
      return params.passed;
  }
}

function buildPayload(params: CreateMeasurementParams): MeasurementPayload {
  const passed = computePassFail(params);
  const context = params.context || 'No context provided';

  switch (params.invariant_type) {
    case 'FLOOR':
      return {
        invariant_id: params.invariant_id,
        invariant_type: 'FLOOR',
        score: params.measured_value,
        measured_value: params.measured_value,
        threshold: { min: params.min_threshold },
        passed,
        context,
      };
    case 'CEILING':
      return {
        invariant_id: params.invariant_id,
        invariant_type: 'CEILING',
        score: params.measured_value,
        measured_value: params.measured_value,
        threshold: { max: params.max_threshold },
        passed,
        context,
      };
    case 'RANGE':
      return {
        invariant_id: params.invariant_id,
        invariant_type: 'RANGE',
        score: params.measured_value,
        measured_value: params.measured_value,
        threshold: { min: params.min_threshold, max: params.max_threshold },
        passed,
        context,
      };
    case 'BOOLEAN':
      return {
        invariant_id: params.invariant_id,
        invariant_type: 'BOOLEAN',
        score: params.passed,
        passed,
        context,
      };
  }
}

export async function createMeasurement(args: unknown) {
  try {
    const parsed = createMeasurementParams.safeParse(args);
    if (!parsed.success) {
      // Build instructive error from Zod issues
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      const hint = 'Required fields by type — FLOOR: {invariant_type, invariant_id, measured_value, min_threshold, context}, ' +
        'CEILING: {invariant_type, invariant_id, measured_value, max_threshold, context}, ' +
        'RANGE: {invariant_type, invariant_id, measured_value, min_threshold, max_threshold, context}, ' +
        'BOOLEAN: {invariant_type, invariant_id, passed, context}';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            data: null,
            meta: { ok: false, code: 'VALIDATION_ERROR', message: `Validation failed: ${issues}. ${hint}` }
          })
        }]
      };
    }

    const payload = buildPayload(parsed.data);
    const dedupeKey = getMeasurementDedupeKey(parsed.data, payload);
    const cached = measurementDedupeCache.get(dedupeKey);
    if (cached) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ data: cached, meta: { ok: true, deduped: true } })
        }]
      };
    }
    const artifactName = `Measurement: ${payload.invariant_id}`;

    // Validate invariant_id against known blueprint IDs
    const warnings: string[] = [];
    const knownIdsRaw = process.env.JINN_CTX_BLUEPRINT_INVARIANT_IDS;
    if (knownIdsRaw) {
      try {
        const knownIds: string[] = JSON.parse(knownIdsRaw);
        if (knownIds.length > 0 && !knownIds.includes(payload.invariant_id)) {
          warnings.push(
            `invariant_id "${payload.invariant_id}" does not match any mission invariant in the blueprint. ` +
            `Known IDs: ${knownIds.join(', ')}. The measurement was still created but may not be tracked.`
          );
        }
      } catch { /* ignore parse errors */ }
    }

    // Upload to IPFS with standardized structure
    const ipfsPayload = {
      name: artifactName,
      topic: 'MEASUREMENT',
      content: JSON.stringify(payload),
      mimeType: 'application/json',
    };

    const [, cidHex] = await pushJsonToIpfs(ipfsPayload);
    const contentPreview = JSON.stringify(payload).slice(0, 100);

    const result: MeasurementResult = {
      cid: cidHex,
      name: artifactName,
      topic: 'MEASUREMENT',
      contentPreview,
      invariant_id: payload.invariant_id,
      passed: payload.passed,
    };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    measurementDedupeCache.set(dedupeKey, result);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ data: result, meta: { ok: true } })
      }]
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ data: null, meta: { ok: false, code: 'EXECUTION_ERROR', message } })
      }]
    };
  }
}
