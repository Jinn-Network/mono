// SPDX-License-Identifier: Apache-2.0

import { isUpstreamRfc3339, type Candidate, type CandidateTestMaterial } from "../candidate.js";
import { documentDigest } from "../digest.js";
import { DerivationError } from "../errors.js";
import type { DerivationEnvironment, DerivationStrategy, StrategyDeps } from "../strategy.js";

/**
 * A format identity, not a product name (program §5 contract 5): the precedent is profiles'
 * own `documents/swe-rebench.ts`.
 */
export const IMPORT_STRATEGY_ID = "import.swe-rebench.v1" as const;

/**
 * The upstream row fields this strategy reads. Declared locally, never imported: the legacy
 * shape lives in `client/`, which is reference-only (program §5 contract 12), and C2 declares
 * its own for grouping (planning Finding (e)).
 */
export interface UpstreamRebenchRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit: string;
  readonly problem_statement: string;
  readonly language: string;
  /** Immutable upstream issue/instance time. Derivation never substitutes its own clock. */
  readonly created_at: string;
  /** The gold patch. LOCAL-ONLY downstream: it never reaches the supply pool. */
  readonly patch: string;
  readonly test_patch: string;
  readonly FAIL_TO_PASS: readonly string[];
  readonly PASS_TO_PASS: readonly string[];
  /** Upstream-declared SPDX expression, if the dataset carries one. */
  readonly license?: string;
  readonly timeout?: number;
}

export interface ImportStrategyInputs {
  /** Rows the caller has already materialized — this package opens no network (contract 4). */
  readonly rows: AsyncIterable<UpstreamRebenchRow> | Iterable<UpstreamRebenchRow>;
  readonly upstream: { readonly dataset: string; readonly revision: string };
  /** Explicit: a timeout the operator did not choose is a hidden policy. */
  readonly defaultTimeoutSeconds: number;
  /** Explicit: D12's permissive filter is the operator's policy, never a built-in default. */
  readonly licensePolicy: { readonly allow: readonly string[] };
  /** Applied only to rows that declare no licence, and only when the caller sets it. */
  readonly fallbackLicense?: string;
}

/**
 * A commonly-used permissive set, offered for callers to pass explicitly. It is NOT a
 * default: `licensePolicy` is required, so no row is ever admitted under a policy the
 * operator did not state (D12).
 */
export const PERMISSIVE_LICENSE_ALLOWLIST = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "PSF-2.0",
  "Python-2.0",
  "Unlicense",
] as const;

export type RowRejection =
  | "environment-row-mismatch"
  | "statement-empty"
  | "gold-missing"
  | "test-material-missing"
  | "no-fail-to-pass"
  | "invalid-provenance-timestamp"
  | "invalid-timeout"
  | "license-undeclared"
  | "license-not-permitted";

const encoder = new TextEncoder();

/**
 * Pure row assessment: either the licence to record, or the reason this row is not a
 * candidate for this environment. Exported so an operator can audit a batch before running
 * anything.
 */
export function assessRow(
  row: UpstreamRebenchRow,
  env: DerivationEnvironment,
  inputs: ImportStrategyInputs,
): { readonly ok: true; readonly sourceLicense: string; readonly timeout: number }
  | { readonly ok: false; readonly reason: RowRejection } {
  // The record describes ONE (repo, commit) tree; a row from another tree would be graded
  // against ground it was never written for.
  if (row.repo !== env.record.source.repo || row.base_commit !== env.record.source.commit) {
    return { ok: false, reason: "environment-row-mismatch" };
  }
  if (row.problem_statement.length === 0) return { ok: false, reason: "statement-empty" };
  if (row.patch.length === 0) return { ok: false, reason: "gold-missing" };
  if (row.test_patch.length === 0) return { ok: false, reason: "test-material-missing" };
  if (row.FAIL_TO_PASS.length === 0) return { ok: false, reason: "no-fail-to-pass" };
  if (!isUpstreamRfc3339(row.created_at)) return { ok: false, reason: "invalid-provenance-timestamp" };

  const timeout = row.timeout ?? inputs.defaultTimeoutSeconds;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) return { ok: false, reason: "invalid-timeout" };

  const declared = row.license ?? inputs.fallbackLicense;
  if (declared === undefined || declared.length === 0) {
    return { ok: false, reason: "license-undeclared" };
  }
  if (!inputs.licensePolicy.allow.includes(declared)) {
    return { ok: false, reason: "license-not-permitted" };
  }

  return { ok: true, sourceLicense: declared, timeout };
}

