// The portal-closure walk shared by every image guard that proves a Dockerfile copies each Yarn
// portal manifest before the install that resolves it: the operator image
// (operator/test/scripts/dockerfile-workspace-portals.test.ts) and the two indexer images
// (packages/{indexer,indexer-enrichment}/test/dockerfile-portals.test.ts). One copy, so a fix to
// the walk lands in every guard at once (#4465). Node builtins only: the importing suites are
// separate Yarn projects with no shared dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface PortalEdge {
  name: string;
  /** Consumer package directory, relative to the image's build context. */
  consumer: string;
  /** Portal target directory, relative to the image's build context. */
  target: string;
}

/**
 * Every `portal:` entry in a manifest, keyed by package name. `resolutions` is read LAST because
 * a later `set` wins here and Yarn gives `resolutions` precedence over the dependency fields: when
 * a package names the same portal in both with different targets, the guard must check the one
 * the install actually links (#4464).
 */
export function portalEntries(manifest: Record<string, unknown>): Map<string, string> {
  const portals = new Map<string, string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions']) {
    const group = manifest[field] as Record<string, string> | undefined;
    for (const [name, version] of Object.entries(group ?? {})) {
      if (version.startsWith('portal:')) portals.set(name, version.slice('portal:'.length));
    }
  }
  return portals;
}

/**
 * Walks the whole portal closure off disk (no node_modules required). Each nested install
 * resolves that package's OWN portal entries, which the image package never names, so a depth-1
 * sweep cannot see them (#2809).
 */
export function reachablePortalEdges(packageRoot: string, contextRoot: string): PortalEdge[] {
  const contextRelative = (path: string) => relative(contextRoot, path).split(sep).join('/');
  const edges: PortalEdge[] = [];
  const walked = new Set<string>();

  const walk = (consumerRoot: string): void => {
    const manifestPath = resolve(consumerRoot, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const [name, target] of portalEntries(manifest)) {
      const targetRoot = resolve(consumerRoot, target);
      edges.push({ name, consumer: contextRelative(consumerRoot), target: contextRelative(targetRoot) });
      if (walked.has(targetRoot)) continue;
      walked.add(targetRoot);
      walk(targetRoot);
    }
  };

  walk(packageRoot);
  return edges;
}

interface Instruction {
  /** Index of the build stage (`FROM`) the instruction belongs to. */
  stage: number;
  keyword: string;
  args: string;
}

function dockerInstructions(dockerfile: string): Instruction[] {
  const instructions: Instruction[] = [];
  let stage = -1;
  let continued = '';

  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.trim();
    if (continued === '' && (line === '' || line.startsWith('#'))) continue;
    const hasContinuation = line.endsWith('\\');
    continued += `${continued === '' ? '' : ' '}${hasContinuation ? line.slice(0, -1).trimEnd() : line}`;
    if (hasContinuation) continue;
    const [keyword = '', ...rest] = continued.split(/\s+/u);
    if (/^FROM$/iu.test(keyword)) stage += 1;
    instructions.push({ stage, keyword: keyword.toUpperCase(), args: rest.join(' ') });
    continued = '';
  }

  return instructions;
}

/** Build-context sources of a `COPY` instruction; `COPY --from` copies from a stage, not the context. */
function contextCopySources(args: string): string[] {
  let rest = args;
  while (rest.startsWith('--')) {
    const option = /^--\S+\s*/u.exec(rest)![0];
    if (option.startsWith('--from=')) return [];
    rest = rest.slice(option.length);
  }
  if (rest.startsWith('[')) return (JSON.parse(rest) as string[]).slice(0, -1);
  return rest.split(/\s+/u).slice(0, -1);
}

/**
 * Every edge whose target manifest is not copied from the build context, IN THE SAME BUILD STAGE,
 * before the install that resolves it -- the first `yarn install` after the consumer's own
 * manifest COPY. Comparing whole-file offsets would let a COPY in another stage satisfy the
 * check while the image breaks (#4465).
 */
export function missingPortalManifestCopies(dockerfile: string, edges: PortalEdge[]): string[] {
  const instructions = dockerInstructions(dockerfile);
  const copyOf = (contextPath: string) =>
    instructions.findIndex(
      ({ keyword, args }) =>
        keyword === 'COPY' && contextCopySources(args).includes(`${contextPath}/package.json`),
    );

  const missing: string[] = [];
  for (const { name, consumer, target } of edges) {
    const consumerCopy = copyOf(consumer);
    if (consumerCopy < 0) {
      missing.push(`${consumer}/package.json is never copied`);
      continue;
    }
    const { stage } = instructions[consumerCopy]!;
    const install = instructions.findIndex(
      (instruction, index) =>
        index > consumerCopy &&
        instruction.stage === stage &&
        instruction.keyword === 'RUN' &&
        /\byarn\s+install\b/u.test(instruction.args),
    );
    if (install < 0) {
      missing.push(`${consumer}: no yarn install follows its manifest COPY`);
      continue;
    }
    const targetCopy = instructions.findIndex(
      ({ keyword, args, stage: copyStage }, index) =>
        index < install &&
        copyStage === stage &&
        keyword === 'COPY' &&
        contextCopySources(args).includes(`${target}/package.json`),
    );
    if (targetCopy < 0) {
      missing.push(`${name} (${target}): not copied before ${consumer}'s install in its build stage`);
    }
  }
  return [...new Set(missing)];
}

/** Every `watched` context path lacking its `<prefix><path>/**` entry in railway.toml's `watchPatterns`. */
export function missingWatchPatterns(
  railwayConfig: string,
  watched: string[],
  prefix: string,
): string[] {
  const block = /watchPatterns\s*=\s*\[([^\]]*)\]/u.exec(railwayConfig);
  if (block === null) return ['railway.toml declares no watchPatterns'];
  const patterns = new Set([...block[1]!.matchAll(/"([^"]*)"/gu)].map((match) => match[1]!));
  return [...new Set(watched)]
    .map((contextPath) => `${prefix}${contextPath}/**`)
    .filter((pattern) => !patterns.has(pattern));
}
