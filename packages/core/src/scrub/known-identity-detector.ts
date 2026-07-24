/**
 * Known-identity pack + non-address instance allowlist (#1971 / design §6.4).
 *
 * Locked Q1: stub ALL address-shaped values (no address pass-allowlist). The
 * pack exact-matches operator self-PII only. The allowlist covers loopback /
 * reserved IPs and repo-slug patterns — never wallets.
 */

import { applyDispositions } from './apply-dispositions.js';
import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Detector, Finding, ScrubClass } from './finding.js';
import type { Attributes, ScrubStage } from './types.js';

const VERSION = '0.1.0';

/** Operator self-PII assembled locally. No addresses (Q1). */
export interface KnownIdentityPack {
  gitUserName?: string;
  gitUserEmail?: string;
  homeUsername?: string;
  hostname?: string;
  ghLogin?: string;
}

export type InstanceAllowlistKind = 'loopback-ip' | 'reserved-ip' | 'repo-slug';

export interface InstanceAllowlistEntry {
  /** Exact value matched in content (case-insensitive for slugs/IPs). */
  value: string;
  kind: InstanceAllowlistKind;
  /** Auditable provenance note recorded in the redaction manifest. */
  provenance: string;
}

export interface InstanceAllowlist {
  entries: InstanceAllowlistEntry[];
}

export interface AssembledKnownIdentity {
  pack: KnownIdentityPack;
  allowlist: InstanceAllowlist;
}

export interface AssembleKnownIdentityOptions {
  /** Injected pack (tests / daemon). Wins over env/homedir fillers. */
  pack?: KnownIdentityPack;
  /** Extra allowlist entries merged onto the built-in non-address defaults. */
  allowlist?: InstanceAllowlist;
  /** Optional env (daemon). Only used to fill pack gaps. */
  env?: NodeJS.ProcessEnv;
  /** Optional homedir provider — basename becomes homeUsername when unset. */
  homedir?: () => string;
  /** Optional hostname provider. */
  hostname?: () => string;
}

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

/** Built-in non-address public values (Q1): loopback + common reserved. */
export const DEFAULT_INSTANCE_ALLOWLIST: InstanceAllowlist = {
  entries: [
    { value: '127.0.0.1', kind: 'loopback-ip', provenance: 'RFC 1122 loopback' },
    { value: '0.0.0.0', kind: 'reserved-ip', provenance: 'RFC 1122 this-host' },
    { value: '::1', kind: 'loopback-ip', provenance: 'IPv6 loopback' },
  ],
};

type PackField = {
  key: keyof KnownIdentityPack;
  scrubClass: ScrubClass;
  evidence: string;
};

const PACK_FIELDS: PackField[] = [
  { key: 'gitUserName', scrubClass: 'B3', evidence: 'known-identity:git-user-name' },
  { key: 'gitUserEmail', scrubClass: 'B1', evidence: 'known-identity:git-user-email' },
  { key: 'homeUsername', scrubClass: 'B4', evidence: 'known-identity:home-username' },
  { key: 'hostname', scrubClass: 'D3', evidence: 'known-identity:hostname' },
  { key: 'ghLogin', scrubClass: 'B4', evidence: 'known-identity:gh-login' },
];

export function isAddressShaped(value: string): boolean {
  return ETH_ADDRESS_RE.test(value.trim());
}

function normalizeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizePack(pack: KnownIdentityPack): KnownIdentityPack {
  const out: KnownIdentityPack = {};
  for (const field of PACK_FIELDS) {
    const v = normalizeToken(pack[field.key]);
    if (!v) continue;
    // Q1: never put addresses into the redact pack.
    if (isAddressShaped(v)) continue;
    out[field.key] = field.key === 'gitUserEmail' ? v.toLowerCase() : v;
  }
  return out;
}

function filterAllowlist(entries: InstanceAllowlistEntry[]): InstanceAllowlistEntry[] {
  const seen = new Set<string>();
  const out: InstanceAllowlistEntry[] = [];
  for (const entry of entries) {
    const value = normalizeToken(entry.value);
    if (!value) continue;
    // Q1: no address pass-allowlist.
    if (isAddressShaped(value)) continue;
    const key = `${entry.kind}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...entry, value });
  }
  return out;
}

/**
 * Assemble pack + allowlist from injected options, optionally filling gaps from
 * env/homedir. Injectable pack is enough for this PR; daemon wiring stays thin.
 */
export function assembleKnownIdentity(
  opts: AssembleKnownIdentityOptions = {},
): AssembledKnownIdentity {
  const env = opts.env ?? {};
  const pack: KnownIdentityPack = { ...(opts.pack ?? {}) };

  if (!pack.gitUserName && env.GIT_AUTHOR_NAME) {
    pack.gitUserName = env.GIT_AUTHOR_NAME;
  }
  if (!pack.gitUserEmail && env.GIT_AUTHOR_EMAIL) {
    pack.gitUserEmail = env.GIT_AUTHOR_EMAIL;
  }
  if (!pack.ghLogin && (env.GH_USER || env.GITHUB_USER)) {
    pack.ghLogin = env.GH_USER || env.GITHUB_USER;
  }
  if (!pack.homeUsername && opts.homedir) {
    try {
      const home = opts.homedir();
      const base = home.split(/[/\\]/).filter(Boolean).pop();
      if (base) pack.homeUsername = base;
    } catch {
      // ignore — injectable pack is the primary path
    }
  }
  if (!pack.hostname && opts.hostname) {
    try {
      pack.hostname = opts.hostname();
    } catch {
      // ignore
    }
  }

  const entries = [
    ...DEFAULT_INSTANCE_ALLOWLIST.entries,
    ...(opts.allowlist?.entries ?? []),
  ];

  return {
    pack: normalizePack(pack),
    allowlist: { entries: filterAllowlist(entries) },
  };
}

function isLoopbackOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 0) return true; // this-host
  if (a === 169 && b === 254) return true; // link-local
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exact match with word-ish boundaries so `ann` does not hit `canonical`.
 * Multi-word needles match the full phrase.
 */
function findExactSpans(text: string, needle: string): Array<{ start: number; end: number }> {
  if (needle.length < 2) return [];
  const re = new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`,
    'gi',
  );
  const spans: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0]!.length });
  }
  return spans;
}

