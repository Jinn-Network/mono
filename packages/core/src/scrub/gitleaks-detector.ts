/**
 * Vendored gitleaks rule pack — A1 (#1972 / design §6.2, Q6).
 *
 * Small pinned MIT subset. Refresh manually; no build-time sync.
 * Regexes are JS-adapted (no Go inline flag verbs).
 */

import { GITLEAKS_PACK } from './data/gitleaks-rules.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '1.0.0';

export type GitleaksRule = (typeof GITLEAKS_PACK.rules)[number];
export type GitleaksPack = typeof GITLEAKS_PACK;

export function loadGitleaksPack(): GitleaksPack {
  return GITLEAKS_PACK;
}

export function gitleaksDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'gitleaks', version: VERSION };
  const pack = loadGitleaksPack();
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        for (const rule of pack.rules) {
          const re = new RegExp(rule.regex, 'gi');
          let m: RegExpExecArray | null;
          while ((m = re.exec(value)) !== null) {
            const full = m[0]!;
            if (!full) continue;
            findings.push({
              class: 'A1',
              span: { key, start: m.index, end: m.index + full.length },
              confidence: 'VERY_HIGH',
              evidence: [`gitleaks:${rule.id}`],
              detector: meta,
            });
            if (m[0]!.length === 0) re.lastIndex += 1;
          }
        }
      }
      return findings;
    },
  };
}
