import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const PATH_SCRUB_VERSION = '1.0.0';

export interface PathScrubConfig {
  home: string;       // e.g. '/Users/adrianobradley'
  repoRoot?: string;  // e.g. '/Users/adrianobradley/harbor/jinn-mono'
}

export function scrubPathString(s: string, cfg: PathScrubConfig): string {
  const homePrefix = cfg.home.endsWith('/') ? cfg.home : cfg.home + '/';
  const repoExact = cfg.repoRoot;
  const repoPrefix = cfg.repoRoot
    ? (cfg.repoRoot.endsWith('/') ? cfg.repoRoot : cfg.repoRoot + '/')
    : undefined;

  // repoRoot match wins over home match: a path under the repo is more
  // useful as a repo-relative reference than as a /users/anon/... blob.
  if (repoExact !== undefined && s === repoExact) return '.';
  if (repoPrefix !== undefined && s.startsWith(repoPrefix)) {
    return s.slice(repoPrefix.length);
  }
  if (s.startsWith(homePrefix)) {
    return '/users/anon/' + s.slice(homePrefix.length);
  }
  return s;
}

export class PathScrubProcessor implements SpanProcessor {
  constructor(private readonly cfg: PathScrubConfig) {}

  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}

  onEnd(span: ReadableSpan): void {
    const attrs = span.attributes as Record<string, unknown>;
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (typeof v === 'string') {
        attrs[key] = scrubPathString(v, this.cfg);
      }
    }
  }
}
