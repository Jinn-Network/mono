const JINN_JOB_ENV_KEY_PATTERN = /^JINN_JOB_[A-Z0-9_]+$/;

export function assertValidJinnJobEnvKey(key: string, source: string): void {
  if (!JINN_JOB_ENV_KEY_PATTERN.test(key)) {
    throw new Error(
      `${source} contains invalid env key "${key}". Only JINN_JOB_* keys are allowed.`,
    );
  }
}

/**
 * Extract env var mappings from an input schema's property definitions.
 * For each property with an `envVar` field whose value is present in `input`,
 * maps envVar key -> String(input value). Validates all keys match JINN_JOB_*.
 */
export function extractSchemaEnvVars(
  inputSchema: Record<string, any>,
  input: Record<string, any>,
  source: string,
): Record<string, string> | undefined {
  if (!inputSchema?.properties) return undefined;

  const extracted: Record<string, string> = {};
  for (const [field, spec] of Object.entries(inputSchema.properties as Record<string, any>)) {
    if (spec.envVar && input[field] !== undefined) {
      assertValidJinnJobEnvKey(spec.envVar, `${source}.${field}.envVar`);
      extracted[spec.envVar] = String(input[field]);
    }
  }

  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

export function assertValidJinnJobEnvMap(rawEnv: unknown, source: string): Record<string, string> {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    throw new Error(`${source} must be an object map of JINN_JOB_* keys to string values.`);
  }

  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
    assertValidJinnJobEnvKey(key, source);
    if (typeof value !== 'string') {
      throw new Error(`${source} has non-string value for key "${key}".`);
    }
    validated[key] = value;
  }
  return validated;
}
