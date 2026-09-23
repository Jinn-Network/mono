// SPDX-License-Identifier: Apache-2.0

/**
 * The typed refusal a call raised, so a test can assert its `code` and `issues` and not only its
 * prose: callers branch on the code, so the code is the part a change must not move silently.
 *
 * Shared by `freeze-repo.test.ts` and `item-bank-source-closure.test.ts`, which each carried a
 * copy under the same name and signature (issue #4380). Lives under `testing/` for the reason
 * `golden-asset-input.ts` states: `tsconfig.build.json` excludes the directory from the published
 * tarball, and a helper two suites share cannot be named `*.test.ts` without a test runner
 * collecting it.
 */

import { expect } from "vitest";
import { BenchmarkProductError } from "../profile/errors.js";

export function expectRefusal(run: () => unknown): BenchmarkProductError {
  let raised: unknown;
  let threw = false;
  try {
    run();
  } catch (cause) {
    threw = true;
    raised = cause;
  }
  // Asserted outside the try, because a `throw` placed inside it lands in its own catch and the
  // test then fails on the type assertion instead: a reader chasing a regression is told
  // "expected BenchmarkProductError, received Error" when the truth is that nothing was thrown.
  expect(threw, "expected a refusal").toBe(true);
  expect(raised).toBeInstanceOf(BenchmarkProductError);
  return raised as BenchmarkProductError;
}
