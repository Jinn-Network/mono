/**
 * Apply policy dispositions to an attribute bag after one detection pass
 * (#1969 / design §6.5).
 */

import type { Finding, ScrubClass } from './finding.js';
import {
  DEFAULT_POLICY,
  checkModeRejects,
  resolveDisposition,
  type Disposition,
  type PolicyTable,
} from './policy.js';
import { incrementPerClassCount } from './provenance.js';
import { assertNoRejectPublish } from './reject-publish-error.js';
import {
  findingFingerprint,
  type ReviewDecision,
  type ReviewQueueStore,
} from './review-queue.js';
import type { Attributes, RedactionRecord } from './types.js';

export { RejectPublishError, assertNoRejectPublish, rejectPublishFindings } from './reject-publish-error.js';

export interface ApplyDispositionsOptions {
  policy?: PolicyTable;
  /**
   * Check-mode consumers (layer-2 distill, episode refuse): any non-pass
   * disposition rejects. Still applies redacts so the body change is visible.
   */
  checkMode?: boolean;
  /**
   * Optional review-queue store. When provided, resolved flags are honored
   * (`approve-instance` → pass, `redact-instance` → redact, allowlist /
   * identity-pack → pass). Unresolved flags stay as `flag` and are listed in
   * {@link ApplyDispositionsResult.unresolvedFlags}.
   */
  reviewStore?: ReviewQueueStore;
}

export interface ApplyDispositionsResult {
  attributes: Attributes;
  redactions: RedactionRecord[];
  findings: Finding[];
  /** True when a reject-publish disposition fired, or check-mode saw a non-pass. */
  rejected: boolean;
  /** Flag findings that remain unresolved after consulting the review queue. */
  unresolvedFlags: Finding[];
  /**
   * Applied disposition counts keyed `${ScrubClass}:${redact|flag|reject}`
   * (#1974). Pass dispositions are omitted.
   */
  perClassCounts: Record<string, number>;
}

/** Stub text for a redact disposition, keyed by class (+ optional evidence hint). */
export function stubForFinding(finding: Finding, occurrenceIndex: number): string {
  const hint = finding.evidence[0] ?? '';
  switch (finding.class) {
    case 'B1':
      return '[EMAIL]';
    case 'B2':
      // Joint carrier: user.email values stub as email; names as NAME.
      if (hint.includes('email')) return '[EMAIL]';
      return '[NAME]';
    case 'D1':
      return '/users/anon';
    case 'C1':
      return `[ETH_ADDR_${occurrenceIndex}]`;
    case 'B3':
      return '[NAME]';
    case 'B4':
      return '[USERNAME]';
    case 'D2':
      return '[IP]';
    case 'D3':
      return '[HOSTNAME]';
    case 'A1':
      if (hint.includes('aws-access-key-id')) return '[SECRET:aws-access-key-id]';
      if (hint.includes('gcp-api-key')) return '[SECRET:gcp-api-key]';
      if (hint.startsWith('secret:')) return `[SECRET:${hint.slice('secret:'.length)}]`;
      return '[SECRET:redacted]';
    case 'A2':
      return '[SECRET:high-entropy]';
    case 'A3':
      return '[SECRET:url-credential]';
    case 'B7':
      if (hint.includes('iban')) return '[IBAN]';
      return '[CARD]';
    default: {
      if (hint.startsWith('ml:')) {
        return `[PII:${hint.slice('ml:'.length)}]`;
      }
      if (hint.startsWith('gitleaks:')) {
        return `[SECRET:${hint.slice('gitleaks:'.length)}]`;
      }
      const label = hint || finding.class;
      return `[PII:${label}]`;
    }
  }
}

function redactionKind(scrubClass: ScrubClass, _finding: Finding): string {
  if (scrubClass.startsWith('A')) return 'secret';
  return 'pii';
}

