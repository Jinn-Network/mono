/**
 * Load a `jinn.manifest.json` from disk and validate it against the
 * Jinn manifest JSON Schema. Pure (no signature verification — that is
 * `verifyManifestSignature` in `verify.ts`).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { type ErrorObject, type Plugin } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';

// `ajv-formats` is published as CJS; under Node16 module resolution
// the callable plugin lives on `.default`.
const addFormats = (addFormatsModule as unknown as { default: Plugin<unknown> })
  .default;
import type { JinnManifest } from './types.js';

const SCHEMA_PATH = fileURLToPath(
  new URL('../../../schemas/jinn-manifest-v1.json', import.meta.url),
);

let validatorPromise: Promise<(d: unknown) => boolean> | null = null;
let lastValidator: ((d: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};

async function getValidator(): Promise<(d: unknown) => boolean> {
  if (validatorPromise) return validatorPromise;
  validatorPromise = (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
    const compiled = ajv.compile(schema) as ((d: unknown) => boolean) & {
      errors?: ErrorObject[] | null;
    };
    lastValidator = compiled;
    return compiled;
  })();
  return validatorPromise;
}

export async function loadManifest(absPath: string): Promise<JinnManifest> {
  const text = await readFile(resolve(absPath), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `manifest at ${absPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const validate = await getValidator();
  if (!validate(parsed)) {
    const errs = (lastValidator?.errors ?? [])
      .map((e) => `${e.instancePath} ${e.message}`)
      .join('; ');
    throw new Error(
      `manifest at ${absPath} failed schema validation: ${errs}`,
    );
  }
  return parsed as JinnManifest;
}