function allowlistHit(
  matched: string,
  allowlist: InstanceAllowlist,
): InstanceAllowlistEntry | undefined {
  const lower = matched.toLowerCase();
  return allowlist.entries.find((e) => e.value.toLowerCase() === lower);
}

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && a.end > b.start;
}

export interface KnownIdentityDetectorOptions {
  pack?: KnownIdentityPack;
  allowlist?: InstanceAllowlist;
  /** Pre-assembled identity; when set, pack/allowlist options are ignored. */
  assembled?: AssembledKnownIdentity;
}

/**
 * Detector: pack → VERY_HIGH redact findings; allowlist → pass findings with
 * auditable evidence; public IPs → D2 redact; private IPs → D2 flag band.
 */
export function knownIdentityDetector(
  policy: KeyPolicy,
  opts: KnownIdentityDetectorOptions = {},
): Detector {
  const assembled =
    opts.assembled ??
    assembleKnownIdentity({ pack: opts.pack, allowlist: opts.allowlist });
  const meta = { name: 'known-identity', version: VERSION };

  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      const allowlistSpansByKey = new Map<string, Array<{ start: number; end: number }>>();

      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        const keyAllowlistSpans: Array<{ start: number; end: number }> = [];

        // --- Instance allowlist exact matches (pass + manifest) ---
        for (const entry of assembled.allowlist.entries) {
          for (const span of findExactSpans(value, entry.value)) {
            keyAllowlistSpans.push(span);
            findings.push({
              class: entry.kind === 'repo-slug' ? 'B4' : 'D2',
              span: { key, start: span.start, end: span.end },
              confidence: 'VERY_LOW',
              evidence: [`allowlist:${entry.kind}`, `provenance:${entry.provenance}`],
              detector: meta,
            });
          }
        }

        // --- IPv4 shapes (D2), classified against allowlist / ranges ---
        const ipRe = new RegExp(IPV4_RE.source, 'g');
        let ipMatch: RegExpExecArray | null;
        while ((ipMatch = ipRe.exec(value)) !== null) {
          const ip = ipMatch[0]!;
          const span = { start: ipMatch.index, end: ipMatch.index + ip.length };
          const listed = allowlistHit(ip, assembled.allowlist);
          if (listed || isLoopbackOrReservedIpv4(ip)) {
            if (!keyAllowlistSpans.some((s) => overlaps(s, span))) {
              keyAllowlistSpans.push(span);
              const kind: InstanceAllowlistKind = listed?.kind
                ?? (ip.startsWith('127.') || ip === '0.0.0.0' ? 'loopback-ip' : 'reserved-ip');
              const provenance = listed?.provenance
                ?? (isLoopbackOrReservedIpv4(ip) ? 'RFC reserved/loopback' : 'allowlist');
              findings.push({
                class: 'D2',
                span: { key, start: span.start, end: span.end },
                confidence: 'VERY_LOW',
                evidence: [`allowlist:${kind}`, `provenance:${provenance}`],
                detector: meta,
              });
            }
            continue;
          }
          if (isPrivateIpv4(ip)) {
            findings.push({
              class: 'D2',
              span: { key, start: span.start, end: span.end },
              confidence: 'MEDIUM',
              evidence: ['ip-address', 'private-range'],
              detector: meta,
            });
            continue;
          }
          findings.push({
            class: 'D2',
            span: { key, start: span.start, end: span.end },
            confidence: 'VERY_HIGH',
            evidence: ['ip-address'],
            detector: meta,
          });
        }

        allowlistSpansByKey.set(key, keyAllowlistSpans);

        // --- Known-identity pack exact matches ---
        for (const field of PACK_FIELDS) {
          const needle = assembled.pack[field.key];
          if (!needle) continue;
          // Allowlist suppresses pack hits on the same span (e.g. slug == handle).
          for (const span of findExactSpans(value, needle)) {
            if (keyAllowlistSpans.some((s) => overlaps(s, span))) continue;
            findings.push({
              class: field.scrubClass,
              span: { key, start: span.start, end: span.end },
              confidence: 'VERY_HIGH',
              evidence: [field.evidence],
              detector: meta,
            });
          }
        }
      }

      // Drop non-allowlist findings that overlap an allowlisted span (same key).
      // Never suppress C1 — addresses are not allowlisted (Q1); this only covers
      // pack/D2 collisions on non-address public values.
      return findings.filter((f) => {
        if (f.evidence.some((e) => e.startsWith('allowlist:'))) return true;
        if (f.class === 'C1') return true;
        const spans = allowlistSpansByKey.get(f.span.key) ?? [];
        return !spans.some((s) => overlaps(s, f.span));
      });
    },
  };
}

/** Legacy ScrubStage wrapper for stage-chain tests. */
export function knownIdentityStage(
  policy: KeyPolicy,
  opts: KnownIdentityDetectorOptions = {},
): ScrubStage {
  const detector = knownIdentityDetector(policy, opts);
  return {
    name: detector.name,
    version: detector.version,
    scrub(attributes: Attributes) {
      const findings = detector.detect(attributes) as Finding[];
      return applyDispositions(attributes, findings);
    },
  };
}
