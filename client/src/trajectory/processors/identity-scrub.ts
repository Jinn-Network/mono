import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const IDENTITY_SCRUB_VERSION = '1.0.0';

export interface IdentityScrubConfig {
  username?: string;
  hostname?: string;
  machineId?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

// Octet-bounded so version strings like "22.1.0.0" don't trigger false positives
// - each segment must be a valid 0-255 octet.
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\b/g;

// Reserved-protocol tokens (jinn.span.kind, jinn.artifact.emit, ...) are masked
// out before identity scrubbing and restored after, so an identity token that
// is a substring of a protocol token (e.g. username === 'jinn') cannot deface
// the protocol namespace (#1474). The mask/restore is confined to this shared
// function so all consumers (trajectory span-processor, artifact-scrub, capture
// export) inherit the protection.
const PROTOCOL_TOKEN_PATTERN = /\bjinn\.[A-Za-z0-9_.-]+/g;
// Sentinels are framed by control characters (U+0001 and U+0002) that cannot
// appear in identity tokens or normal trajectory content, so they never overlap
// an identity substring and never leak an alphanumeric placeholder.
const SENTINEL_OPEN = '\u0001';
const SENTINEL_CLOSE = '\u0002';
// Matches a masked placeholder (SENTINEL_OPEN <index> SENTINEL_CLOSE) for restore.
const SENTINEL_RESTORE_PATTERN = /\u0001(\d+)\u0002/g;

export function scrubIdentityString(s: string, cfg: IdentityScrubConfig): string {
  // Mask reserved protocol tokens first (see PROTOCOL_TOKEN_PATTERN above).
  const protectedTokens: string[] = [];
  let out = s.replace(PROTOCOL_TOKEN_PATTERN, (match) => {
    const idx = protectedTokens.push(match) - 1;
    return `${SENTINEL_OPEN}${idx}${SENTINEL_CLOSE}`;
  });

  // Order matters: email and full git-author name resolve first as
  // composite identifiers. Email-before-username avoids mangling addresses
  // whose local-part matches a username; gitAuthorName-before-hostname/
  // machineId avoids the symmetric trap where a name fragment is masked
  // by an earlier scrub.
  if (cfg.gitAuthorEmail) out = out.split(cfg.gitAuthorEmail).join('<EMAIL>');
  if (cfg.gitAuthorName) out = out.split(cfg.gitAuthorName).join('<AUTHOR>');
  if (cfg.username) out = out.split(cfg.username).join('<USER>');
  if (cfg.hostname) out = out.split(cfg.hostname).join('<HOST>');
  if (cfg.machineId) out = out.split(cfg.machineId).join('<MACHINE>');
  out = out.replace(IPV4_PATTERN, '<IPV4>');

  // Restore protocol tokens byte-for-byte (no-op when none were masked).
  out = out.replace(SENTINEL_RESTORE_PATTERN, (_m, idx) => protectedTokens[Number(idx)]);
  return out;
}

export class IdentityScrubProcessor implements SpanProcessor {
  constructor(private readonly cfg: IdentityScrubConfig) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (typeof v === 'string') {
        attrs[key] = scrubIdentityString(v, this.cfg);
      }
    }
  }
}
