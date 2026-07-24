/**
 * Reject-publish content detectors — A4 / content-A5 (#1972 / design §3.2).
 *
 * A4: 64-hex private-key material in key context; BIP-39 12/24-word mnemonic runs.
 * A5: env-block dumps (`KEY=value` line runs inside tool output).
 *
 * Bare git SHAs (40-hex) and `0x`+64 tx digests are carved out — never swept.
 */

import { BIP39_ENGLISH } from './data/bip39-english.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '1.0.0';

let bip39Words: Set<string> | null = null;

function loadBip39(): Set<string> {
  if (bip39Words) return bip39Words;
  bip39Words = new Set(BIP39_ENGLISH);
  return bip39Words;
}

/**
 * Keywords that put a nearby 64-hex run in private-key context.
 * Deliberately excludes bare "key" / "hash" / "digest" / "sha".
 */
const KEY_CONTEXT =
  /\b(?:private[_\s-]?key|privkey|secret[_\s-]?key|wallet[_\s-]?key|eth(?:ereum)?[_\s-]?private|signing[_\s-]?key|hex[_\s-]?(?:private|secret)|mnemonic|seed[_\s-]?phrase|xprv|wif)\b/i;

/** Optional 0x-prefixed or bare 64-hex. */
const HEX64 = /\b(?:0x)?([a-fA-F0-9]{64})\b/g;

/** ENV-style assignment line. */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=.*$/;
const ENV_KEY = /^([A-Z][A-Z0-9_]*)=/;
/** Git's GIT_CONFIG_* override tutorial shape — not a secret dump (#2005). */
const GIT_CONFIG_ENV_KEY = /^GIT_CONFIG(?:_|$)/i;
const MIN_ENV_RUN = 3;

export function rejectClassesDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'reject-classes', version: VERSION };
  const wordlist = loadBip39();
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        findings.push(...scanPrivateKeys(value, key, meta));
        findings.push(...scanMnemonics(value, key, meta, wordlist));
        findings.push(...scanEnvBlocks(value, key, meta));
      }
      return findings;
    },
  };
}

function scanPrivateKeys(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  if (!KEY_CONTEXT.test(text)) return [];
  // Reset lastIndex after .test on global-less regex — KEY_CONTEXT has /i only.
  const findings: Finding[] = [];
  const re = new RegExp(HEX64.source, HEX64.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const full = m[0]!;
    // Carve-out: 0x+64 is a tx digest (C2), not a private key span by shape alone.
    // Only fire when the match is bare 64-hex (no 0x) — wallet hex keys are typically
    // written without the 0x prefix next to "private key" context, while receipts use 0x.
    if (full.startsWith('0x') || full.startsWith('0X')) continue;
    // Windowed context: require a key-context keyword within ±80 chars.
    const windowStart = Math.max(0, m.index - 80);
    const windowEnd = Math.min(text.length, m.index + full.length + 80);
    const window = text.slice(windowStart, windowEnd);
    if (!KEY_CONTEXT.test(window)) continue;
    findings.push({
      class: 'A4',
      span: { key, start: m.index, end: m.index + full.length },
      confidence: 'VERY_HIGH',
      evidence: ['private-key-hex64'],
      detector,
    });
  }
  return findings;
}

function scanMnemonics(
  text: string,
  key: string,
  detector: { name: string; version: string },
  wordlist: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  // Tokenize on whitespace / commas / quotes while keeping offsets.
  const tokenRe = /[A-Za-z]+/g;
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(text)) !== null) {
    tokens.push({
      word: tm[0]!.toLowerCase(),
      start: tm.index,
      end: tm.index + tm[0]!.length,
    });
  }

  let i = 0;
  while (i < tokens.length) {
    if (!wordlist.has(tokens[i]!.word)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < tokens.length && wordlist.has(tokens[j]!.word)) j += 1;
    const runTokens = tokens.slice(i, j);
    // Sliding windows: a longer wordlist run (e.g. "phrase" + 12 mnemonic words)
    // still contains a 12/24 mnemonic.
    for (const len of [24, 12] as const) {
      if (runTokens.length < len) continue;
      for (let start = 0; start + len <= runTokens.length; start += 1) {
        const window = runTokens.slice(start, start + len);
        let contiguous = true;
        for (let k = 0; k < window.length - 1; k += 1) {
          const gap = text.slice(window[k]!.end, window[k + 1]!.start);
          if (!/^[\s,;|"']+$/.test(gap)) {
            contiguous = false;
            break;
          }
        }
        if (!contiguous) continue;
        findings.push({
          class: 'A4',
          span: { key, start: window[0]!.start, end: window[len - 1]!.end },
          confidence: 'VERY_HIGH',
          evidence: [`bip39-mnemonic-${len}`],
          detector,
        });
        // One hit per run length is enough — avoid overlapping spam.
        break;
      }
    }
    i = j;
  }
  return findings;
}

function scanEnvBlocks(
  text: string,
  key: string,
  detector: { name: string; version: string },
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let runStart = -1;
  let runStartOffset = 0;
  let runEndOffset = 0;
  let runCount = 0;

  const flush = () => {
    if (runCount >= MIN_ENV_RUN && runStart >= 0) {
      findings.push({
        class: 'A5',
        span: { key, start: runStartOffset, end: runEndOffset },
        confidence: 'VERY_HIGH',
        evidence: ['env-block'],
        detector,
      });
    }
    runStart = -1;
    runCount = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0); // +1 for \n except last
    const trimmed = line.trim();
    // Allow optional leading export / whitespace.
    const candidate = trimmed.replace(/^export\s+/, '');
    if (isEnvBlockAssignment(candidate)) {
      if (runStart < 0) {
        runStart = i;
        runStartOffset = offset + (line.length - line.trimStart().length);
      }
      runCount += 1;
      runEndOffset = offset + line.length;
    } else if ((trimmed === '' || isGitConfigEnvAssignment(candidate)) && runCount > 0) {
      // Blank and GIT_CONFIG tutorial lines inside a dump keep the run open,
      // but do not increment it — only flush on another non-env line.
    } else {
      flush();
    }
    offset += lineLen;
  }
  flush();
  return findings;
}

function isEnvBlockAssignment(candidate: string): boolean {
  if (!ENV_LINE.test(candidate)) return false;
  const keyMatch = ENV_KEY.exec(candidate);
  if (!keyMatch) return false;
  return !GIT_CONFIG_ENV_KEY.test(keyMatch[1]!);
}

function isGitConfigEnvAssignment(candidate: string): boolean {
  if (!ENV_LINE.test(candidate)) return false;
  const keyMatch = ENV_KEY.exec(candidate);
  return keyMatch !== null && GIT_CONFIG_ENV_KEY.test(keyMatch[1]!);
}
