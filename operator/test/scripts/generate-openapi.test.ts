import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../../scripts/generate-openapi.js';

/**
 * Asserts the committed `operator/openapi.v1.json` matches regeneration
 * (spec/2026-08-04-headless-operator-rederivation-design.md §8 artifact 4) — same pattern as
 * `.github/scripts/generate-architecture.mjs --check`. Run `yarn generate:openapi` and commit
 * the result if this fails.
 */
const artifactPath = fileURLToPath(new URL('../../openapi.v1.json', import.meta.url));

describe('openapi.v1.json generation', () => {
  it('matches a fresh regeneration from the contract schemas', () => {
    const committed = readFileSync(artifactPath, 'utf-8');
    const fresh = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    expect(committed).toEqual(fresh);
  });

  it('is valid OpenAPI 3.1 with the /v1/status route and a real (non-empty) response schema', () => {
    const doc = JSON.parse(readFileSync(artifactPath, 'utf-8')) as {
      openapi: string;
      paths: Record<string, { get: { responses: { '200': { content: { 'application/json': { schema: { properties?: Record<string, unknown> } } } } } } }>;
    };
    expect(doc.openapi).toBe('3.1.0');
    const statusSchema = doc.paths['/v1/status'].get.responses['200'].content['application/json'].schema;
    expect(Object.keys(statusSchema.properties ?? {}).length).toBeGreaterThan(20);
    expect(statusSchema.properties?.contractVersion).toBeTruthy();
  });

  it('contains no `additionalProperties: false` (B1: an additive-minor contract must not ' +
    'render every object closed — that both breaks the promise and papers over the fact ' +
    'that the runtime parse already tolerates unknown fields via z.looseObject)', () => {
    const committed = readFileSync(artifactPath, 'utf-8');
    expect(committed).not.toContain('"additionalProperties": false');
  });
});
