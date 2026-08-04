// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

/**
 * The loadout pinning vocabulary. Substrate §4.2
 * (docs/superpowers/specs/2026-08-03-policy-identity-and-outcomes-design.md) adds
 * `jinn.harness-state.v1` alongside the original `jinn.skill.v1`. Both kinds share the same
 * path-safety rules for `name`; each kind keeps its own digest spelling — `jinn.skill.v1`'s
 * legacy in-toto `ResourceDescriptor` digest map (bare hex under `.sha256`) is unchanged,
 * while `jinn.harness-state.v1` uses the substrate's `sha256:`-prefixed single-string
 * convention (F9 — see `sha256-digest.ts`, the named conversion point to/from the bare hex
 * `learner-public.v1` emits).
 */
export const LOADOUT_KINDS = ["jinn.skill.v1", "jinn.harness-state.v1"] as const;
export type LoadoutKind = (typeof LOADOUT_KINDS)[number];

export interface CanonicalLoadoutPin {
  readonly kind: LoadoutKind;
  readonly name: string;
  readonly digest: string;
}

const BARE_SHA256 = /^[0-9a-f]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;

function validLoadoutName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name !== "." && name !== ".."
    && !name.includes("/") && !name.includes("\\");
}

/** Validates the portable deployment identity used by readiness, provisioners, and launchers. */
export function canonicalLoadoutPin(value: unknown): CanonicalLoadoutPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("loadout pin must be an object");
  }
  const pin = value as {
    readonly kind?: unknown;
    readonly name?: unknown;
    readonly digest?: unknown;
  };

  let kind: LoadoutKind;
  let digest: string;
  if (pin.kind === "jinn.skill.v1") {
    const skillDigest = (pin.digest as { readonly sha256?: unknown } | undefined)?.sha256;
    if (typeof skillDigest !== "string" || !BARE_SHA256.test(skillDigest)) {
      throw new TypeError("unsupported or unpinned loadout");
    }
    kind = "jinn.skill.v1";
    digest = skillDigest;
  } else if (pin.kind === "jinn.harness-state.v1") {
    if (typeof pin.digest !== "string" || !PREFIXED_SHA256.test(pin.digest)) {
      throw new TypeError("unsupported or unpinned loadout");
    }
    kind = "jinn.harness-state.v1";
    digest = pin.digest;
  } else {
    throw new TypeError("unsupported or unpinned loadout");
  }

  if (!validLoadoutName(pin.name)) {
    throw new TypeError("loadout name must be one contained input path");
  }
  return { kind, name: pin.name, digest };
}

/** Joins only a validated portable loadout name below an Attempt input root. */
export function canonicalLoadoutPath(inputDir: string, value: unknown): string {
  return join(inputDir, canonicalLoadoutPin(value).name);
}
