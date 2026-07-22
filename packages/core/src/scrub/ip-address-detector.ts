/**
 * D2 — IPv4 addresses with range classification (#1972 / design §3.2 / §6.2).
 *
 * - public → VERY_HIGH (redact)
 * - private (RFC1918 / link-local) → MEDIUM (flag)
 * - loopback / unspecified / broadcast / documentation → no finding (pass)
 */

import { classifyKey, type KeyPolicy } from './key-policy.js';
import type { Band, Detector, Finding } from './finding.js';
import type { Attributes } from './types.js';

const VERSION = '1.0.0';

const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

export type IpRangeClass = 'public' | 'private' | 'loopback' | 'reserved';

export function classifyIpv4(ip: string): IpRangeClass {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'reserved';
  }
  const [a, b] = parts as [number, number, number, number];

  // Loopback 127.0.0.0/8
  if (a === 127) return 'loopback';
  // Unspecified
  if (a === 0) return 'reserved';
  // Broadcast
  if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) return 'reserved';
  // Current network / this host on this network historically
  // Link-local 169.254.0.0/16
  if (a === 169 && b === 254) return 'reserved';
  // Multicast 224.0.0.0/4
  if (a >= 224 && a <= 239) return 'reserved';
  // Reserved for future / class E
  if (a >= 240) return 'reserved';
  // Documentation (TEST-NET)
  if (a === 192 && b === 0 && parts[2] === 2) return 'reserved';
  if (a === 198 && b === 51 && parts[2] === 100) return 'reserved';
  if (a === 203 && b === 0 && parts[2] === 113) return 'reserved';
  // RFC1918 private
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';

  return 'public';
}

export function ipAddressDetector(policy: KeyPolicy): Detector {
  const meta = { name: 'ip-address', version: VERSION };
  return {
    ...meta,
    detect(attributes: Attributes): Finding[] {
      const findings: Finding[] = [];
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value !== 'string' || classifyKey(key, policy) !== 'content') continue;
        const re = new RegExp(IPV4_PATTERN.source, IPV4_PATTERN.flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(value)) !== null) {
          const ip = m[0]!;
          const range = classifyIpv4(ip);
          if (range === 'loopback' || range === 'reserved') continue;
          const confidence: Band = range === 'public' ? 'VERY_HIGH' : 'MEDIUM';
          findings.push({
            class: 'D2',
            span: { key, start: m.index, end: m.index + ip.length },
            confidence,
            evidence: [`ipv4-${range}`],
            detector: meta,
          });
        }
      }
      return findings;
    },
  };
}
