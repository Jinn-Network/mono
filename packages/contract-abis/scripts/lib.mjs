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

/** @param {{ type: string; components?: readonly unknown[] }} component */
function canonicalType(component) {
  if (component.type.startsWith("tuple")) {
    const inner = (component.components ?? [])
      .map((child) => canonicalType(/** @type {{ type: string }} */ (child)))
      .join(",");
    // The suffix carries any array shape (`[]`, `[2]`), so a tuple[] stays expressible.
    return `(${inner})${component.type.slice("tuple".length)}`;
  }
  return component.type;
}

/** @param {{ inputs?: readonly unknown[] }} item */
function canonicalInputs(item) {
  return (item.inputs ?? [])
    .map((input) => canonicalType(/** @type {{ type: string }} */ (input)))
    .join(",");
}

/**
 * @param {string} entry
 * @param {readonly {type: string; name?: string; inputs?: readonly unknown[]}[]} candidates
 * @param {string} [context]
 */
function ambiguousItemError(entry, candidates, context) {
  const where = context === undefined ? "" : ` in ${context}`;
  const listed = candidates
    .map((item) => `  ${item.type} ${item.name}(${canonicalInputs(item)})`)
    .join("\n");
  const example = `${candidates[0].name}(${canonicalInputs(candidates[0])})`;
  return new Error(
    `Ambiguous ABI item "${entry}"${where}:\n${candidates.length} items match:\n${listed}\n` +
      `Disambiguate in slices.manifest.json with the full signature, e.g. "${example}".`,
  );
}

/**
 * Resolve manifest entries against a full ABI. An entry is either a bare name
 * (`"createTask"`) or a canonical signature (`"claimTask(uint256,address)"`),
 * which selects one overload. A name matching more than one item is a hard
 * error rather than a silent last-wins pick. `context` names the caller (the
 * generator passes its slice and contract) and is appended to that error.
 *
 * Kept deliberately in step with `src/pick.ts`: `yarn generate` must not depend
 * on a prior `yarn build`. `test/pick.test.ts` runs both copies through the
 * same cases, including the error text.
 *
 * @param {readonly unknown[]} fullAbi
 * @param {readonly string[]} names
 * @param {string} [context]
 */
export function pickAbiItems(fullAbi, names, context) {
  const byName = new Map();
  for (const item of fullAbi) {
    const entry = /** @type {{ name?: string }} */ (item);
    if (entry.name !== undefined) {
      const existing = byName.get(entry.name);
      if (existing === undefined) {
        byName.set(entry.name, [normalizeAbiValue(item)]);
      } else {
        existing.push(normalizeAbiValue(item));
      }
    }
  }
  const picked = [];
  for (const entry of names) {
    const open = entry.indexOf("(");
    const candidates = byName.get(open === -1 ? entry : entry.slice(0, open)) ?? [];
    const matches =
      open === -1
        ? candidates
        : candidates.filter(
            // `slice(open + 1, -1)` requires the entry to END at its closing paren, so a
            // malformed `"foo(uint256)junk"` falls through to the not-found error rather than
            // silently resolving.
            (item) => canonicalInputs(item) === entry.slice(open + 1, -1),
          );
    if (matches.length === 0) {
      throw new Error(`ABI item not found: ${entry}`);
    }
    if (matches.length > 1) {
      throw ambiguousItemError(entry, matches, context);
    }
    picked.push(matches[0]);
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
