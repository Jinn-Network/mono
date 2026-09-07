import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Guard for the drift class behind #2811.
//
// `af8bd65de` repointed both image lanes from `ghcr.io/<owner>/client` to
// `ghcr.io/<owner>/operator` and updated the operator-facing documents in the
// same sweep — but nothing checked that the name the documents told operators
// to pull was a name some lane actually pushes. The overlays and CI never
// noticed, because they pass `BASE_IMAGE` by digest; only an operator following
// DEPLOY.md hit the 404.
//
// What this can prove, from the repository alone:
//   1. every `ghcr.io/<owner>/<package>` an operator-facing file names is a
//      package some in-repo workflow pushes to, and
//   2. every literal tag named for such a package is a tag shape one of those
//      lanes publishes.
//
// What it deliberately does NOT claim: that the registry currently HOLDS that
// tag. A green lane is a registry fact, not a repository fact — #2812 owns the
// failure signal for a lane that stops publishing.
const repoRoot = resolve(import.meta.dirname, '../../..');

/** Workflows that push operator container images. */
const PUBLISHING_WORKFLOWS = [
  '.github/workflows/docker.yml',
  '.github/workflows/operator-images.yml',
];

/**
 * Operator-facing files that tell a human which image to pull or build from.
 * `docs/` is excluded on purpose: dated specs, plans and decision records
 * record the names that were true when they were written.
 */
const REFERENCING_FILES = [
  'DEPLOY.md',
  'deploy/README.md',
  'deploy/railway-launcher-operator/Dockerfile',
  'deploy/railway-launcher-operator/README.md',
  'deploy/railway-launcher-operator/seed.sh',
  'deploy/railway-operator-codex/Dockerfile',
  'deploy/railway-operator-codex/README.md',
  'deploy/railway-operator-codex/seed.sh',
  'operator/README.md',
  'operator/RELEASING.md',
  'operator/docker-compose.yml',
];

/**
 * Files that are executed rather than read. A retired package may be named in
 * prose (to say it is retired); it may never be the thing something runs.
 */
const EXECUTABLE_FILES = new Set([
  'deploy/railway-launcher-operator/Dockerfile',
  'deploy/railway-launcher-operator/seed.sh',
  'deploy/railway-operator-codex/Dockerfile',
  'deploy/railway-operator-codex/seed.sh',
  'operator/docker-compose.yml',
]);

/**
 * Packages that were published once and are deliberately frozen. They stay
 * resolvable for deployments pinned to them, so prose may name them; no lane
 * pushes to them any more.
 */
const RETIRED_PACKAGES = new Set(['client']);

/**
 * Every file that states an `ARG BASE_TAG` default — the two overlay
 * Dockerfiles and the READMEs that quote them. They must all agree, and must
 * name a tag that is republished continuously.
 */
const BASE_TAG_FILES = [
  'deploy/railway-launcher-operator/Dockerfile',
  'deploy/railway-launcher-operator/README.md',
  'deploy/railway-operator-codex/Dockerfile',
  'deploy/railway-operator-codex/README.md',
];

/**
 * Base tags a lane republishes on every push, so they keep resolving between
 * named cuts. `latest` is deliberately excluded: it moves only on a release,
 * so a stable lane that stops publishing (#2811) silently breaks every
 * default-args overlay build.
 */
const ROLLING_BASE_TAGS = new Set(['next']);

type PushStep = {
  uses?: string;
  with?: { push?: boolean | string; tags?: string };
  run?: string;
};

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/**
 * `${{ steps.<id>.outputs.<key> }}` resolves against the shell assignments a
 * metadata step makes — both the `KEY="…"` locals and the `key=value` lines it
 * writes to `$GITHUB_OUTPUT`, in either the `echo` or the braced-group form the
 * two lanes use between them.
 */
function stepAssignments(steps: PushStep[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const step of steps) {
    if (step.run === undefined) continue;
    for (const line of step.run.split('\n')) {
      const match =
        /^\s*(?:echo\s+")?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*(?:>>\s*"?\$\{?GITHUB_OUTPUT\}?"?)?\s*$/.exec(
          line,
        );
      if (match && !assignments.has(match[1])) assignments.set(match[1], match[2]);
    }
  }
  return assignments;
}

/**
 * Last path segment of an image repository. The owner segment is always an
 * expression or a shell variable; the package segment is always a literal, in
 * both lanes and in every reference an operator is given.
 */
function packageOf(repoRef: string, assignments: Map<string, string>): string | undefined {
  const expression = /^\$\{\{\s*steps\.[a-z0-9_-]+\.outputs\.([A-Za-z0-9_]+)\s*\}\}$/.exec(
    repoRef.trim(),
  );
  let resolved = expression ? assignments.get(expression[1]) : repoRef;
  if (resolved === undefined) return undefined;
  // docker.yml's step output is itself a shell variable (`image_repo=${IMAGE_REPO}`).
  for (let depth = 0; depth < 4 && /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(resolved); depth += 1) {
    resolved = resolved.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, braced?: string, bare?: string) =>
        assignments.get(braced ?? bare ?? '') ?? whole,
    );
  }
  const segment = resolved.trim().replace(/^["']|["']$/g, '').split('/').pop();
  return segment !== undefined && /^[a-z0-9][a-z0-9._-]*$/.test(segment) ? segment : undefined;
}

/** `canary-${{ … }}` → `canary-*`; `${{ … version }}` → `*`; `next` → `next`. */
function tagShape(tagRef: string): string {
  return tagRef.trim().replace(/\$\{\{[^}]*\}\}/g, '*').replace(/\*+/g, '*');
}

