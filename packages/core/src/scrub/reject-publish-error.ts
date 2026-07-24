/**
 * Loud abort for reject-publish disposition (#1972 / design §3.2 A4/A5).
 *
 * Catastrophic content must fail closed with a class-named error — never
 * silent redact-and-continue.
 */

import type { Finding, ScrubClass } from './finding.js';
import { resolveDisposition, type PolicyTable } from './policy.js';
import { DEFAULT_POLICY } from './policy.js';

export class RejectPublishError extends Error {
  readonly scrubClass: ScrubClass;
  readonly findings: Finding[];

  constructor(scrubClass: ScrubClass, findings: Finding[] = []) {
    const evidence = findings[0]?.evidence?.join(', ') ?? scrubClass;
    super(
      `reject-publish: scrub class ${scrubClass} — publish aborted (${evidence})`,
    );
    this.name = 'RejectPublishError';
    this.scrubClass = scrubClass;
    this.findings = findings;
  }
}

/**
 * Findings whose policy disposition is reject-publish.
 *
 * A5 `drop-key` findings are structural removals, not catastrophic content:
 * the key-policy detector has already removed the entire attribute before
 * this guard runs. Only content-level A5 findings (such as an env-block
 * embedded in tool output) must abort the publish.
 */
export function rejectPublishFindings(
  findings: Finding[] | undefined,
  policy: PolicyTable = DEFAULT_POLICY,
): Finding[] {
  if (!findings?.length) return [];
  return findings.filter(
    (f) =>
      !f.evidence.includes('drop-key') &&
      resolveDisposition(f.class, f.confidence, policy) === 'reject-publish',
  );
}

/**
 * Throw a class-named {@link RejectPublishError} when reject-publish fired.
 * No-op when the result only has ordinary redacts / check-mode rejects.
 */
export function assertNoRejectPublish(
  result: { rejected?: boolean; findings?: Finding[] },
  policy: PolicyTable = DEFAULT_POLICY,
): void {
  const hits = rejectPublishFindings(result.findings, policy);
  if (hits.length === 0) return;
  // Prefer A4 over A5 when both fire (funds-controlling material first).
  const primary =
    hits.find((f) => f.class === 'A4') ??
    hits.find((f) => f.class === 'A5') ??
    hits[0]!;
  throw new RejectPublishError(
    primary.class,
    hits.filter((f) => f.class === primary.class),
  );
}
