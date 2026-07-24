/**
 * B7 — checksummed payment instruments (#1972 / design §6.2).
 *
 * Card numbers (Luhn) and IBANs (mod-97). SSN-shape stays context-gated and is
 * not emitted here.
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '1.0.0';

/** 13–19 digit runs, optional spaces/dashes between digit groups. */
const CARD_CANDIDATE =
  /\b(?:\d[ -]*?){13,19}\b/g;

/** IBAN: country + check digits + BBAN (no internal spaces in the candidate). */
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;

/** Spaced IBAN groups (e.g. GB82 WEST 1234 5698 7654 32). */
const IBAN_SPACED =
  /\b[A-Z]{2}\d{2}(?:[ ][A-Z0-9]{4}){2,7}(?:[ ][A-Z0-9]{1,4})?\b/gi;

export function checksummedInstrumentsDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'checksummed-instruments', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        findings.push(...scanCards(value, key, meta));
        findings.push(...scanIbans(value, key, meta));
      }
      return findings;
    },
  };
}

function scanCards(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const re = new RegExp(CARD_CANDIDATE.source, CARD_CANDIDATE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]!;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    // Skip obvious non-cards (all same digit, leading zeros-only short ids).
    if (/^(\d)\1+$/.test(digits)) continue;
    if (!luhnOk(digits)) continue;
    findings.push({
      class: 'B7',
      span: { key, start: m.index, end: m.index + raw.length },
      confidence: 'VERY_HIGH',
      evidence: ['card-luhn'],
      detector,
    });
  }
  return findings;
}

function scanIbans(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const pattern of [IBAN_CANDIDATE, IBAN_SPACED]) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0]!;
      const compact = raw.replace(/\s+/g, '').toUpperCase();
      if (compact.length < 15 || compact.length > 34) continue;
      if (!ibanMod97Ok(compact)) continue;
      const spanKey = `${m.index}:${m.index + raw.length}`;
      if (seen.has(spanKey)) continue;
      seen.add(spanKey);
      findings.push({
        class: 'B7',
        span: { key, start: m.index, end: m.index + raw.length },
        confidence: 'VERY_HIGH',
        evidence: ['iban-mod97'],
        detector,
      });
    }
  }
  return findings;
}

/** ISO/IEC 7812 Luhn checksum. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** ISO 13616 IBAN mod-97 check. */
export function ibanMod97Ok(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') expanded += ch;
    else if (ch >= 'A' && ch <= 'Z') expanded += String(ch.charCodeAt(0) - 55);
    else return false;
  }
  // Progressive mod to avoid BigInt dependency for typical IBAN lengths.
  let rest = 0;
  for (const ch of expanded) {
    rest = (rest * 10 + (ch.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}
