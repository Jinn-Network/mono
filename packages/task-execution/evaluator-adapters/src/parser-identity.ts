// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  parserAllowlistKey,
  type ParserIdentity,
} from "@jinn-network/task-execution-profiles";

/**
 * A parser's semantic commitment is its digest (profiles design §7.2). The digest here is
 * the SHA-256 of the parser's own semantics document, shipped in `fixtures/parsers/` and
 * pinned by `parser-identity.test.ts` — editing the semantics without bumping `version`
 * breaks the build rather than silently changing what the allowlist key means.
 */
function semanticsDigest(fileName: string): `sha256:${string}` {
  const path = fileURLToPath(
    new URL(`../fixtures/parsers/${fileName}`, import.meta.url),
  );
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export const SWE_REBENCH_PARSER: ParserIdentity = Object.freeze({
  id: "network.jinn.parser.swe-rebench-v2",
  version: "1.0.0",
  digest: semanticsDigest("swe-rebench-v2.parser.json"),
});

export const PREDICTION_PARSER: ParserIdentity = Object.freeze({
  id: "network.jinn.parser.prediction-market",
  version: "1.0.0",
  digest: semanticsDigest("prediction-market.parser.json"),
});

/**
 * This identity is generated and sealed by the profiles package from the complete response
 * parser registry plus its truth-comparison map. Keep the oracle single-sourced there rather
 * than copying a semantics fixture into this adapter package.
 */
export const BINARY_JUDGMENT_PARSER: ParserIdentity = Object.freeze({
  ...BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
});

/**
 * The deployment-side execution allowlist this package contributes. A host merges it into
 * `EvaluationHarnessDeployment.parserAllowlist`; a spec naming any other parser identity is
 * refused by the harness runtime before an adapter is selected.
 */
export function evaluatorAdaptersParserAllowlist(): ReadonlySet<string> {
  return new Set([
    parserAllowlistKey(BINARY_JUDGMENT_PARSER),
    parserAllowlistKey(SWE_REBENCH_PARSER),
    parserAllowlistKey(PREDICTION_PARSER),
  ]);
}
