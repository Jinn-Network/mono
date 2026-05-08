import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const PATH_SCRUB_VERSION = '1.0.0';

export interface PathScrubConfig {
  home: string;       // e.g. '/Users/adrianobradley'
  repoRoot?: string;  // e.g. '/Users/adrianobradley/harbor/jinn-mono'
}

export class PathScrubProcessor implements SpanProcessor {
  private readonly homePrefix: string;
  private readonly repoExact?: string;
  private readonly repoPrefix?: string;

  constructor(cfg: PathScrubConfig) {
    this.homePrefix = cfg.home.endsWith('/') ? cfg.home : cfg.home + '/';
    if (cfg.repoRoot) {
      this.repoExact = cfg.repoRoot;
      this.repoPrefix = cfg.repoRoot.endsWith('/') ? cfg.repoRoot : cfg.repoRoot + '/';
    }
  }

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
    // repoRoot match wins over home match: a path under the repo is more
    // useful as a repo-relative reference than as a /users/anon/... blob.
    if (this.repoExact !== undefined && s === this.repoExact) return '.';
    if (this.repoPrefix !== undefined && s.startsWith(this.repoPrefix)) {
      return s.slice(this.repoPrefix.length);
    }
    if (s.startsWith(this.homePrefix)) {
      return '/users/anon/' + s.slice(this.homePrefix.length);
    }
    return s;
  }
}
