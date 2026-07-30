import { itemTaskDigest, type BenchmarkRecord } from "@jinn-network/benchmarking-records";

export type CroissantFileObject = {
  "@type": "cr:FileObject";
  name: string;
  sha256: string;
};

export type CroissantDocument = {
  "@context": "https://mlcommons.org/croissant/1.0";
  "@type": "sc:Dataset";
  name: string;
  version: string;
  distribution: CroissantFileObject[];
};

/**
 * One-way Benchmark → MLCommons Croissant JSON-LD projection (§6.5).
 * `revealed` supplies exact Task bytes keyed by bare or `sha256:` digest; FileObject names are
 * content-addressed (`{sha256}.task.json`) so the projection never invents display labels.
 */
export function exportCroissant(
  bench: BenchmarkRecord,
  revealed: ReadonlyMap<string, Uint8Array>,
): CroissantDocument {
  const distribution: CroissantFileObject[] = [];
  for (const item of bench.items) {
    const digest = itemTaskDigest(item);
    const bytes = revealed.get(digest) ?? revealed.get(`sha256:${digest}`);
    if (bytes === undefined) {
      throw new Error(`exportCroissant: missing revealed Task bytes for ${digest}`);
    }
    distribution.push({
      "@type": "cr:FileObject",
      name: `${digest}.task.json`,
      sha256: digest,
    });
  }
  return {
    "@context": "https://mlcommons.org/croissant/1.0",
    "@type": "sc:Dataset",
    name: bench.name,
    version: bench.version,
    distribution,
  };
}
