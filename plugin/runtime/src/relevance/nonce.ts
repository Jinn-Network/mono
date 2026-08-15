// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

/**
 * Narrow filesystem port for sensitivity-nonce persistence. Injected from the composition
 * root so library code stays free of `node:fs*` (C3 AST custody, C5-P3).
 */
export interface SensitivityNonceIO {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { readonly encoding: "utf8"; readonly mode: number },
  ): Promise<void>;
  ensureOwnerOnlyFile(path: string): Promise<void>;
}

/**
 * `createBuiltinDerivationDetectors` requires a private-configuration nonce of at least
 * 128 bits (`packages/evidence/derivation/src/detectors/index.ts:538-539`). It feeds the
 * detector configuration digest. Nothing derived from it leaves this machine in this
 * scope, so one per archive, generated once and reused, is exactly right — and keeping it
 * stable keeps classification reproducible across runs.
 */
export async function readOrCreateSensitivityNonce(
  path: string,
  io: SensitivityNonceIO,
): Promise<string> {
  try {
    const existing = (await io.readFile(path, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    if (code !== "ENOENT") throw error;
  }
  const nonce = `${randomUUID()}${randomUUID()}`.replace(/-/gu, "");
  await io.writeFile(path, `${nonce}\n`, { encoding: "utf8", mode: 0o600 });
  await io.ensureOwnerOnlyFile(path);
  return nonce;
}