function redactionDetail(finding: Finding): string | undefined {
  const hint = finding.evidence[0] ?? finding.class;
  if (hint === 'drop-key' || hint === 'machine-identity-key') return undefined;
  // Normalize C1 to the shipped detail id so seed/trace/layer2 records match.
  if (finding.class === 'C1') return 'eth-address';
  if (hint.startsWith('secret:')) return hint.slice('secret:'.length);
  if (hint.startsWith('gitleaks:')) return hint.slice('gitleaks:'.length);
  if (hint.startsWith('ml:')) return hint.slice('ml:'.length);
  return hint;
}

function isKeyDropFinding(finding: Finding): boolean {
  return (
    finding.evidence.includes('drop-key') ||
    finding.evidence.includes('machine-identity-key')
  );
}

function decisionOverridesFlag(decision: ReviewDecision | undefined): Disposition | undefined {
  if (decision === 'redact-instance') return 'redact';
  if (
    decision === 'approve-instance' ||
    decision === 'add-to-allowlist' ||
    decision === 'add-to-identity-pack'
  ) {
    return 'pass';
  }
  return undefined;
}

function effectiveDisposition(
  finding: Finding,
  policy: PolicyTable,
  checkMode: boolean,
  reviewStore?: ReviewQueueStore,
): Disposition {
  let disposition = resolveDisposition(finding.class, finding.confidence, policy);
  if (disposition === 'flag' && reviewStore) {
    const override = decisionOverridesFlag(reviewStore.resolutionFor(finding));
    if (override) disposition = override;
  }
  if (checkMode && disposition !== 'pass') {
    // Check-mode still applies the underlying redact/reject action; the
    // rejected bit is set separately via checkModeRejects.
    return disposition;
  }
  return disposition;
}

/**
 * Apply dispositions. Span redacts are applied right-to-left per key so earlier
 * offsets stay valid. A5 reject-publish on a drop-key finding removes the key.
 */
