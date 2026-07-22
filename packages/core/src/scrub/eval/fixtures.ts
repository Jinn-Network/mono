import type { EvalFixture } from './types.js';

/** Helper: build a fixture with a single labeled span covering `needle` in `text`. */
function labeled(
  id: string,
  text: string,
  needle: string,
  cls: EvalFixture['labels'][number]['class'],
  opts: Partial<EvalFixture> = {},
): EvalFixture {
  const start = text.indexOf(needle);
  if (start < 0) throw new Error(`needle not found in fixture ${id}`);
  return {
    id,
    text,
    labels: [{ class: cls, start, end: start + needle.length }],
    profile: opts.profile ?? 'seed',
    ...opts,
  };
}

/**
 * Public synthetic fixtures for CI (#1968). No real PII — template shapes only.
 * Targets mirror design §3.2; baseline may miss some classes until later PRs.
 */
export function syntheticFixtures(): EvalFixture[] {
  return [
    labeled(
      'B1-email',
      'Contact the operator at alice.operator@example.com for access.',
      'alice.operator@example.com',
      'B1',
    ),
    labeled(
      'D1-home-path',
      'Working directory was /Users/synthuser/jinn-mono/client.',
      '/Users/synthuser',
      'D1',
    ),
    labeled(
      'C1-wallet',
      'Router lives at 0x1111222233334444555566667777888899990000 on Base.',
      '0x1111222233334444555566667777888899990000',
      'C1',
      { profile: 'seed' },
    ),
    labeled(
      'A1-github-pat-shape',
      'Export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd before running.',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd',
      'A1',
      { profile: 'trace' },
    ),
    labeled(
      'A1-aws-key-id',
      'Using key AKIAIOSFODNN7EXAMPLE in the dry-run.',
      'AKIAIOSFODNN7EXAMPLE',
      'A1',
      { profile: 'seed' },
    ),
    // Hazard: bare UUID must NOT be treated as a secret (batch-2 FP class).
    {
      id: 'hazard-uuid-not-secret',
      text: 'Task id a33f2ca5-e325-4749-b2b5-adaab30c5fc6 completed.',
      labels: [],
      profile: 'seed',
      mustSurvive: true,
    },
    // Hazard: bare 40-hex git SHA must survive (no 0x).
    {
      id: 'hazard-git-sha-survive',
      text: 'Pinned commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef in the lockfile.',
      labels: [],
      profile: 'seed',
      mustSurvive: true,
    },
    // Hazard: tx hash 0x+64 must survive C1 (C2 is flag-only later).
    {
      id: 'hazard-tx-hash-survive',
      text: 'Receipt 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa confirmed.',
      labels: [],
      profile: 'seed',
      mustSurvive: true,
    },
    // Hazard: env-var *reference* must not trip a token-name denylist.
    {
      id: 'hazard-env-ref-survive',
      text: 'curl -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user',
      labels: [],
      profile: 'seed',
      mustSurvive: true,
    },
    // B2 carrier — baseline may FN until #1970.
    labeled(
      'B2-git-author',
      'Author: Synth Operator <synth.operator@example.com>',
      'Synth Operator',
      'B2',
      { profile: 'seed' },
    ),
    // B4 self-handle — requires known-identity pack (#1971).
    {
      id: 'B4-self-handle',
      text: 'Operator login synth_operator_handle pushed the branch.',
      labels: [
        {
          class: 'B4',
          start: 'Operator login '.length,
          end: 'Operator login synth_operator_handle'.length,
        },
      ],
      profile: 'seed',
      identityPack: { ghLogin: 'synth_operator_handle' },
    },
    // D3 self-hostname — requires known-identity pack (#1971).
    {
      id: 'D3-self-hostname',
      text: 'attempt host=synth-laptop-01 completed.',
      labels: [
        {
          class: 'D3',
          start: 'attempt host='.length,
          end: 'attempt host=synth-laptop-01'.length,
        },
      ],
      profile: 'seed',
      identityPack: { hostname: 'synth-laptop-01' },
    },
    // Allowlist: loopback IP must survive (D2 pass, #1971 Q1).
    {
      id: 'allowlist-loopback-survive',
      text: 'Bind the health check to 127.0.0.1:7331 before serving.',
      labels: [],
      mustSurvive: true,
      profile: 'seed',
    },
  ];
}

/**
 * Corruption corpus: known-clean prose that must stay byte-identical.
 * Includes #1784 residual samples that seed profile intentionally leaves alone,
 * plus a short excerpt shape from distractor-operator-claims (no secrets).
 */
export function corruptionFixtures(): EvalFixture[] {
  const residuals = [
    'Customer card: 4111 1111 1111 1111.',
    'Call the customer at +1 (415) 555-2671.',
    'Reporter SSN on file: 123-45-6789.',
    'Medical record MRN: MED123456.',
    'The operator claims the flake is environmental, not a product defect.',
    'Catalog number SKU-7781 maps to the distractor fixture.',
  ];
  return residuals.map((text, i) => ({
    id: `corruption-${i}`,
    text,
    labels: [],
    mustSurvive: true,
    profile: 'seed' as const,
  }));
}

export function allCiFixtures(): EvalFixture[] {
  return [...syntheticFixtures(), ...corruptionFixtures()];
}
