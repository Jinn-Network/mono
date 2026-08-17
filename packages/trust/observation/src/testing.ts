// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

/**
 * In-tree fake proving the Class O kit passable: schema-validate, then serialize
 * as pretty JSON with a trailing newline — no filesystem. A kit failure against
 * this fake is the contract's fault, never `writeObservation`'s.
 */
export function createMemoryObservationContainer() {
  const files = new Map<string, string>();
  return {
    write<T>(path: string, schema: z.ZodType<T>, value: T): void {
      files.set(path, `${JSON.stringify(schema.parse(value), null, 2)}\n`);
    },
    read(path: string): string | undefined {
      return files.get(path);
    },
    paths(): string[] {
      return [...files.keys()].sort();
    },
  };
}

export type MemoryObservationContainer = ReturnType<typeof createMemoryObservationContainer>;
