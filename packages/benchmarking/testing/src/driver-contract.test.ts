import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { documentDigest, parseMatrix } from "@jinn-network/benchmarking-records";
import { describeAssemblyConformance } from "./assembly-types.js";
import { describeExportConformance } from "./export-types.js";

async function fixtureBytes(relative: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(
    fileURLToPath(new URL(`../fixtures/${relative}`, import.meta.url)),
  ));
}

describeAssemblyConformance(async () => {
  const bytes = await fixtureBytes("miniature-run/expected-matrix.json");
  return {
    record: parseMatrix(bytes),
    bytes,
    digest: documentDigest(bytes),
  };
});

describeExportConformance({
  evalLog: async () => JSON.parse(new TextDecoder().decode(await fixtureBytes("exports/eval-log.json"))),
  croissant: async () => JSON.parse(new TextDecoder().decode(await fixtureBytes("exports/croissant.json"))),
  staticBundle: async () => JSON.parse(new TextDecoder().decode(await fixtureBytes("exports/static-bundle.json"))),
});
