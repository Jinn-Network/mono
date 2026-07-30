// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

export interface CanonicalLoadoutPin {
  readonly kind: "jinn.skill.v1";
  readonly name: string;
  readonly digest: string;
}

/** Validates the portable deployment identity used by readiness, provisioners, and launchers. */
export function canonicalLoadoutPin(value: unknown): CanonicalLoadoutPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("loadout pin must be an object");
  }
  const pin = value as {
    readonly kind?: unknown;
    readonly name?: unknown;
    readonly digest?: { readonly sha256?: unknown };
  };
  if (pin.kind !== "jinn.skill.v1" || typeof pin.digest?.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.digest.sha256)) {
    throw new TypeError("unsupported or unpinned loadout");
  }
  if (
    typeof pin.name !== "string" || pin.name.length === 0 || pin.name === "."
    || pin.name === ".." || pin.name.includes("/") || pin.name.includes("\\")
  ) {
    throw new TypeError("loadout name must be one contained input path");
  }
  return { kind: "jinn.skill.v1", name: pin.name, digest: pin.digest.sha256 };
}

/** Joins only a validated portable loadout name below an Attempt input root. */
export function canonicalLoadoutPath(inputDir: string, value: unknown): string {
  return join(inputDir, canonicalLoadoutPin(value).name);
}
