// Conformance-kit backbone (design §12): a pure structural runner + fixture-family loader.
// Imports only Node builtins + this package's own modules + task-execution-protocol (never the
// TEP testing kit — profiles never depends on `testing`; design §12/§14). No vitest import: these
// are plain functions a consumer calls from any test framework.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ProfilesError } from "./errors.js";

export type FixtureKind = "golden" | "adversarial";

export interface FixtureCase {
  name: string;
  kind: FixtureKind;
  input: unknown;
  expect: unknown;
}

export interface StructuralCheckResult {
  case: string;
  kind: FixtureKind;
  ok: boolean;
  detail?: string;
}

async function loadKind(familyDir: string, kind: FixtureKind): Promise<FixtureCase[]> {
  const kindDir = join(familyDir, kind);
  let entries: string[];
  try {
    entries = (await readdir(kindDir)).filter((entry) => entry.endsWith(".json"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  const cases: FixtureCase[] = [];
  for (const entry of entries.sort()) {
    const raw = await readFile(join(kindDir, entry), "utf8");
    const parsed = JSON.parse(raw) as { input: unknown; expect: unknown };
    cases.push({ name: basename(entry, ".json"), kind, input: parsed.input, expect: parsed.expect });
  }
  return cases;
}

/**
 * Reads `<familyDir>/{golden,adversarial}/*.json`, each `{ input, expect }`, and tags every case
 * with its kind and its file-stem name.
 */
export async function loadFixtureFamily(familyDir: string): Promise<FixtureCase[]> {
  const [golden, adversarial] = await Promise.all([
    loadKind(familyDir, "golden"),
    loadKind(familyDir, "adversarial"),
  ]);
  return [...golden, ...adversarial];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

/**
 * Runs `check` over every fixture case. A golden case passes when `check(input)` deep-equals
 * `expect`. An adversarial case passes when `check`'s outcome deep-equals `expect` — either the
 * returned value, or, when `check` throws a `ProfilesError`, its `{ ok: false, code }` projection
 * (so adversarial fixtures can assert the rejection code without leaking messages).
 */
export function runStructuralCheck<T>(
  cases: FixtureCase[],
  check: (input: unknown) => T,
): StructuralCheckResult[] {
  return cases.map((fixtureCase) => {
    let outcome: unknown;
    try {
      outcome = check(fixtureCase.input);
    } catch (error) {
      if (error instanceof ProfilesError) {
        outcome = { ok: false, code: error.code };
      } else {
        return {
          case: fixtureCase.name,
          kind: fixtureCase.kind,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const ok = deepEqual(outcome, fixtureCase.expect);
    return {
      case: fixtureCase.name,
      kind: fixtureCase.kind,
      ok,
      ...(ok ? {} : { detail: JSON.stringify(outcome) }),
    };
  });
}
