/**
 * OutputSpec: Deterministic output contract for job templates
 * 
 * Defines how to extract structured results from delivery payloads.
 * 
 * Schema: JSON Schema defining the expected output structure
 * Mapping: JSONPath selectors mapping schema fields to delivery payload fields
 * Transforms: Optional post-processing transforms (not implemented in v0)
 * 
 * Passthrough Flow:
 * 1. x402-gateway includes outputSpec in dispatch IPFS payload
 * 2. Worker passes outputSpec through to delivery payload (via buildDeliveryPayload)
 * 3. x402-gateway result endpoint reads outputSpec directly from delivery (fast path)
 * 4. Falls back to Ponder lookup only if not present in delivery
 * 5. Response includes outputSpec for downstream consumers
 * 
 * Available delivery payload fields (from worker/delivery/payload.ts):
 * - $.output: Main agent output (string)
 * - $.structuredSummary: Summary of output (string)
 * - $.artifacts: Array of artifact objects [{name, cid, topic}]
 * - $.status: Job status (COMPLETED, FAILED, DELEGATING, WAITING)
 * - $.statusMessage: Optional status explanation
 * - $.jobDefinitionId: UUID of the job definition
 * - $.jobName: Human-readable job name
 * - $.templateId: Template ID if dispatched via x402 (string)
 * - $.outputSpec: Passthrough OutputSpec from dispatch (object)
 * - $.pullRequestUrl: PR URL if code changes were made
 * - $.recognition: Recognition phase data
 * - $.reflection: Reflection phase data
 * - $.telemetry: Execution telemetry
 * - $.workerTelemetry: Worker-level telemetry
 */

export interface OutputSpec {
  /**
   * JSON Schema defining the expected output structure.
   * Used for validation after mapping.
   */
  schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      items?: { type: string };
    }>;
    required?: string[];
  };

  /**
   * Mapping from schema field names to JSONPath selectors.
   * Selectors reference fields in the delivery payload.
   * 
   * Examples:
   * - "$.output" → raw output string
   * - "$.structuredSummary" → summary string
   * - "$.artifacts" → full artifacts array
   * - "$.artifacts[0].cid" → first artifact's CID
   */
  mapping: Record<string, string>;

  /**
   * Optional transforms to apply after mapping (v1 feature).
   * Not implemented in hackathon v0.
   */
  transforms?: Record<string, {
    type: 'truncate' | 'parse_json' | 'extract_regex';
    params?: Record<string, any>;
  }>;
}

/**
 * Default OutputSpec for templates without custom output contracts.
 * Returns the most commonly needed fields.
 */
export const DEFAULT_OUTPUT_SPEC: OutputSpec = {
  schema: {
    type: 'object',
    properties: {
      raw: { type: 'string', description: 'Raw agent output' },
      summary: { type: 'string', description: 'Structured summary' },
      artifacts: { type: 'array', description: 'Generated artifacts', items: { type: 'object' } },
      status: { type: 'string', description: 'Job completion status' },
    },
    required: ['raw', 'summary'],
  },
  mapping: {
    raw: '$.output',
    summary: '$.structuredSummary',
    artifacts: '$.artifacts',
    status: '$.status',
  },
};

/**
 * Apply OutputSpec mapping to extract structured result from delivery payload.
 * 
 * @param deliveryPayload - Raw delivery payload from IPFS
 * @param spec - OutputSpec defining the mapping
 * @returns Mapped result object
 */
export function applyOutputSpec(
  deliveryPayload: Record<string, any>,
  spec: OutputSpec
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [field, selector] of Object.entries(spec.mapping)) {
    result[field] = extractValue(deliveryPayload, selector);
  }

  return result;
}

/**
 * Strip markdown code fences from a string.
 * Handles ```json, ```typescript, ``` (no lang), etc.
 * Returns original value if not a fenced string.
 */