/** package → the tag shapes the lanes publish for it. */
function publishedTagShapes(): Map<string, Set<string>> {
  const published = new Map<string, Set<string>>();

  for (const path of PUBLISHING_WORKFLOWS) {
    const parsed = parseYaml(read(path)) as {
      jobs: Record<string, { steps: PushStep[] }>;
    };
    for (const job of Object.values(parsed.jobs)) {
      const assignments = stepAssignments(job.steps);
      for (const step of job.steps) {
        if (!step.uses?.startsWith('docker/build-push-action')) continue;
        if (String(step.with?.push) !== 'true') continue;

        for (const entry of (step.with?.tags ?? '').split('\n')) {
          const tagRef = entry.trim();
          if (tagRef === '') continue;
          const separator = tagRef.lastIndexOf(':');
          const pkg = packageOf(tagRef.slice(0, separator), assignments);
          if (pkg === undefined) continue;
          const shapes = published.get(pkg) ?? new Set<string>();
          shapes.add(tagShape(tagRef.slice(separator + 1)));
          published.set(pkg, shapes);
        }
      }
    }
  }

  return published;
}

/**
 * A reference an operator cannot act on literally — `:<version>`, `:X.Y.Z`,
 * `:${BASE_TAG}`, `@sha256:…`. Placeholders describe a shape, not a tag.
 */
function isPlaceholder(tag: string): boolean {
  return /[<>${}…]/.test(tag) || /[A-Z]/.test(tag);
}

function matchesShape(tag: string, shape: string): boolean {
  if (shape === '*') return /^\d+\.\d+\.\d+$/.test(tag);
  if (shape.endsWith('-*')) return tag.startsWith(shape.slice(0, -1));
  return tag === shape;
}

const imageReference =
  /ghcr\.io\/[^/\s]+\/([a-z0-9][a-z0-9._-]*)(?:@[^\s]+|:([^\s"'`)\]},]+))?/g;

type Reference = { file: string; line: number; pkg: string; tag?: string };

function references(): Reference[] {
  const found: Reference[] = [];
  for (const file of REFERENCING_FILES) {
    read(file)
      .split('\n')
      .forEach((text, index) => {
        for (const match of text.matchAll(imageReference)) {
          found.push({ file, line: index + 1, pkg: match[1], tag: match[2] });
        }
      });
  }
  return found;
}

describe('GHCR image references', () => {
  const published = publishedTagShapes();
  const found = references();

  it('derives the published packages from the two image lanes', () => {
    // Pinned so a silent extraction regression (a lane switching to
    // docker/metadata-action, say) turns this red instead of quietly emptying
    // the sets every other assertion here reads.
    expect([...published.keys()].sort()).toEqual([
      'operator',
      'operator-codex',
      'operator-launcher',
    ]);
    expect([...(published.get('operator') ?? [])].sort()).toEqual([
      '*',
      'canary-*',
      'latest',
      'next',
      'sha-*',
    ]);
  });

  it('names only packages an in-repo lane publishes', () => {
    const unknown = found.filter(
      (ref) => !published.has(ref.pkg) && !RETIRED_PACKAGES.has(ref.pkg),
    );
    expect(
      unknown.map((ref) => `${ref.file}:${ref.line} ghcr.io/…/${ref.pkg}`),
    ).toEqual([]);
  });

  it('never runs a retired package', () => {
    const executed = found.filter(
      (ref) => RETIRED_PACKAGES.has(ref.pkg) && EXECUTABLE_FILES.has(ref.file),
    );
    expect(
      executed.map((ref) => `${ref.file}:${ref.line} ghcr.io/…/${ref.pkg}`),
    ).toEqual([]);
  });

  it('names only tag shapes those lanes publish', () => {
    const unpublished = found.filter((ref) => {
      const tag = ref.tag;
      if (tag === undefined || isPlaceholder(tag)) return false;
      const shapes = published.get(ref.pkg);
      if (shapes === undefined) return false;
      return ![...shapes].some((shape) => matchesShape(tag, shape));
    });
    expect(
      unpublished.map((ref) => `${ref.file}:${ref.line} ${ref.pkg}:${ref.tag}`),
    ).toEqual([]);
  });

  it('states one overlay base-tag default, and a rolling one', () => {
    // The default is the only thing a plain `docker build` of an overlay can
    // use — CI always overrides it with `BASE_IMAGE=…@sha256:…`, which is why
    // `ARG BASE_TAG=latest` pointing at a 404 stayed invisible to CI.
    const defaults = BASE_TAG_FILES.map((file) => {
      const match = /^ARG BASE_TAG=(\S+)$/m.exec(read(file));
      return `${file} => ${match?.[1] ?? '<missing>'}`;
    });
    const stated = new Set(defaults.map((entry) => entry.split(' => ')[1]));

    expect(defaults.filter((entry) => entry.endsWith('<missing>'))).toEqual([]);
    expect([...stated]).toHaveLength(1);
    for (const tag of stated) {
      expect(ROLLING_BASE_TAGS.has(tag)).toBe(true);
      expect(published.get('operator')?.has(tag)).toBe(true);
    }
  });
});
