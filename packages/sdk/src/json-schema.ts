// JSON Schema serialization helpers for the SDK.
//
// SolverNet manifests carry schemas in canonical JSON Schema form (the wire
// format), but daemon-side code prefers Zod for ergonomic validation.
// `zodToJsonSchema` produces the canonical form for inclusion in manifests;
// `jsonSchemaToZod` recovers a Zod validator from a JSON Schema body for
// cases where the manifest is the only available source (e.g., parsing an
// externally-launched SolverNet manifest into a runnable validator).
//
// See `spec/2026-05-05-solvernet-creation-and-launch.md` §7 and §8.

import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaImpl } from 'zod-to-json-schema';

/**
 * Canonical JSON Schema body. We use a permissive object alias rather than a
 * strict type because manifests carry arbitrary user-authored schemas and the
 * SDK does not need to constrain their internal shape — JSON Schema is
 * already a self-describing format.
 *
 * Use `unknown`-typed access (or a parser like Ajv) when reading nested fields.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Serialize a Zod schema to canonical JSON Schema (draft-07).
 *
 * Strips the top-level `$schema` reference so the returned object is a
 * plain schema body ready for embedding in a manifest. Manifest readers
 * who need the draft annotation can re-add it.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  // Default target is jsonSchema7. We omit `$schema` to keep the embedded
  // shape minimal — the manifest schemaVersion frames the dialect.
  const { $schema: _$schema, ...body } = zodToJsonSchemaImpl(schema, {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  return body;
}

/**
 * Reverse direction: produce a Zod validator from a JSON Schema body.
 *
 * Day-1 implementation handles the JSON Schema constructs produced by
 * `zodToJsonSchema` for the manifest shape (objects, strings, numbers,
 * integers, booleans, enums, arrays, optional/required, basic unions via
 * `anyOf`). It is sufficient to validate manifests authored by SDK users
 * but does NOT promise full draft-07 coverage. Unknown constructs fall
 * back to `z.unknown()` rather than throwing.
 *
 * For exhaustive draft-07 coverage in future, replace the body with a
 * dependency such as `json-schema-to-zod` or wire Ajv directly.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  return convert(schema);
}

function convert(schema: unknown): z.ZodTypeAny {
  if (typeof schema !== 'object' || schema === null) {
    return z.unknown();
  }
  const s = schema as Record<string, unknown>;

  // anyOf / oneOf -> z.union (need >= 2 members for z.union; fall back).
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const branches = (s.anyOf ?? s.oneOf) as unknown[];
    if (branches.length === 0) return z.unknown();
    if (branches.length === 1) return convert(branches[0]);
    const zodBranches = branches.map((b) => convert(b)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    return z.union(zodBranches);
  }

  // Enum (string-typed enums are by far the common case in our manifests).
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const allStrings = s.enum.every((v) => typeof v === 'string');
    if (allStrings) {
      const values = s.enum as string[];
      if (values.length === 1) {
        return z.literal(values[0]);
      }
      return z.enum(values as [string, ...string[]]);
    }
    // Mixed-type enum: union of literals.
    const literals: z.ZodTypeAny[] = (s.enum as unknown[]).map((v) => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        return z.literal(v);
      }
      return z.unknown();
    });
    if (literals.length < 2) return literals[0] ?? z.unknown();
    return z.union(literals as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  // const (single-value literal).
  if (s.const !== undefined) {
    const v = s.const;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return z.literal(v);
    }
    return z.unknown();
  }

  switch (s.type) {
    case 'string':
      return z.string();
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = s.items ? convert(s.items) : z.unknown();
      return z.array(items);
    }
    case 'object': {
      const props = (s.properties as Record<string, unknown> | undefined) ?? {};
      const required = new Set((s.required as string[] | undefined) ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, child] of Object.entries(props)) {
        const childZod = convert(child);
        shape[key] = required.has(key) ? childZod : childZod.optional();
      }
      const obj = z.object(shape);
      // Default zod-to-json-schema emits additionalProperties: false; we
      // honor that by leaving the object strict-ish (passthrough by default).
      // Use `.passthrough()` if additionalProperties is true or unset to
      // match permissive JSON Schema semantics.
      //
      // Note: `zodToJsonSchema` emits `additionalProperties: false` by default
      // for `z.object()` (passthrough is opt-in), so a round-trip through this
      // helper turns non-strict objects into strict ones. Day-1 acceptable;
      // flag here in case downstream callers need passthrough semantics
      // preserved.
      if (s.additionalProperties === false) {
        return obj.strict();
      }
      return obj.passthrough();
    }
    default:
      // Type missing or unrecognized: fall back to unknown.
      return z.unknown();
  }
}