function stripMarkdownFences(value: any): any {
  if (typeof value !== 'string') return value;
  
  const trimmed = value.trim();
  // Match opening fence: ```<optional-lang>\n
  const fenceMatch = trimmed.match(/^```(\w*)\r?\n([\s\S]*?)\r?\n```$/);
  if (fenceMatch) {
    return fenceMatch[2].trim();
  }
  
  // Also handle single-line fence (rare but possible): ```content```
  const inlineMatch = trimmed.match(/^```(\w*)\s*([\s\S]*?)```$/);
  if (inlineMatch) {
    return inlineMatch[2].trim();
  }
  
  return value;
}

/**
 * Extract value from object using JSONPath-like selector.
 * Supports basic dot notation and array indexing.
 * Automatically strips markdown code fences from string values.
 * 
 * Examples:
 * - "$.output" → payload.output
 * - "$.artifacts[0].cid" → payload.artifacts[0].cid
 * - "$.recognition.learnings" → payload.recognition.learnings
 */
function extractValue(obj: Record<string, any>, selector: string): any {
  // Remove leading "$." if present
  const path = selector.startsWith('$.') ? selector.slice(2) : selector;
  
  // Split by dots and brackets
  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  
  let current: any = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    
    // Handle array index
    const index = parseInt(part, 10);
    if (!isNaN(index)) {
      current = current[index];
    } else {
      current = current[part];
    }
  }
  
  // Strip markdown fences from final string value
  return stripMarkdownFences(current);
}

/**
 * Validate mapped result against OutputSpec schema.
 * Returns validation errors if any.
 * 
 * @param result - Mapped result object
 * @param spec - OutputSpec with schema
 * @returns Array of validation errors (empty if valid)
 */
export function validateOutput(
  result: Record<string, any>,
  spec: OutputSpec
): string[] {
  const errors: string[] = [];
  const schema = spec.schema;

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (result[field] === undefined || result[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check field types (basic validation)
  for (const [field, def] of Object.entries(schema.properties)) {
    const value = result[field];
    if (value === undefined) continue;

    const expectedType = def.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (expectedType !== actualType) {
      // Allow null for optional fields
      if (value !== null) {
        errors.push(`Field '${field}' expected ${expectedType}, got ${actualType}`);
      }
    }
  }

  return errors;
}

/**
 * Full pipeline: map delivery payload through OutputSpec and validate.
 * Returns structured result or throws on validation failure.
 * 
 * @param deliveryPayload - Raw delivery payload from IPFS
 * @param spec - OutputSpec (uses DEFAULT_OUTPUT_SPEC if not provided)
 * @returns Validated, mapped result
 * @throws Error if validation fails
 */
export function extractAndValidate(
  deliveryPayload: Record<string, any>,
  spec?: OutputSpec
): Record<string, any> {
  const outputSpec = spec || DEFAULT_OUTPUT_SPEC;
  
  // Apply mapping
  const result = applyOutputSpec(deliveryPayload, outputSpec);
  
  // Validate
  const errors = validateOutput(result, outputSpec);
  if (errors.length > 0) {
    throw new Error(`Output validation failed: ${errors.join('; ')}`);
  }
  
  return result;
}

/**
 * Summarize OutputSpec for API listing display.
 * Returns a human-readable summary of the output contract.
 */
export function summarizeOutputSpec(spec: OutputSpec | null | undefined): string {
  if (!spec || !spec.schema) return 'raw output';
  
  const props = spec.schema.properties || {};
  const fields = Object.keys(props);
  const required = spec.schema.required || [];
  
  if (fields.length === 0) return 'raw output';
  
  // Mark required fields with asterisk
  const fieldList = fields.map(f => required.includes(f) ? `${f}*` : f);
  
  if (fieldList.length <= 3) return fieldList.join(', ');
  return `${fieldList.slice(0, 3).join(', ')} + ${fieldList.length - 3} more`;
}

