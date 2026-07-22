/**
 * Map current-pipeline redactions + before/after text into approximate span
 * findings for the M0 baseline harness. Prefer exact original-span absence:
 * if a labeled substring is gone from the scrubbed output, emit a finding
 * covering that label. Extra stubs in output that do not match any label
 * become FP via orphan stub detection.
 */

import type { EvalFixture, ScoredFinding, ScrubClass } from './types.js';

/** Map known redaction `detail` / stage hints → ScrubClass. */
export function classFromRedactionDetail(detail: string | undefined, stage: string): ScrubClass | undefined {
  if (!detail) {
    if (stage === 'key-policy') return 'A5';
    return undefined;
  }
  const d = detail.toLowerCase();
  if (d.includes('email')) return 'B1';
  if (d.includes('home-path') || d.includes('home_path')) return 'D1';
  if (d.includes('eth-address') || d.includes('ethereum') || d.includes('eth_addr')) return 'C1';
  if (d.includes('aws') || d.includes('gcp') || d.includes('github') || d.includes('slack') || d.includes('npm') || d.includes('jwt') || d.includes('ssh') || d.includes('secret') || d.includes('token')) {
    return 'A1';
  }
  if (d.includes('high-entropy') || d.includes('entropy')) return 'A2';
  if (d.includes('person') || d.includes('per') || d.includes('name')) return 'B3';
  if (d.includes('phone')) return 'B5';
  if (d.includes('iban') || d.includes('credit') || d.includes('ssn') || d.includes('card') || d.includes('luhn')) return 'B7';
  if (d.includes('ipv4') || d === 'ip' || d.startsWith('ip-')) return 'D2';
  if (d.includes('host') || d.includes('machine-identity')) return 'D3';
  if (d.includes('url-') || d.includes('userinfo') || d.includes('query-credential')) return 'A3';
  if (d.includes('private-key') || d.includes('bip39') || d.includes('mnemonic')) return 'A4';
  if (d.includes('env-block')) return 'A5';
  if (d.includes('gitleaks')) return 'A1';
  // openredaction types often uppercase
  if (detail === 'EMAIL' || detail.includes('EMAIL')) return 'B1';
  if (detail.includes('ETHEREUM') || detail.includes('ETH')) return 'C1';
  if (detail.includes('PATH') || detail.includes('USERNAME')) return 'D1';
  return 'E1';
}

/**
 * Derive predicted findings for a fixture from original text, scrubbed text,
 * and redaction records. Uses label-survival for TP/FN and stub orphans for FP.
 */
export function findingsFromScrubResult(
  fixture: EvalFixture,
  scrubbedText: string,
  redactions: Array<{ stage: string; detail?: string }>,
): ScoredFinding[] {
  const findings: ScoredFinding[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < fixture.labels.length; i += 1) {
    const label = fixture.labels[i]!;
    const original = fixture.text.slice(label.start, label.end);
    if (!original) continue;
    // Survived → miss (no finding). Gone or replaced → predicted hit at label span.
    if (!scrubbedText.includes(original)) {
      findings.push({ class: label.class, start: label.start, end: label.end });
      claimed.add(i);
    }
  }

  // Orphan redactions (more redaction records than claimed labels of matching class)
  // approximate FPs when scrubbed diverges without a matching label.
  if (scrubbedText !== fixture.text) {
    const labeledClasses = new Set(fixture.labels.map((l) => l.class));
    for (const r of redactions) {
      const cls = classFromRedactionDetail(r.detail, r.stage);
      if (!cls) continue;
      if (!labeledClasses.has(cls)) {
        // Synthetic FP span at 0..0+1 so scoreClass counts it
        findings.push({ class: cls, start: 0, end: Math.min(1, fixture.text.length || 1) });
      }
    }
  }

  return findings;
}
