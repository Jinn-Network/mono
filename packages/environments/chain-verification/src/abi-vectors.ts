// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface AbiVector {
  readonly name: string;
  readonly signature: string;
  readonly types: readonly string[];
  readonly values: readonly unknown[];
  readonly expectedCalldata: string;
}

export async function loadAbiVectors(): Promise<readonly AbiVector[]> {
  const path = fileURLToPath(new URL("../fixtures/abi-vectors-v1/vectors.json", import.meta.url));
  const raw = JSON.parse(await readFile(path, "utf8")) as AbiVector[];
  return raw;
}

export interface StateReadKeyEntry {
  readonly request: {
    readonly to: string;
    readonly signature: string;
    readonly args: readonly string[];
    readonly returns: readonly string[];
    readonly state: "baseline" | "post-replay";
  };
  readonly key: string;
}

export async function loadKeyCorpus(): Promise<readonly StateReadKeyEntry[]> {
  const path = fileURLToPath(new URL("../fixtures/state-read-keys-v1/keys.json", import.meta.url));
  const raw = JSON.parse(await readFile(path, "utf8")) as StateReadKeyEntry[];
  return raw;
}
