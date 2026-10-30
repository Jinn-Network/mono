// SPDX-License-Identifier: Apache-2.0

/**
 * What a reader gets from the checker, reduced to the values the suite pins.
 *
 * `normalize` is the one place a value may be replaced before comparison. One value needs it: the
 * version this package carries, which every Colophon release moves without changing a single
 * check. No output carries a path or a clock reading, so nothing else is replaced; a value that
 * did vary would fail the second run rather than pass unnoticed.
 */

import { runVerifierCli } from "../../cli.js";
import { BenchmarkProductError } from "../../profile/errors.js";
import { verifyPublicBundle } from "../../verify.js";

export const VERIFIER_VERSION_PLACEHOLDER = "<verifier-version>";

/** Round-trips through JSON, so a value that does not survive serialization fails loudly here. */
export function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) => (
    key === "verifierVersion" ? VERIFIER_VERSION_PLACEHOLDER : entry
  ))) as unknown;
}

/** A thrown value in full. A refusal's `code` and `issues` are the contract its callers branch on. */
function describeThrown(cause: unknown): Record<string, unknown> {
  if (cause instanceof BenchmarkProductError) {
    return { name: cause.name, code: cause.code, message: cause.message, issues: cause.issues };
  }
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { thrown: String(cause) };
}

/** The outcome of a call that either returns or throws. */
export async function settled(run: () => unknown): Promise<unknown> {
  try {
    return { returned: await run() };
  } catch (cause) {
    return { threw: describeThrown(cause) };
  }
}

/** Every surface one bundle reaches a reader through: the library call, `--json`, and plain text. */
export async function observeBundle(bundleDir: string): Promise<unknown> {
  const library = await settled(() => verifyPublicBundle(bundleDir));
  const json = await runVerifierCli([bundleDir, "--json"]);
  const parsed = JSON.parse(json.stdout) as unknown;
  // The parsed form stands in for the bytes only if nothing was lost parsing them.
  if (`${JSON.stringify(parsed)}\n` !== json.stdout) throw new Error("--json stdout does not round-trip");
  const human = await runVerifierCli([bundleDir]);
  return {
    library,
    json: { exitCode: json.exitCode, stdout: parsed, stderr: json.stderr },
    human: { exitCode: human.exitCode, stdout: human.stdout, stderr: human.stderr },
  };
}
