import * as AjvModule from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
import type { SolverPluginManifest } from './types.js';

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (
  opts: Record<string, unknown>,
) => AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: AjvModule.default,
) => void;
const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormats(ajv);

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateSolverPluginManifest(input: unknown): SolverPluginManifest {
  assertRecord(input, 'manifest');
  for (const key of Object.keys(input)) {
    if (key.startsWith('jinn.')) {
      throw new Error(`unknown top-level jinn extension key: ${key}; use manifest.jinn`);
    }
  }
  if (typeof input['name'] !== 'string' || input['name'].length === 0) {
    throw new Error('manifest.name is required');
  }
  if (typeof input['version'] !== 'string' || input['version'].length === 0) {
    throw new Error('manifest.version is required');
  }
  const jinn = input['jinn'];
  assertRecord(jinn, 'manifest.jinn');
  if (typeof jinn['solverType'] !== 'string' || jinn['solverType'].length === 0) {
    throw new Error('manifest.jinn.solverType is required');
  }
  const schemas = jinn['schemas'];
  assertRecord(schemas, 'manifest.jinn.schemas');
  for (const name of ['task', 'solution', 'verdict'] as const) {
    assertRecord(schemas[name], `manifest.jinn.schemas.${name}`);
    ajv.compile(schemas[name]);
  }
  return input as unknown as SolverPluginManifest;
}

export function validateWithSchema(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(ajv.errorsText(validate.errors, { separator: '; ' }));
  }
}
