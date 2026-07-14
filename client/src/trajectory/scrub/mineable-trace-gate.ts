/**
 * Mineable-trace consent gate (spec/2026-07-08-task-creator-v0.md §10, D2).
 *
 * `jinn.mineable.*` attributes are dropped unless tier-1 consent is
 * `retain_local`. Other `jinn.*` keys remain structural/safe per default policy.
 */

import type { CaptureManifest } from '../schema.js';
import type { Attributes, RedactionRecord, ScrubResult, ScrubStage } from './types.js';

const VERSION = '0.1.0';
const MINEABLE_PREFIX = 'jinn.mineable.';

function isMineableKey(key: string): boolean {
  return key.startsWith(MINEABLE_PREFIX);
}

export function mineableTraceGateStage(consent: CaptureManifest['mineableTraceConsent']): ScrubStage {
  return {
    name: 'mineable-trace-gate',
    version: VERSION,
    scrub(attributes: Attributes): ScrubResult {
      if (consent === 'retain_local') {
        return { attributes, redactions: [] };
      }
      const out: Attributes = {};
      const redactions: RedactionRecord[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (isMineableKey(key)) {
          redactions.push({ key, stage: 'mineable-trace-gate', kind: 'dropped-key' });
          continue;
        }
        out[key] = value;
      }
      return { attributes: out, redactions };
    },
  };
}
