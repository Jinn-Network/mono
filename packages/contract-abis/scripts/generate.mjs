import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadManifest,
  loadSlicesManifest,
  pickAbiItems,
  readNormalizedArtifactAbi,
  resolveContractsArtifactsDir,
  stableStringify,
  emitTypeScriptConstExport,
} from "./lib.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const requestedOutputRoot = process.argv[2];
const outputRoot = requestedOutputRoot ?? join(packageRoot, "generated");
// The TypeScript slices are part of the generated output, so they must honour
// `outputRoot` too. Writing them into the tracked tree unconditionally let
// `check-drift` silently heal a tampered slice before the tests read it (#3121).
const tsSliceRoot = requestedOutputRoot === undefined
  ? join(packageRoot, "src", "generated", "slices")
  : join(requestedOutputRoot, "ts-slices");

const manifest = loadManifest();
const slicesManifest = loadSlicesManifest();
const contractsArtifactsDir = resolveContractsArtifactsDir(manifest, packageRoot);

mkdirSync(join(outputRoot, "full"), { recursive: true });
mkdirSync(join(outputRoot, "slices"), { recursive: true });
mkdirSync(tsSliceRoot, { recursive: true });

/** @type {Record<string, readonly unknown[]>} */
const fullAbis = {};

for (const [key, relativePath] of Object.entries(manifest.contracts)) {
  const artifactPath = join(contractsArtifactsDir, relativePath);
  const abi = readNormalizedArtifactAbi(artifactPath);
  fullAbis[key] = abi;
  writeFileSync(join(outputRoot, "full", `${key}.json`), stableStringify(abi));
}

for (const [sliceKey, slice] of Object.entries(slicesManifest.slices)) {
  const fullAbi = fullAbis[slice.contract];
  if (fullAbi === undefined) {
    throw new Error(`Unknown contract for slice ${sliceKey}: ${slice.contract}`);
  }
  const picked = pickAbiItems(fullAbi, slice.items);
  writeFileSync(
    join(outputRoot, "slices", `${sliceKey}.json`),
    stableStringify({ export: slice.export, items: picked }),
  );
  writeFileSync(
    join(tsSliceRoot, `${sliceKey}.ts`),
    emitTypeScriptConstExport(slice.export, picked),
  );
}

console.log(`Generated ${Object.keys(manifest.contracts).length} full ABIs and ${Object.keys(slicesManifest.slices).length} slices in ${outputRoot}`);
