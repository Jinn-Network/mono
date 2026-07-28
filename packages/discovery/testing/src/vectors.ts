import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareCodeUnitStrings } from "@jinn-network/record-discovery-protocol";

// The full §18 golden-vector corpus (plan Task 10): every case is a
// directory under fixtures/vectors/<name>/vector.json. Each directory's
// name MUST equal its vector's own `name` field -- the loader enforces
// this so the two never drift.

export const VECTOR_KINDS = [
  "source-chain",
  "item",
  "facts-consistency",
  "derivation-consistency",
  "query",
  "subscribe",
  "consumer",
] as const;

export type VectorKind = (typeof VECTOR_KINDS)[number];

export interface Vector {
  name: string;
  kind: VectorKind;
  /** Human-readable statement of what the vector exercises and why (design §-cited). */
  description: string;
  input: unknown;
  expect: unknown;
}

const VectorSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(VECTOR_KINDS),
  description: z.string().min(1),
  input: z.unknown(),
  expect: z.unknown(),
});

const vectorsRoot = fileURLToPath(new URL("../fixtures/vectors/", import.meta.url));

let cache: Vector[] | undefined;

/**
 * Loads and structurally validates the full golden-vector corpus, sorted by
 * name under UTF-16 code-unit order (never locale order, per the discovery
 * tree's ordering rule). Each vector's directory name must equal its own
 * `name` field.
 */
export function loadVectors(): Vector[] {
  if (cache !== undefined) return cache;
  const directories = readdirSync(vectorsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnitStrings);

  cache = directories.map((directory) => {
    const path = `${vectorsRoot}${directory}/vector.json`;
    const json = JSON.parse(readFileSync(path, "utf8"));
    const parsed = VectorSchema.parse(json);
    if (parsed.name !== directory) {
      throw new Error(
        `Vector directory "${directory}" does not match its own name field ("${parsed.name}").`,
      );
    }
    return parsed as Vector;
  });
  return cache;
}

/** Loads only the vectors of one kind, in the same deterministic order. */
export function loadVectorsByKind(kind: VectorKind): Vector[] {
  return loadVectors().filter((vector) => vector.kind === kind);
}
