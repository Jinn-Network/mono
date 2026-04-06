/**
 * Invariant Utilities
 *
 * Parsing, rendering, and health status functions for invariants.
 */

import type {
  Invariant,
  LegacyInvariant,
  InvariantType,
  InvariantMeasurement,
  StructuredMeasurement,
  HealthStatus,
  FloorInvariant,
  CeilingInvariant,
  RangeInvariant,
  BooleanInvariant,
  InvariantWithMeasurement,
} from './invariant-types';

import {
  isFloorInvariant,
  isCeilingInvariant,
  isRangeInvariant,
  isBooleanInvariant,
  isNewInvariant,
} from './invariant-types';

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse invariants from blueprint JSON.
 * Supports both new 4-type schema and legacy schema.
 */
export function parseInvariants(blueprintJson: unknown): (Invariant | LegacyInvariant)[] {
  if (!blueprintJson || typeof blueprintJson !== 'object') return [];

  const obj = blueprintJson as Record<string, unknown>;
  const items = obj.invariants || obj.assertions;

  if (Array.isArray(items)) {
    return items as (Invariant | LegacyInvariant)[];
  }
  return [];
}

/**
 * Check if blueprint has invariants.
 */
export function hasInvariants(blueprintJson: unknown): boolean {
  return parseInvariants(blueprintJson).length > 0;
}

/**
 * Check if invariant is a system (SYS-*) invariant.
 */
export function isSystemInvariant(inv: Invariant | LegacyInvariant): boolean {
  return typeof inv.id === 'string' && inv.id.startsWith('SYS-');
}

// ============================================================================
// Display Text
// ============================================================================

/**
 * Get the primary display text for any invariant type.
 */
export function getInvariantDisplayText(inv: Invariant | LegacyInvariant): string {
  if (isNewInvariant(inv)) {
    if (isBooleanInvariant(inv)) {
      return inv.condition;
    }
    // For metric-based types, construct a readable description
    if (isFloorInvariant(inv)) {
      return `${inv.metric} must be at least ${inv.min}`;
    }
    if (isCeilingInvariant(inv)) {
      return `${inv.metric} must be at most ${inv.max}`;
    }
    if (isRangeInvariant(inv)) {
      return `${inv.metric} must be between ${inv.min} and ${inv.max}`;
    }
  }

  // Legacy invariant
  const legacy = inv as LegacyInvariant;
  return legacy.invariant || legacy.assertion || '';
}

/**
 * Get legacy invariant text (for backward compatibility).
 */
export function getLegacyInvariantText(inv: LegacyInvariant): string {
  return inv.invariant || inv.assertion || '';
}

// ============================================================================
// Prose Rendering
// ============================================================================

/**
 * Render an invariant as natural language prose for LLM consumption.
 */