export function applyDispositions(
  attributes: Attributes,
  findings: Finding[],
  opts: ApplyDispositionsOptions = {},
): ApplyDispositionsResult {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const checkMode = opts.checkMode ?? false;
  const reviewStore = opts.reviewStore;
  const out: Attributes = { ...attributes };
  const redactions: RedactionRecord[] = [];
  const unresolvedFlags: Finding[] = [];
  const perClassCounts: Record<string, number> = {};
  let rejected = false;

  // Key-drop findings first (A5 structural drop-key, D3 machine-identity).
  // Structural key drops remove the attribute; they do NOT reject-publish in
  // redact-mode (content-level A4/A5 spans own the loud abort). Check-mode
  // still rejects so distill stays fail-closed on any non-pass.
  for (const finding of findings) {
    if (!isKeyDropFinding(finding)) continue;
    const disposition = effectiveDisposition(finding, policy, checkMode, reviewStore);
    if (disposition === 'pass') continue;
    delete out[finding.span.key];
    redactions.push({
      key: finding.span.key,
      stage: finding.detector.name,
      kind: 'dropped-key',
    });
    // Structural drops are applied as redacts (key removed), even when the
    // policy row for A5 content is reject-publish.
    incrementPerClassCount(perClassCounts, finding.class, 'redact');
    if (checkMode) rejected = true;
  }

  // Group remaining span findings by key, apply right-to-left.
  const byKey = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (isKeyDropFinding(finding)) continue;
    if (!(finding.span.key in out)) continue;
    const list = byKey.get(finding.span.key) ?? [];
    list.push(finding);
    byKey.set(finding.span.key, list);
  }

  for (const [key, keyFindings] of byKey) {
    const value = out[key];
    if (typeof value !== 'string') continue;

    const sorted = [...keyFindings].sort((a, b) => b.span.start - a.span.start);
    const covered: Array<{ start: number; end: number }> = [];
    let text = value;
    // Collect redact records left-to-right (unshift while applying right-to-left)
    // so callers that pin redaction order keep a stable, start-ascending list.
    const redactRecords: RedactionRecord[] = [];

    for (const finding of sorted) {
      const disposition = effectiveDisposition(finding, policy, checkMode, reviewStore);
      if (disposition === 'pass') {
        // Auditable allowlist hit (§6.4): record "we saw it and passed it on purpose".
        const allowEvidence = finding.evidence.find((e) => e.startsWith('allowlist:'));
        if (allowEvidence) {
          redactions.push({
            key,
            stage: finding.detector.name,
            kind: 'allowlist-pass',
            detail: allowEvidence.slice('allowlist:'.length),
          });
        }
        continue;
      }

      if (disposition === 'reject-publish') {
        rejected = true;
        redactions.push({
          key,
          stage: finding.detector.name,
          kind: redactionKind(finding.class, finding),
          detail: redactionDetail(finding),
        });
        incrementPerClassCount(perClassCounts, finding.class, disposition);
        continue;
      }

      if (disposition === 'flag') {
        unresolvedFlags.push(finding);
        incrementPerClassCount(perClassCounts, finding.class, disposition);
        // In redact-mode leave text (review queue owns the hold). In check-mode,
        // record so consumers reject.
        if (checkMode) {
          rejected = true;
          redactions.push({
            key,
            stage: finding.detector.name,
            kind: 'flag',
            detail: redactionDetail(finding),
          });
        }
        continue;
      }

      // redact
      const { start, end } = finding.span;
      if (start < 0 || end > text.length || start >= end) continue;
      if (covered.some((c) => start < c.end && end > c.start)) continue;

      const leftIndex = keyFindings.filter((f) => {
        if (effectiveDisposition(f, policy, checkMode, reviewStore) !== 'redact') return false;
        return f.span.start < start;
      }).length;
      const stub = stubForFinding(finding, leftIndex);
      text = text.slice(0, start) + stub + text.slice(end);
      covered.push({ start, end });
      redactRecords.unshift({
        key,
        stage: finding.detector.name,
        kind: redactionKind(finding.class, finding),
        detail: redactionDetail(finding),
      });
      incrementPerClassCount(perClassCounts, finding.class, disposition);
      if (checkMode) rejected = true;
    }

    redactions.push(...redactRecords);
    out[key] = text;
  }

  if (checkMode && checkModeRejects(findings, policy)) {
    rejected = true;
  }

  // Dedupe unresolved flags by fingerprint (nested walks can re-emit).
  const seen = new Set<string>();
  const uniqueUnresolved = unresolvedFlags.filter((f) => {
    const fp = findingFingerprint(f);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });

  return {
    attributes: out,
    redactions,
    findings,
    rejected,
    unresolvedFlags: uniqueUnresolved,
    perClassCounts,
  };
}

/**
 * True when publish/check should refuse the item.
 *
 * For reject-publish classes (A4/A5 content), prefer
 * {@link assertNoRejectPublish} so the abort is a loud class-named error.
 * For unresolved flags, prefer {@link assertNoUnresolvedFlags} from
 * `review-queue.ts`.
 */
export function shouldRejectPublish(result: {
  rejected?: boolean;
  redactions: RedactionRecord[];
  findings?: Finding[];
  unresolvedFlags?: Finding[];
}): boolean {
  if (result.rejected) return true;
  if (result.unresolvedFlags && result.unresolvedFlags.length > 0) return true;
  return result.redactions.length > 0;
}

/**
 * Apply dispositions, then abort loudly when a reject-publish class fired.
 * Use at publish altitude (capture/emit) — not for check-mode distill, which
 * maps redactions to rejection reasons without throwing.
 */
export function applyDispositionsOrReject(
  attributes: Attributes,
  findings: Finding[],
  opts: ApplyDispositionsOptions = {},
): ApplyDispositionsResult {
  const applied = applyDispositions(attributes, findings, opts);
  assertNoRejectPublish(applied, opts.policy ?? DEFAULT_POLICY);
  return applied;
}
