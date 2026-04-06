/**
 * Invariant utilities for explorer frontend.
 *
 * Re-exports shared utilities from @jinn/shared-ui.
 * Explorer-specific extensions can be added here.
 */

// Re-export everything from shared-ui
export {
  // Types
  type Invariant,
  type FloorInvariant,
  type CeilingInvariant,
  type RangeInvariant,
  type BooleanInvariant,
  type LegacyInvariant,
  type InvariantType,
  type InvariantMeasurement,
  type HealthStatus,
  type InvariantWithMeasurement,

  // Type guards
  isFloorInvariant,
  isCeilingInvariant,
  isRangeInvariant,
  isBooleanInvariant,
  isNewInvariant,
  isLegacyInvariant,

  // Parsing utilities
  parseInvariants,
  hasInvariants,

  // Display utilities
  getInvariantDisplayText,
  getLegacyInvariantText,
  renderInvariantAsProse,

  // Health status utilities
  determineHealthStatus,
  countByStatus,

  // Badge colors
  invariantTypeBadgeColors,
  healthStatusColors,
  getInvariantTypeBadgeColor,
  getHealthStatusColor,
} from '@jinn/shared-ui';

/**
 * Alias for backwards compatibility.
 * Use Invariant | LegacyInvariant instead for new code.
 */
export type InvariantItem = import('@jinn/shared-ui').Invariant | import('@jinn/shared-ui').LegacyInvariant;

/**
 * Alias for backwards compatibility.
 * Use getInvariantDisplayText instead for new code.
 */
export { getInvariantDisplayText as getInvariantText } from '@jinn/shared-ui';

/**
 * Alias for backwards compatibility.
 * Use renderInvariantAsProse instead for new code.
 */
export { renderInvariantAsProse as renderInvariantForDisplay } from '@jinn/shared-ui';
