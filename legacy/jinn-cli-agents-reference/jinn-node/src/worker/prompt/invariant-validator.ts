/**
 * Invariant Validator
 *
 * Validates that invariants conform to the four-type schema.
 * Provides clear error messages for invalid blueprints.
 */

import type {
  Invariant,
  FloorInvariant,
  CeilingInvariant,
  RangeInvariant,
  BooleanInvariant,
  InvariantExamples,
} from './types.js';

/**
 * Validation error with context
 */
export class InvariantValidationError extends Error {
  constructor(
    message: string,
    public readonly invariantId: string | undefined,
    public readonly field: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'InvariantValidationError';
  }
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: InvariantValidationError[];
  invariant?: Invariant;
}

/**
 * Validate a single invariant
 *
 * @throws InvariantValidationError if invalid
 */
export function validateInvariant(input: unknown): Invariant {
  // Must be an object
  if (typeof input !== 'object' || input === null) {
    throw new InvariantValidationError(
      'Invariant must be an object',
      undefined,
      'root'
    );
  }

  const obj = input as Record<string, unknown>;

  // Must have id
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    throw new InvariantValidationError(
      'Invariant must have a non-empty string "id" field',
      undefined,
      'id'
    );
  }

  const id = obj.id as string;

  // Must have type
  if (typeof obj.type !== 'string') {
    throw new InvariantValidationError(
      `Invariant "${id}" must have a "type" field (FLOOR, CEILING, RANGE, or BOOLEAN)`,
      id,
      'type'
    );
  }

  const type = obj.type as string;

  // Validate based on type
  switch (type) {
    case 'FLOOR':
      return validateFloorInvariant(id, obj);
    case 'CEILING':
      return validateCeilingInvariant(id, obj);
    case 'RANGE':
      return validateRangeInvariant(id, obj);
    case 'BOOLEAN':
      return validateBooleanInvariant(id, obj);
    default:
      throw new InvariantValidationError(
        `Invariant "${id}" has invalid type "${type}". Must be FLOOR, CEILING, RANGE, or BOOLEAN`,
        id,
        'type',
        { providedType: type }
      );
  }
}

/**
 * Validate a FloorInvariant
 */
function validateFloorInvariant(
  id: string,
  obj: Record<string, unknown>
): FloorInvariant {
  // metric: required string
  if (typeof obj.metric !== 'string' || obj.metric.trim() === '') {
    throw new InvariantValidationError(
      `FLOOR invariant "${id}" must have a non-empty "metric" field`,
      id,
      'metric'
    );
  }

  // min: required number
  if (typeof obj.min !== 'number' || isNaN(obj.min)) {
    throw new InvariantValidationError(
      `FLOOR invariant "${id}" must have a numeric "min" field`,
      id,
      'min',
      { providedValue: obj.min }
    );
  }

  // assessment: required string
  if (typeof obj.assessment !== 'string' || obj.assessment.trim() === '') {
    throw new InvariantValidationError(
      `FLOOR invariant "${id}" must have a non-empty "assessment" field describing how to measure`,
      id,
      'assessment'
    );
  }

  return {
    id,
    type: 'FLOOR',
    metric: obj.metric as string,
    min: obj.min as number,
    assessment: obj.assessment as string,
    examples: validateExamples(id, obj.examples),
  };
}

/**
 * Validate a CeilingInvariant
 */
function validateCeilingInvariant(
  id: string,
  obj: Record<string, unknown>
): CeilingInvariant {
  // metric: required string
  if (typeof obj.metric !== 'string' || obj.metric.trim() === '') {
    throw new InvariantValidationError(
      `CEILING invariant "${id}" must have a non-empty "metric" field`,
      id,
      'metric'
    );
  }

  // max: required number
  if (typeof obj.max !== 'number' || isNaN(obj.max)) {
    throw new InvariantValidationError(
      `CEILING invariant "${id}" must have a numeric "max" field`,
      id,
      'max',
      { providedValue: obj.max }
    );
  }

  // assessment: required string
  if (typeof obj.assessment !== 'string' || obj.assessment.trim() === '') {
    throw new InvariantValidationError(
      `CEILING invariant "${id}" must have a non-empty "assessment" field describing how to measure`,
      id,
      'assessment'
    );
  }

  return {
    id,
    type: 'CEILING',
    metric: obj.metric as string,
    max: obj.max as number,
    assessment: obj.assessment as string,
    examples: validateExamples(id, obj.examples),
  };
}

/**
 * Validate a RangeInvariant
 */