/**
 * The caller says which upstream the rows came from, and that label is sealed permanently — into
 * `provenance.sourceCommitment` and the payload's lineage — where nothing downstream can falsify
 * it. When the record itself was written from an import it carries the same two fields, so the
 * cheap check is available and is taken: a run-level precondition, evaluated once, so a
 * mislabelled batch fails up front rather than producing N identically-wrong provenance claims.
 *
 * `lineage.upstream.keys` is deliberately NOT used as a membership gate: the design (§4.2) does
 * not make it an exhaustive enumeration of the rows an environment covers, and reading it as one
 * would reject rows the record never claimed to exclude.
 */
function assertUpstreamAgreesWithRecord(
  env: DerivationEnvironment,
  inputs: ImportStrategyInputs,
): void {
  const lineage = env.record.lineage?.upstream;
  if (lineage === undefined) return;
  if (lineage.dataset !== inputs.upstream.dataset || lineage.revision !== inputs.upstream.revision) {
    throw new DerivationError(
      "invalid-input",
      `the caller labels these rows ${inputs.upstream.dataset}@${inputs.upstream.revision}, but the `
        + `record's lineage records ${lineage.dataset}@${lineage.revision}; a provenance claim `
        + "nothing downstream can falsify is not written from a contradiction.",
    );
  }
}

function testMaterialFrom(row: UpstreamRebenchRow): CandidateTestMaterial[] {
  const bytes = encoder.encode(row.test_patch);
  return [
    {
      name: "test-patch",
      mediaType: "text/x-diff",
      content: Buffer.from(bytes).toString("base64"),
      digest: documentDigest(bytes),
    },
  ];
}

/**
 * v1's only strategy (D4): an upstream row whose environment is described by `env` becomes
 * a candidate whose statement is that row's issue text, verbatim. Nothing here generates,
 * mutates or paraphrases text — statement generation is a named extension (§14), explicitly
 * cut from v1 (§12).
 */
export const importStrategy: DerivationStrategy<ImportStrategyInputs> = {
  id: IMPORT_STRATEGY_ID,
  async *derive(deps: StrategyDeps, env: DerivationEnvironment, inputs: ImportStrategyInputs) {
    assertUpstreamAgreesWithRecord(env, inputs);
    for await (const row of inputs.rows as AsyncIterable<UpstreamRebenchRow>) {
      const assessment = assessRow(row, env, inputs);
      if (!assessment.ok) {
        deps.logger?.candidateSkipped({ candidateId: row.instance_id, reason: assessment.reason });
        continue;
      }

      const candidate: Candidate = {
        id: row.instance_id,
        statement: row.problem_statement,
        language: row.language,
        testMaterial: testMaterialFrom(row),
        transitions: {
          failToPass: [...row.FAIL_TO_PASS],
          passToPass: [...row.PASS_TO_PASS],
        },
        timeout: assessment.timeout,
        goldPatch: encoder.encode(row.patch),
        provenance: {
          kind: "mined",
          timestamp: row.created_at,
          upstream: {
            dataset: inputs.upstream.dataset,
            revision: inputs.upstream.revision,
            instanceId: row.instance_id,
          },
        },
        rights: { sourceLicense: assessment.sourceLicense },
      };

      yield candidate;
    }
  },
};
