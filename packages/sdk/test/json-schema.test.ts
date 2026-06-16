import { describe, it, expect } from 'vitest';
import { z } from 'zod/v3';
import { zodToJsonSchema, jsonSchemaToZod, type JsonSchema } from '../src/json-schema.js';

describe('json-schema serialization helpers', () => {
  describe('zodToJsonSchema', () => {
    it('converts a simple object schema to JSON Schema', () => {
      const zod = z.object({
        name: z.string(),
        count: z.number().int(),
      });
      const json = zodToJsonSchema(zod);
      expect(json).toMatchObject({
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
        },
        required: expect.arrayContaining(['name', 'count']),
      });
    });

    it('produces a value that round-trips through JSON.stringify/parse', () => {
      const zod = z.object({
        id: z.string(),
        version: z.string(),
      });
      const json = zodToJsonSchema(zod);
      const reparsed = JSON.parse(JSON.stringify(json));
      expect(reparsed).toEqual(json);
    });

    it('produces a JsonSchema-typed value', () => {
      const zod = z.string();
      const json: JsonSchema = zodToJsonSchema(zod);
      // Type-level assertion. Runtime check that the result is a plain object.
      expect(typeof json).toBe('object');
      expect(json).not.toBeNull();
    });

    it('handles enums and unions', () => {
      const zod = z.enum(['solver', 'evaluator']);
      const json = zodToJsonSchema(zod);
      expect(json).toMatchObject({
        type: 'string',
        enum: ['solver', 'evaluator'],
      });
    });

    it('handles arrays', () => {
      const zod = z.array(z.string());
      const json = zodToJsonSchema(zod);
      expect(json).toMatchObject({
        type: 'array',
        items: { type: 'string' },
      });
    });
  });

  describe('round-trip Zod -> JsonSchema -> Zod (validation parity)', () => {
    it('a simple object schema validates the same set of inputs after round-trip', () => {
      const original = z.object({
        name: z.string(),
        count: z.number(),
      });
      const json = zodToJsonSchema(original);
      const reborn = jsonSchemaToZod(json);

      const valid = { name: 'foo', count: 1 };
      const invalid = { name: 123, count: 'x' };

      expect(original.safeParse(valid).success).toBe(true);
      expect(reborn.safeParse(valid).success).toBe(true);

      expect(original.safeParse(invalid).success).toBe(false);
      expect(reborn.safeParse(invalid).success).toBe(false);
    });

    it('round-trip preserves required vs optional fields', () => {
      const original = z.object({
        required: z.string(),
        optional: z.string().optional(),
      });
      const json = zodToJsonSchema(original);
      const reborn = jsonSchemaToZod(json);

      expect(reborn.safeParse({ required: 'x' }).success).toBe(true);
      expect(reborn.safeParse({}).success).toBe(false);
    });
  });
});
