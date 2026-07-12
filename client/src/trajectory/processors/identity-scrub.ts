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

// Reserved-protocol tokens (jinn.span.kind, jinn.artifact.emit, ...) must pass
// through identity scrubbing untouched, so an identity token that is a substring
// of a protocol token (e.g. username === 'jinn') cannot deface the protocol
// namespace (#1474). We achieve this by splitting the input on protocol tokens
// and scrubbing only the non-protocol segments - there is no sentinel to leak or
// collide with. The protection is confined to this shared function so all
// consumers (trajectory span-processor, artifact-scrub, capture export) inherit it.

// Scrub one non-protocol segment via the ordered identity replacements.
function scrubSegment(s: string, cfg: IdentityScrubConfig): string {
  let out = s;
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
  return out;
}

export function scrubIdentityString(s: string, cfg: IdentityScrubConfig): string {
  // Split on protocol tokens; the capturing group keeps them in the array at
  // odd indices. Even indices are ordinary text to scrub; odd indices are
  // jinn.-prefixed protocol tokens that pass through verbatim (#1474) - so an
  // identity token that is a substring of a protocol token cannot deface it,
  // and there is no sentinel to collide with.
  return s
    .split(/(\bjinn\.[A-Za-z0-9_.-]+)/g)
    .map((part, i) => (i % 2 === 1 ? part : scrubSegment(part, cfg)))
    .join('');
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
