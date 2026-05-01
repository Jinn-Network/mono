/**
 * Load + validate a Path 1 plug-in's `jinn-plugin.json` manifest from a
 * package root. Pure: no network, no signature verification (Path 1
 * plug-ins inherit trust from the harness — see spec §4.3).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ErrorObject, type Plugin } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as addFormatsModule from 'ajv-formats';

const addFormats = (addFormatsModule as unknown as { default: Plugin<unknown> })
  .default;

import type { JinnPlugInManifest } from './types.js';

// TODO: refactor to import from client/src/util/path-safety.ts once Stream A
// creates that module (isInsidePackageDir mirrors isInsideWorkingDir from
// client/src/restorer/engine/packaging.ts).
function isInsidePackageDir(base: string, candidate: string): boolean {
  const b = resolve(base);
  const c = resolve(candidate);
  const rel = relative(b, c);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const SCHEMA_PATH = fileURLToPath(
  new URL('../../../schemas/jinn-plugin-v1.json', import.meta.url),
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

export async function loadPlugInManifest(
  packageRoot: string,
): Promise<JinnPlugInManifest> {
  const root = resolve(packageRoot);
  const manifestPath = join(root, 'jinn-plugin.json');
  const pkgJsonPath = join(root, 'package.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`jinn-plugin.json not found in ${root}`);
  }
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${root}`);
  }

  const [manifestText, pkgJsonText] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(pkgJsonPath, 'utf8'),
  ]);

  let manifest: JinnPlugInManifest;
  try {
    manifest = JSON.parse(manifestText) as JinnPlugInManifest;
  } catch (err) {
    throw new Error(
      `jinn-plugin.json is invalid JSON: ${(err as Error).message}`,
    );
  }

  const validate = await getValidator();
  if (!validate(manifest)) {
    const errs = (lastValidator?.errors ?? [])
      .map((e) => `${e.instancePath} ${e.message}`)
      .join('; ');
    throw new Error(`jinn-plugin.json failed schema validation: ${errs}`);
  }

  const pkgJson = JSON.parse(pkgJsonText) as { name?: string; version?: string };
  if (pkgJson.name !== manifest.name) {
    throw new Error(
      `name mismatch: package.json has "${pkgJson.name}" but jinn-plugin.json has "${manifest.name}"`,
    );
  }
  if (pkgJson.version !== manifest.version) {
    throw new Error(
      `version mismatch: package.json has "${pkgJson.version}" but jinn-plugin.json has "${manifest.version}"`,
    );
  }

  // Resolve + verify each slot's entry path on disk.
  for (const slot of manifest.slots) {
    if ('entry' in slot && slot.entry) {
      const entryAbs = join(root, slot.entry);
      if (!isInsidePackageDir(root, entryAbs)) {
        throw new Error(
          `slot entry escapes package root (path traversal): ${slot.entry} (slot type: ${slot.type})`,
        );
      }
      if (!existsSync(entryAbs)) {
        throw new Error(
          `slot entry not found: ${slot.entry} (slot type: ${slot.type})`,
        );
      }
    }
    if ('skillsDir' in slot && slot.skillsDir) {
      const skillsAbs = join(root, slot.skillsDir);
      if (!isInsidePackageDir(root, skillsAbs)) {
        throw new Error(
          `slot skillsDir escapes package root (path traversal): ${slot.skillsDir}`,
        );
      }
      if (!existsSync(skillsAbs)) {
        throw new Error(`slot skillsDir not found: ${slot.skillsDir}`);
      }
    }
  }

  return manifest;
}
