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
  // The only file in the repository that *executes* a pull of the image, rather
  // than telling a human to: `runPublishVerifications` shells out to
  // `docker run --rm ghcr.io/<owner>/operator:<version>`. Repoint the lanes
  // again and the documents redden while this one silently keeps pulling the
  // retired name, surfacing at `verify-docker-version` during a live release.
  'operator/scripts/lib/release-client.mjs',
  'operator/docker-compose.yml',
  'deploy/railway-launcher-operator/railway.toml',
  'deploy/railway-operator-codex/railway.toml',
];

/**
 * Railway service definitions whose comment block gives an operator a
 * copy-pasteable `BASE_TAG` override. They sat outside every check above until
 * their worked example still read `0.1.4` — a tag only ever published under the
 * retired `client` package — long after the overlays had moved to `operator`.
 * A bare tag carries no `ghcr.io/` prefix, so the reference scan cannot see it.
 */
const BASE_TAG_EXAMPLE_FILES = [
  'deploy/railway-launcher-operator/railway.toml',
  'deploy/railway-operator-codex/railway.toml',
];

/**
 * Files that are executed rather than read. A retired package may be named in
 * prose (to say it is retired); it may never be the thing something runs.
 */
const EXECUTABLE_FILES = new Set([
  'operator/scripts/lib/release-client.mjs',
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
 * Dockerfiles, the READMEs that quote them, and the deploy README whose
 * copy-pasteable "~4-line overlay" recipe an operator is most likely to paste.
 * They must all agree, and must name a tag that is republished continuously.
 *
 * `deploy/README.md` is in `REFERENCING_FILES` too, but its
 * `FROM ghcr.io/<owner>/operator:${BASE_TAG}` is an `isPlaceholder` skip, so the
 * reference scan structurally cannot see the tag — the same reasoning that gives
 * `railway.toml` its own `BASE_TAG_EXAMPLE_FILES` list above.
 */
const BASE_TAG_FILES = [
  'deploy/README.md',
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

/**
 * Sentence punctuation an un-backticked reference drags into the tag. `.` and
 * `;` cannot simply leave the character class above: `0.2.3` is a legal tag and
 * a leading/interior `.` is part of it. Only a *trailing* run is a terminator,
 * and a real tag never ends in one — the registry grammar allows `.` inside a
 * tag but the shapes these lanes publish are semver, `next`, `latest`,
 * `canary-*` and `sha-*`.
 */
function stripSentencePunctuation(tag: string): string {
  return tag.replace(/[.;:!?]+$/, '');
}

type Reference = { file: string; line: number; pkg: string; tag?: string };

/** Every `ghcr.io/<owner>/<pkg>[:<tag>]` in one blob of text, one per match. */
function parseImageReferences(
  text: string,
  file = '<text>',
): Reference[] {
  const found: Reference[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(imageReference)) {
      found.push({
        file,
        line: index + 1,
        pkg: match[1],
        tag: match[2] === undefined ? undefined : stripSentencePunctuation(match[2]),
      });
    }
  });
  return found;
}

function references(): Reference[] {
  return REFERENCING_FILES.flatMap((file) => parseImageReferences(read(file), file));
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

  it('reads a tag out of an un-backticked sentence without its terminator', () => {
    // The tag class excludes quotes, backtick, brackets and commas, but cannot
    // exclude `.` or `;` — `0.2.3` is a legal tag. So a correct sentence written
    // without backticks used to parse its own terminator into the tag, and this
    // suite went red claiming the lane does not publish `operator:next.`.
    expect(
      parseImageReferences('pull ghcr.io/jinn-network/operator:next.')[0],
    ).toMatchObject({ pkg: 'operator', tag: 'next' });
    expect(
      parseImageReferences('see ghcr.io/jinn-network/operator:latest;')[0],
    ).toMatchObject({ pkg: 'operator', tag: 'latest' });

    // Interior dots survive: stripping only ever removes a trailing run.
    expect(
      parseImageReferences('run ghcr.io/jinn-network/operator:0.2.3.')[0],
    ).toMatchObject({ pkg: 'operator', tag: '0.2.3' });

    // Kill-check: a tag no lane publishes is still caught, terminator or not.
    for (const text of [
      'pull ghcr.io/jinn-network/operator:bogus',
      'pull ghcr.io/jinn-network/operator:bogus.',
    ]) {
      const [reference] = parseImageReferences(text);
      const shapes = published.get(reference.pkg) ?? new Set<string>();
      expect([...shapes].some((shape) => matchesShape(reference.tag ?? '', shape))).toBe(
        false,
      );
    }
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

  it('offers only pinnable BASE_TAG examples', () => {
    // A version-shaped example passes `matchesShape` against the release lane's
    // `*` and still 404s, because no stable cut has run under this package name
    // yet (#2811) — a registry fact this file cannot check. So the rule here is
    // the stricter, repository-checkable one the overlay defaults already obey:
    // a literal example must be a continuously republished tag. A placeholder
    // (`canary-<short-sha>`) reads as a shape, not as something to paste, and is
    // exempt. Relax this once the stable lane has a green run under this name.
    const examples = BASE_TAG_EXAMPLE_FILES.flatMap((file) =>
      [...read(file).matchAll(/BASE_TAG\s*=\s*"([^"]+)"/g)].map((match) => ({
        file,
        tag: match[1],
      })),
    );

    expect(examples.length).toBe(BASE_TAG_EXAMPLE_FILES.length);
    const unpinnable = examples.filter(
      (example) => !isPlaceholder(example.tag) && !ROLLING_BASE_TAGS.has(example.tag),
    );
    expect(unpinnable.map((example) => `${example.file} => ${example.tag}`)).toEqual([]);
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
