import { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const PATH_SCRUB_VERSION = '1.0.0';

export interface PathScrubConfig {
  home: string;       // e.g. '/Users/adrianobradley'
  repoRoot?: string;  // e.g. '/Users/adrianobradley/harbor/jinn-mono'
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search.length === 0 ? value : value.split(search).join(replacement);
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
  let out = s;
  if (repoPrefix !== undefined) {
    if (out.startsWith(repoPrefix)) {
      out = out.slice(repoPrefix.length);
    } else {
      out = replaceAllLiteral(out, repoPrefix, '');
    }
  }
  if (repoExact !== undefined && out !== '.') {
    out = replaceAllLiteral(out, repoExact, '.');
  }
  if (out === cfg.home) return '/users/anon';
  if (out.startsWith(homePrefix)) {
    return '/users/anon/' + out.slice(homePrefix.length);
  }
  return replaceAllLiteral(out, homePrefix, '/users/anon/');
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
