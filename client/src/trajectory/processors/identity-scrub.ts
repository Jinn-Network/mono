import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const IDENTITY_SCRUB_VERSION = '1.0.0';

export interface IdentityScrubConfig {
  username?: string;
  hostname?: string;
  machineId?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
}

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

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
        attrs[key] = this.scrub(v);
      }
    }
  }

  private scrub(s: string): string {
    let out = s;
    if (this.cfg.gitAuthorEmail) out = out.split(this.cfg.gitAuthorEmail).join('<EMAIL>');
    if (this.cfg.username) out = out.split(this.cfg.username).join('<USER>');
    if (this.cfg.hostname) out = out.split(this.cfg.hostname).join('<HOST>');
    if (this.cfg.machineId) out = out.split(this.cfg.machineId).join('<MACHINE>');
    if (this.cfg.gitAuthorName) out = out.split(this.cfg.gitAuthorName).join('<AUTHOR>');
    out = out.replace(IPV4_PATTERN, '<IPV4>');
    return out;
  }
}
