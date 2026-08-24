import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest() {
  return JSON.parse(readFileSync(join(packageRoot, "contracts.manifest.json"), "utf8"));
}

export function loadSlicesManifest() {
  return JSON.parse(readFileSync(join(packageRoot, "slices.manifest.json"), "utf8"));
}

export function resolveArtifactsDir(manifest, packageRootOverride = packageRoot) {
  return join(packageRootOverride, manifest.artifactsSubdir ?? "generated");
}

export function resolveContractsArtifactsDir(manifest, packageRootOverride = packageRoot) {
  return join(packageRootOverride, manifest.contractsDir, manifest.artifactsSubdir);
}

/** @param {unknown} value */
export function normalizeAbiValue(value) {
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeAbiValue);
  }
  /** @type {Record<string, unknown>} */
  const input = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const out = { type: input.type };
  if (input.name !== undefined) out.name = input.name;
  if (input.indexed !== undefined) out.indexed = input.indexed;
  if (input.anonymous === true) out.anonymous = true;
  if (input.stateMutability !== undefined) out.stateMutability = input.stateMutability;
  if (input.inputs !== undefined) out.inputs = normalizeAbiValue(input.inputs);
  if (input.outputs !== undefined) out.outputs = normalizeAbiValue(input.outputs);
  if (input.components !== undefined) out.components = normalizeAbiValue(input.components);
  return out;
}

/** @param {readonly unknown[]} abi */
export function normalizeFullAbi(abi) {
  return abi
    .map((item) => normalizeAbiValue(item))
    .sort((left, right) => {
      const l = /** @type {{ type: string; name?: string }} */ (left);
      const r = /** @type {{ type: string; name?: string }} */ (right);
      return `${l.type}:${l.name ?? ""}`.localeCompare(`${r.type}:${r.name ?? ""}`);
    });
}

/** @param {string} artifactPath */
export function readNormalizedArtifactAbi(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`Artifact missing abi array: ${artifactPath}`);
  }
  return normalizeFullAbi(artifact.abi);
}

/**
 * @param {readonly unknown[]} fullAbi
 * @param {readonly string[]} names
 */
export function pickAbiItems(fullAbi, names) {
  const byName = new Map();
  for (const item of fullAbi) {
    const entry = /** @type {{ name?: string }} */ (item);
    if (entry.name !== undefined) {
      byName.set(entry.name, normalizeAbiValue(item));
    }
  }
  const picked = [];
  for (const name of names) {
    const item = byName.get(name);
    if (item === undefined) {
      throw new Error(`ABI item not found: ${name}`);
    }
    picked.push(item);
  }
  return picked;
}

export function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {string} exportName @param {readonly unknown[]} items */
export function emitTypeScriptConstExport(exportName, items) {
  return `export const ${exportName} = ${JSON.stringify(items, null, 2)} as const;\n`;
}