function validateRangeInvariant(
  id: string,
  obj: Record<string, unknown>
): RangeInvariant {
  // metric: required string
  if (typeof obj.metric !== 'string' || obj.metric.trim() === '') {
    throw new InvariantValidationError(
      `RANGE invariant "${id}" must have a non-empty "metric" field`,
      id,
      'metric'
    );
  }

  // min: required number
  if (typeof obj.min !== 'number' || isNaN(obj.min)) {
    throw new InvariantValidationError(
      `RANGE invariant "${id}" must have a numeric "min" field`,
      id,
      'min',
      { providedValue: obj.min }
    );
  }

  // max: required number
  if (typeof obj.max !== 'number' || isNaN(obj.max)) {
    throw new InvariantValidationError(
      `RANGE invariant "${id}" must have a numeric "max" field`,
      id,
      'max',
      { providedValue: obj.max }
    );
  }

  // min must be less than max
  if (obj.min >= obj.max) {
    throw new InvariantValidationError(
      `RANGE invariant "${id}" min (${obj.min}) must be less than max (${obj.max})`,
      id,
      'min/max',
      { min: obj.min, max: obj.max }
    );
  }

  // assessment: required string
  if (typeof obj.assessment !== 'string' || obj.assessment.trim() === '') {
    throw new InvariantValidationError(
      `RANGE invariant "${id}" must have a non-empty "assessment" field describing how to measure`,
      id,
      'assessment'
    );
  }

  return {
    id,
    type: 'RANGE',
    metric: obj.metric as string,
    min: obj.min as number,
    max: obj.max as number,
    assessment: obj.assessment as string,
    examples: validateExamples(id, obj.examples),
  };
}

/**
 * Validate a BooleanInvariant
 */
function validateBooleanInvariant(
  id: string,
  obj: Record<string, unknown>
): BooleanInvariant {
  // condition: required string
  if (typeof obj.condition !== 'string' || obj.condition.trim() === '') {
    throw new InvariantValidationError(
      `BOOLEAN invariant "${id}" must have a non-empty "condition" field`,
      id,
      'condition'
    );
  }

  // assessment: required string
  if (typeof obj.assessment !== 'string' || obj.assessment.trim() === '') {
    throw new InvariantValidationError(
      `BOOLEAN invariant "${id}" must have a non-empty "assessment" field describing how to check`,
      id,
      'assessment'
    );
  }

  return {
    id,
    type: 'BOOLEAN',
    condition: obj.condition as string,
    assessment: obj.assessment as string,
    examples: validateExamples(id, obj.examples),
  };
}

/**
 * Validate optional examples field
 */
function validateExamples(
  id: string,
  examples: unknown
): InvariantExamples | undefined {
  if (examples === undefined || examples === null) {
    return undefined;
  }

  if (typeof examples !== 'object') {
    throw new InvariantValidationError(
      `Invariant "${id}" examples must be an object with "do" and "dont" arrays`,
      id,
      'examples'
    );
  }

  const examplesObj = examples as Record<string, unknown>;

  // Validate do array
  let doArray: string[] = [];
  if (examplesObj.do !== undefined) {
    if (!Array.isArray(examplesObj.do)) {
      throw new InvariantValidationError(
        `Invariant "${id}" examples.do must be an array of strings`,
        id,
        'examples.do'
      );
    }
    doArray = examplesObj.do.filter(
      (item): item is string => typeof item === 'string'
    );
  }

  // Validate dont array
  let dontArray: string[] = [];
  if (examplesObj.dont !== undefined) {
    if (!Array.isArray(examplesObj.dont)) {
      throw new InvariantValidationError(
        `Invariant "${id}" examples.dont must be an array of strings`,
        id,
        'examples.dont'
      );
    }
    dontArray = examplesObj.dont.filter(
      (item): item is string => typeof item === 'string'
    );
  }

  return { do: doArray, dont: dontArray };
}

/**
 * Validate multiple invariants, collecting all errors
 *
 * Returns all valid invariants and all errors encountered.
 */
export function validateInvariants(inputs: unknown[]): {
  valid: Invariant[];
  errors: InvariantValidationError[];
} {
  const valid: Invariant[] = [];
  const errors: InvariantValidationError[] = [];

  for (let i = 0; i < inputs.length; i++) {
    try {
      const invariant = validateInvariant(inputs[i]);
      valid.push(invariant);
    } catch (error) {
      if (error instanceof InvariantValidationError) {
        errors.push(error);
      } else {
        errors.push(
          new InvariantValidationError(
            `Invariant at index ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            undefined,
            'unknown'
          )
        );
      }
    }
  }

  return { valid, errors };
}

/**
 * Strict validation - throws if any invariant is invalid
 */
export function validateInvariantsStrict(inputs: unknown[]): Invariant[] {
  const { valid, errors } = validateInvariants(inputs);

  if (errors.length > 0) {
    const errorMessages = errors.map((e) => `  - ${e.message}`).join('\n');
    throw new Error(
      `Invalid invariants in blueprint:\n${errorMessages}`
    );
  }

  return valid;
}
