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
// — each segment must be a valid 0-255 octet.
const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\b/g;

export function scrubIdentityString(s: string, cfg: IdentityScrubConfig): string {
  // Order matters: email and full git-author name resolve first as
  // composite identifiers. Email-before-username avoids mangling addresses
  // whose local-part matches a username; gitAuthorName-before-hostname/
  // machineId avoids the symmetric trap where a name fragment is masked
  // by an earlier scrub.
  let out = s;
  if (cfg.gitAuthorEmail) out = out.split(cfg.gitAuthorEmail).join('<EMAIL>');
  if (cfg.gitAuthorName) out = out.split(cfg.gitAuthorName).join('<AUTHOR>');
  if (cfg.username) out = out.split(cfg.username).join('<USER>');
  if (cfg.hostname) out = out.split(cfg.hostname).join('<HOST>');
  if (cfg.machineId) out = out.split(cfg.machineId).join('<MACHINE>');
  out = out.replace(IPV4_PATTERN, '<IPV4>');
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
