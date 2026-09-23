// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnosable assertions shared by the Inspect integration suites (#4387, #4388, #4389).
 *
 * `expectOk` and `expectEvery` began life file-local in `oci.integration.test.ts` (#2832, #4322).
 * #4322's review named the graduation trigger: the point at which a second file needs them is the
 * point at which they move to one shared location rather than being duplicated per file.
 * `inspect.integration.test.ts` is that second file (#4387), so they live here now.
 *
 * Why this directory and not beside the integration tests: both integration files are `skipIf`-
 * gated on Docker / Inspect runtime env vars that no ordinary CI job supplies, so a helper defined
 * inside them executes in no ordinary run and an inverted predicate would be silent (#4389).
 * `src/**\/testing/**` is build-excluded (`tsconfig.build.json`) and typecheck-included
 * (`tsconfig.json`), and `src/bundle/testing/` is the precedent for a test-support module that
 * imports vitest and is unit-tested beside itself (`leak-scan.ts` + `leak-scan.test.ts`).
 * `assertions.test.ts` is that unit test; it runs under plain `yarn test` with no Docker, no
 * Python runtime, and no network, and it carries the truth-table and kill-check evidence that
 * previously lived only in a review body.
 */

import { expect } from "vitest";

/**
 * Every lifecycle operation returns a typed result whose failure carries a code and a detail. A
 * bare `expect(result.ok).toBe(true)` discards both and reports only `expected false to be true`,
 * which is what #2832's first observation left behind: a `runQuote` refusal in CI with nothing
 * naming what refused or why. Assert through this helper instead, so a failure names the step and
 * prints the result -- the evidence that tells a loaded environment apart from a runtime defect.
 */
export function expectOk<T extends { ok: boolean }>(result: T, step: string): T {
  // The detail is built only on the failing path. `expect`'s message argument is eager, so
  // carrying it inline would serialize every passing result in a suite that makes dozens of these
  // calls per test -- and a serializer that threw on a success would report as the step failing.
  if (!result.ok) expect.fail(`${step} failed: ${JSON.stringify(result)}`);
  return result;
}

/**
 * The mirror of `expectOk` for a step that is supposed to refuse: `expect(result.ok).toBe(false)`
 * reports only `expected true to be false` and says nothing about what was accepted instead. The
 * returned result is narrowed to the refusal arm, so the caller reads `error` without an
 * `if (result.ok) throw new Error("unreachable")` guard.
 */
export function expectRefused<T extends { ok: boolean }>(result: T, step: string): Extract<T, { ok: false }> {
  // Same laziness as `expectOk`: the result is serialized only when the step was wrongly accepted.
  if (result.ok) expect.fail(`${step} was accepted: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: false }>;
}

/**
 * `expect(items.every(p)).toBe(true)` reports `expected false to be true`: it names neither which
 * element failed nor what it held. Assert through this instead, so a failure names the step, the
 * count, and a projection of every offending element.
 *
 * The projection is built only on the failing path, for the reason `expectOk` documents above:
 * `expect`'s message argument is eager, so carrying the evidence inline would serialize a whole
 * matrix and journal on every passing assertion in a test that runs for minutes of real OCI work.
 */
export function expectEvery<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  project: (item: T, index: number) => unknown,
  step: string,
): void {
  const offenders = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !predicate(item));
  if (offenders.length === 0) return;
  expect.fail(`${step}: ${String(offenders.length)} of ${String(items.length)} failed: ${
    JSON.stringify(offenders.map(({ item, index }) => project(item, index)))}`);
}

/**
 * The names of every marker whose value occurs in `bytes`, in the order the markers were given.
 *
 * A leak assertion written as `expect(text).not.toContain(secret)` prints the whole received
 * string on failure -- the secret itself, plus whatever absolute `mkdtemp` paths the payload
 * carries -- into a public CI log (#4388). Asserting `expect(leakMarkers(bytes, markers)).toEqual([])`
 * instead fails by naming the marker (`"key-sentinel"`), never the value that matched or the
 * bytes it matched in. Detection is a plain byte search, so the set of inputs this catches is
 * exactly the set `not.toContain` caught.
 */
export function leakMarkers(bytes: Uint8Array, values: Readonly<Record<string, string>>): string[] {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Object.entries(values)
    .filter(([, value]) => haystack.includes(Buffer.from(value)))
    .map(([marker]) => marker);
}
