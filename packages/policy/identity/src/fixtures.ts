// SPDX-License-Identifier: MIT

/**
 * Fixture loading for the conformance kit.
 *
 * Fixture families live at `fixtures/<family>/{golden,adversarial}/*.json`, mirroring the
 * `@jinn-network/task-execution-profiles` convention. Each file is one case carrying a `note`
 * (why the case exists — an adversarial fixture with no stated attack is a fixture nobody can
 * maintain), an `input`, and an `expect`.
 *
 * Filesystem access lives HERE and in tests only. The package itself is pure: no clock, no
 * network, no filesystem, no randomness (substrate §2).
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type FixtureKind = "golden" | "adversarial";

export interface FixtureCase {
  readonly kind: FixtureKind;
  readonly name: string;
  readonly note: string;
  readonly input: unknown;
  readonly expect: Record<string, unknown>;
  readonly [extra: string]: unknown;
}

const FIXTURES_ROOT = new URL("../fixtures/", import.meta.url);

export function fixturePath(relative: string): string {
  return fileURLToPath(new URL(relative, FIXTURES_ROOT));
}

export function readFixture<T = Record<string, unknown>>(relative: string): T {
  return JSON.parse(readFileSync(fixturePath(relative), "utf8")) as T;
}

/** Loads one `{golden,adversarial}` subdirectory, tagging each case with its kind and file stem. */
export function loadFixtureDirectory(family: string, kind: FixtureKind): FixtureCase[] {
  const directory = fixturePath(`${family}/${kind}/`);
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      const parsed = JSON.parse(readFileSync(`${directory}${entry}`, "utf8")) as Record<string, unknown>;
      return { ...parsed, kind, name: entry.replace(/\.json$/, "") } as FixtureCase;
    });
}

export function loadFixtureFamily(family: string): FixtureCase[] {
  return [...loadFixtureDirectory(family, "golden"), ...loadFixtureDirectory(family, "adversarial")];
}

/**
 * Runs `check` and projects the outcome into the `{ok, code, path}` shape the adversarial
 * fixtures pin — never the message, which is free to change.
 */
export function outcomeOf(check: () => unknown): { ok: boolean; code?: string; path?: string } {
  try {
    check();
    return { ok: true };
  } catch (error) {
    const typed = error as { category?: string; errors?: { path?: string; code?: string }[] };
    return {
      ok: false,
      code: typed.category,
      path: typed.errors?.[0]?.path,
    };
  }
}