export function renderInvariantAsProse(inv: Invariant | LegacyInvariant): string {
  if (!isNewInvariant(inv)) {
    const legacy = inv as LegacyInvariant;
    let prose = `[${legacy.id}] ${getLegacyInvariantText(legacy)}`;
    if (legacy.measurement) {
      prose += `\nMeasurement: ${legacy.measurement}`;
    }
    return prose;
  }

  const lines: string[] = [];

  if (isFloorInvariant(inv)) {
    lines.push(`[${inv.id}] FLOOR constraint: ${inv.metric} must be at least ${inv.min}.`);
    lines.push(`Assessment: ${inv.assessment}`);
  } else if (isCeilingInvariant(inv)) {
    lines.push(`[${inv.id}] CEILING constraint: ${inv.metric} must not exceed ${inv.max}.`);
    lines.push(`Assessment: ${inv.assessment}`);
  } else if (isRangeInvariant(inv)) {
    lines.push(`[${inv.id}] RANGE constraint: ${inv.metric} must be between ${inv.min} and ${inv.max}.`);
    lines.push(`Assessment: ${inv.assessment}`);
  } else if (isBooleanInvariant(inv)) {
    lines.push(`[${inv.id}] BOOLEAN constraint: ${inv.condition}`);
    lines.push(`Assessment: ${inv.assessment}`);
  }

  if (inv.examples) {
    if (inv.examples.do && inv.examples.do.length > 0) {
      lines.push(`Do: ${inv.examples.do.join('; ')}`);
    }
    if (inv.examples.dont && inv.examples.dont.length > 0) {
      lines.push(`Don't: ${inv.examples.dont.join('; ')}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Health Status
// ============================================================================

/**
 * Determine health status based on invariant type and measurement.
 */
export function determineHealthStatus(
  inv: Invariant | LegacyInvariant,
  measurement?: InvariantMeasurement
): HealthStatus {
  if (!measurement) return 'unknown';

  const { score } = measurement;

  // Boolean score
  if (typeof score === 'boolean') {
    return score ? 'healthy' : 'critical';
  }

  // Numeric score with type-specific thresholds
  if (isNewInvariant(inv)) {
    if (isFloorInvariant(inv)) {
      if (score >= inv.min) return 'healthy';
      if (score >= inv.min * 0.8) return 'warning';
      return 'critical';
    }

    if (isCeilingInvariant(inv)) {
      if (score <= inv.max) return 'healthy';
      if (score <= inv.max * 1.2) return 'warning';
      return 'critical';
    }

    if (isRangeInvariant(inv)) {
      if (score >= inv.min && score <= inv.max) return 'healthy';
      const range = inv.max - inv.min;
      const buffer = range * 0.1;
      if (score >= inv.min - buffer && score <= inv.max + buffer) return 'warning';
      return 'critical';
    }

    // Boolean type but numeric score - treat as percentage
    if (isBooleanInvariant(inv)) {
      if (score >= 70) return 'healthy';
      if (score >= 40) return 'warning';
      return 'critical';
    }
  }

  // Legacy or unknown - use default thresholds
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'warning';
  return 'critical';
}

/**
 * Count invariants by health status.
 */
export function countByStatus(
  items: Array<{ status: HealthStatus }>
): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = {
    healthy: 0,
    warning: 0,
    critical: 0,
    unknown: 0,
  };

  for (const item of items) {
    counts[item.status]++;
  }

  return counts;
}

// ============================================================================
// Type Badge Colors
// ============================================================================

export const invariantTypeBadgeColors: Record<InvariantType, string> = {
  FLOOR: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  CEILING: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  RANGE: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  BOOLEAN: 'bg-green-500/10 text-green-500 border-green-500/20',
};

export const healthStatusColors: Record<HealthStatus, string> = {
  healthy: 'bg-green-500/10 text-green-500 border-green-500/20',
  warning: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  critical: 'bg-red-500/10 text-red-500 border-red-500/20',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

/**
 * Get badge color for invariant type.
 */
export function getInvariantTypeBadgeColor(type: InvariantType): string {
  return invariantTypeBadgeColors[type] || 'bg-muted text-muted-foreground';
}

/**
 * Get badge color for health status.
 */
export function getHealthStatusColor(status: HealthStatus): string {
  return healthStatusColors[status];
}

// ============================================================================
// Measurement Parsing
// ============================================================================

/**
 * Minimal artifact shape needed for measurement parsing.
 * Compatible with both Ponder and subgraph artifact types.
 */
export type MeasurementArtifact = {
  id: string;
  contentPreview?: string | null;
  blockTimestamp?: string | bigint | null;
};

/**
 * Type guard for structured measurement format (from create_measurement tool).
 * Note: DELEGATED type is deprecated and will not match.
 */
function isStructuredMeasurement(data: unknown): data is StructuredMeasurement {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.invariant_id === 'string' &&
    typeof obj.invariant_type === 'string' &&
    ['FLOOR', 'CEILING', 'RANGE', 'BOOLEAN'].includes(obj.invariant_type as string) &&
    typeof obj.passed === 'boolean'
  );
}

/**
 * Parse measurement from artifact contentPreview JSON.
 * Supports both new structured format and legacy format.
 * Also handles truncated JSON (contentPreview may be limited to 100 chars).
 *
 * @param artifact - Artifact with contentPreview field
 * @returns StructuredMeasurement if valid, null otherwise
 */
export function parseMeasurement(artifact: MeasurementArtifact): StructuredMeasurement | null {
  if (!artifact.contentPreview) return null;

  const content = artifact.contentPreview;
  const timestamp = artifact.blockTimestamp
    ? typeof artifact.blockTimestamp === 'bigint'
      ? new Date(Number(artifact.blockTimestamp) * 1000).toISOString()
      : artifact.blockTimestamp
    : undefined;

  // Try to parse as complete JSON first
  try {
    const data = JSON.parse(content);

    // Handle new structured format (from create_measurement tool)
    if (isStructuredMeasurement(data)) {
      return { ...data, timestamp };
    }

    // Handle legacy format (from create_artifact with manual JSON)
    if (data.invariant_id && (data.score !== undefined || data.passed !== undefined)) {
      const score = data.score ?? data.passed;
      const passed = typeof score === 'boolean' ? score : (score >= 0);

      return {
        invariant_id: data.invariant_id,
        invariant_type: typeof score === 'boolean' ? 'BOOLEAN' : 'FLOOR',
        score,
        passed,
        context: data.context || '',
        timestamp,
      };
    }

    return null;
  } catch {
    // JSON parsing failed - content is likely truncated
    // Try to extract fields using regex patterns
    return parseTruncatedMeasurement(content, timestamp);
  }
}

/**
 * Extract measurement data from truncated JSON using regex.
 * contentPreview is often limited to 100 chars, truncating the JSON.
 */
function parseTruncatedMeasurement(
  content: string,
  timestamp?: string
): StructuredMeasurement | null {
  // Extract invariant_id: "SOME-ID"
  const idMatch = content.match(/"invariant_id":\s*"([^"]+)"/);
  if (!idMatch) return null;

  const invariant_id = idMatch[1];

  // Extract invariant_type if present (prefer explicit type over inference)
  // Note: DELEGATED type is deprecated and will be ignored
  const typeMatch = content.match(/"invariant_type":\s*"(FLOOR|CEILING|RANGE|BOOLEAN)"/);
  const explicitType = typeMatch
    ? (typeMatch[1] as 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN')
    : null;

  // Extract score/passed - try multiple patterns
  // "score": true/false or "score": 85 or "passed": true/false
  const boolScoreMatch = content.match(/"(?:score|passed)":\s*(true|false)/);
  const numScoreMatch = content.match(/"(?:score|measured_value)":\s*(\d+(?:\.\d+)?)/);

  let score: boolean | number;
  let passed: boolean;
  let invariant_type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';

  if (boolScoreMatch) {
    score = boolScoreMatch[1] === 'true';
    passed = score as boolean;
    // Use explicit type if available, otherwise infer BOOLEAN
    invariant_type = explicitType || 'BOOLEAN';
  } else if (numScoreMatch) {
    score = parseFloat(numScoreMatch[1]);
    passed = score >= 0; // Assume positive scores pass
    // Use explicit type if available, otherwise infer FLOOR
    invariant_type = explicitType || 'FLOOR';
  } else {
    // No score found, assume passed based on context
    score = true;
    passed = true;
    invariant_type = explicitType || 'BOOLEAN';
  }

  // Try to extract context (likely truncated)
  const contextMatch = content.match(/"context":\s*"([^"]*)/);
  const context = contextMatch ? contextMatch[1] : '';

  return {
    invariant_id,
    invariant_type,
    score,
    passed,
    context,
    timestamp,
  };
}

/**
 * Convert StructuredMeasurement to InvariantMeasurement for compatibility.
 */
export function toInvariantMeasurement(structured: StructuredMeasurement): InvariantMeasurement {
  return {
    invariantId: structured.invariant_id,
    score: structured.score,
    context: structured.context,
    timestamp: structured.timestamp || new Date().toISOString(),
  };
}

// ============================================================================
// Invariant + Measurement Matching
// ============================================================================

/**
 * Extended invariant with measurement for display purposes.
 * Adds convenience fields beyond the base InvariantWithMeasurement type.
 */
export interface InvariantWithMeasurementDisplay extends InvariantWithMeasurement {
  id: string;
  text: string;
}

/**
 * Match invariants with their latest measurements from artifacts.
 * Artifacts should be sorted descending by timestamp (newest first).
 */
export function matchInvariantsWithMeasurements(
  invariants: (Invariant | LegacyInvariant)[],
  artifacts: MeasurementArtifact[]
): InvariantWithMeasurementDisplay[] {
  // Parse all measurements from artifacts
  const measurements = new Map<string, InvariantMeasurement>();
  for (const artifact of artifacts) {
    const structured = parseMeasurement(artifact);
    if (structured) {
      // Keep the first (latest) measurement for each invariant
      if (!measurements.has(structured.invariant_id)) {
        measurements.set(structured.invariant_id, toInvariantMeasurement(structured));
      }
    }
  }

  const displayInvariants = invariants.filter(inv => !isSystemInvariant(inv));

  // Match each invariant with its measurement
  return displayInvariants.map(inv => {
    const measurement = measurements.get(inv.id);
    const status = determineHealthStatus(inv, measurement);
    return {
      id: inv.id,
      invariant: inv,
      text: getInvariantDisplayText(inv),
      measurement,
      status
    };
  });
}
