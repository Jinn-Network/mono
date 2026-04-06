/**
 * Invariant Type Definitions
 *
 * Four-type invariant schema for measurable agent constraints.
 */

// ============================================================================
// Core Invariant Types
// ============================================================================

export interface FloorInvariant {
  id: string;
  type: 'FLOOR';
  metric: string;
  min: number;
  assessment: string;
  examples?: { do: string[]; dont: string[] };
}

export interface CeilingInvariant {
  id: string;
  type: 'CEILING';
  metric: string;
  max: number;
  assessment: string;
  examples?: { do: string[]; dont: string[] };
}

export interface RangeInvariant {
  id: string;
  type: 'RANGE';
  metric: string;
  min: number;
  max: number;
  assessment: string;
  examples?: { do: string[]; dont: string[] };
}

export interface BooleanInvariant {
  id: string;
  type: 'BOOLEAN';
  condition: string;
  assessment: string;
  examples?: { do: string[]; dont: string[] };
}

export type Invariant = FloorInvariant | CeilingInvariant | RangeInvariant | BooleanInvariant;

export type InvariantType = 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';

// ============================================================================
// Legacy Invariant Type (for backward compatibility)
// ============================================================================

export interface LegacyInvariant {
  id: string;
  invariant?: string;
  assertion?: string;
  measurement?: string;
  description?: string;
  commentary?: string;
  examples?: { do?: string[]; dont?: string[] };
}

// ============================================================================
// Type Guards
// ============================================================================

export function isFloorInvariant(inv: Invariant | LegacyInvariant): inv is FloorInvariant {
  return 'type' in inv && inv.type === 'FLOOR';
}

export function isCeilingInvariant(inv: Invariant | LegacyInvariant): inv is CeilingInvariant {
  return 'type' in inv && inv.type === 'CEILING';
}

export function isRangeInvariant(inv: Invariant | LegacyInvariant): inv is RangeInvariant {
  return 'type' in inv && inv.type === 'RANGE';
}

export function isBooleanInvariant(inv: Invariant | LegacyInvariant): inv is BooleanInvariant {
  return 'type' in inv && inv.type === 'BOOLEAN';
}

export function isNewInvariant(inv: Invariant | LegacyInvariant): inv is Invariant {
  return 'type' in inv && ['FLOOR', 'CEILING', 'RANGE', 'BOOLEAN'].includes(inv.type);
}

export function isLegacyInvariant(inv: Invariant | LegacyInvariant): inv is LegacyInvariant {
  return !('type' in inv) || !['FLOOR', 'CEILING', 'RANGE', 'BOOLEAN'].includes((inv as any).type);
}

// ============================================================================
// Measurement Types
// ============================================================================

export interface InvariantMeasurement {
  invariantId: string;
  score: number | boolean;
  context?: string;
  timestamp: string;
}

/**
 * Structured measurement payload from create_measurement tool.
 * Includes computed pass/fail and type-specific fields.
 */
export interface StructuredMeasurement {
  invariant_id: string;
  invariant_type: 'FLOOR' | 'CEILING' | 'RANGE' | 'BOOLEAN';
  score: number | boolean;
  measured_value?: number;
  threshold?: { min?: number; max?: number };
  passed: boolean;
  context: string;
  timestamp?: string;
}

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export interface InvariantWithMeasurement {
  invariant: Invariant | LegacyInvariant;
  measurement?: InvariantMeasurement;
  status: HealthStatus;
}
