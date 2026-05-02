import * as AjvModule from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';
export { validateSolverPluginManifest } from '@jinn-network/sdk/plugins';

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (
  opts: Record<string, unknown>,
) => AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (
  ajv: AjvModule.default,
) => void;
const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormats(ajv);

export function validateWithSchema(schema: Record<string, unknown>, value: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(ajv.errorsText(validate.errors, { separator: '; ' }));
  }
}
