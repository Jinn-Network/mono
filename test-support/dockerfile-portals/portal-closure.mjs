// The portal-closure walk shared by every image guard that proves a Dockerfile copies each Yarn
// portal manifest before the install that resolves it: the operator image
// (operator/test/scripts/dockerfile-workspace-portals.test.ts) and the two indexer images
// (packages/{indexer,indexer-enrichment}/test/dockerfile-portals.test.ts). One copy, so a fix to
// the walk lands in every guard at once (#4465). Node builtins only: the importing suites are
// separate Yarn projects with no shared dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/**
 * Every `portal:` entry in a manifest. `.get(name)` is the last-wins target: `resolutions` is
 * read LAST because Yarn gives it precedence over the dependency fields (#4464). Iteration yields
 * every distinct `(name, target)` pair in field order, so a package that names one portal with
 * two targets is checked against both: the operator image's own install links the dependency-field
 * target, and a nested install in that package applies `resolutions` (#4636).
 */
/** @param {Record<string, unknown>} manifest @returns {Map<string, string>} */
export function portalEntries(manifest) {
  const portals = new Map();
  const distinct = [];
  const seen = new Set();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'resolutions']) {
    const group = /** @type {Record<string, string> | undefined} */ (manifest[field]);
    for (const [name, version] of Object.entries(group ?? {})) {
      if (!version.startsWith('portal:')) continue;
      const target = version.slice('portal:'.length);
      portals.set(name, target);
      const key = `${name}\0${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push([name, target]);
    }
  }
  portals[Symbol.iterator] = function* portalEntryPairs() {
    yield* distinct;
  };
  return portals;
}

/**
 * Walks the whole portal closure off disk (no node_modules required). Each nested install
 * resolves that package's OWN portal entries, which the image package never names, so a depth-1
 * sweep cannot see them (#2809).
 */
export function reachablePortalEdges(packageRoot, contextRoot) {
  const contextRelative = (path) => relative(contextRoot, path).split(sep).join('/');
  const edges = [];
  const walked = new Set();

  const walk = (consumerRoot) => {
    const manifestPath = resolve(consumerRoot, 'package.json');
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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

/** Instructions with continuations joined, each tagged with its build stage (`FROM`) index. */
function dockerInstructions(dockerfile) {
  const instructions = [];
  let stage = -1;
  let continued = '';

  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.trim();
    // Docker drops blank and comment lines even inside a continued instruction.
    if (line === '' || line.startsWith('#')) continue;
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

const YARN_FLAGS_WITH_VALUE = new Set([
  '--cwd',
  '--use-yarnrc',
  '--cache-folder',
  '--modules-folder',
  '--preferred-cache-folder',
]);

// Yarn builtins and common package scripts that are not an install. Anything else that
// still starts with `yarn` is treated as an install so an unrecognized form cannot hide
// between a manifest COPY and a later `yarn install` (#4635).
const YARN_NON_INSTALL = new Set([
  'add',
  'bin',
  'build',
  'cache',
  'config',
  'constraints',
  'create',
  'dedupe',
  'dlx',
  'exec',
  'explain',
  'help',
  'info',
  'init',
  'link',
  'lint',
  'node',
  'npm',
  'outdated',
  'pack',
  'plugin',
  'publish',
  'remove',
  'run',
  'search',
  'set',
  'tag',
  'test',
  'typecheck',
  'unlink',
  'up',
  'upgrade',
  'version',
  'why',
  'workspace',
  'workspaces',
]);

// A `RUN` instruction can carry BuildKit options (`--mount=...`, `--network=...`, `--security=...`)
// before the actual command; strip them so the command check below sees the real first token
// (#4635 forms like `RUN --mount=type=cache,target=/root/.yarn yarn install --immutable`).
const RUN_OPTION_PREFIX = /^--(?:mount|network|security)=\S*\s*/u;

function stripRunOptions(args) {
  let rest = args;
  for (let match = RUN_OPTION_PREFIX.exec(rest); match !== null; match = RUN_OPTION_PREFIX.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return rest;
}

/**
 * True when a Dockerfile `RUN` resolves packages the way a `yarn install` does. The literal-text
 * check is next's original regex, kept as a disjunct: it alone covers forms the token-first-word
 * parse below can miss because the install sits inside a wrapper (`sh -c "yarn install"`, `env
 * CI=1 yarn install`, `if ...; then yarn install; fi`) or a non-assignment prefix
 * (`/usr/local/bin/yarn install`) (#4635).
 */
function runResolvesYarnInstall(args) {
  const body = stripRunOptions(args);
  return (
    /\byarn\s+install\b/u.test(body) ||
    body.split(/\s*(?:&&|\|\||;)\s*/u).some(commandResolvesYarnInstall)
  );
}

function commandResolvesYarnInstall(command) {
  const tokens = command.trim().split(/\s+/u).filter((token) => token !== '');
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
  if (tokens[index] === 'corepack' && tokens[index + 1] === 'yarn') index += 2;
  else if (tokens[index] === 'yarn') index += 1;
  else return false;

  const positionals = [];
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.startsWith('--')) {
      const name = token.slice(0, token.includes('=') ? token.indexOf('=') : token.length);
      if (!token.includes('=') && YARN_FLAGS_WITH_VALUE.has(name)) cursor += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }

  if (positionals.length === 0 || positionals[0] === 'install') return true;
  return !YARN_NON_INSTALL.has(positionals[0]);
}

/** Build-context sources of a `COPY` instruction; `COPY --from` copies from a stage, not the context. */
function contextCopySources(args) {
  let rest = args;
  while (rest.startsWith('--')) {
    const option = /^--\S+\s*/u.exec(rest)[0];
    if (option.startsWith('--from=')) return [];
    rest = rest.slice(option.length);
  }
  if (rest.startsWith('[')) return JSON.parse(rest).slice(0, -1);
  return rest.split(/\s+/u).slice(0, -1);
}

/**
 * Every edge whose target manifest is not copied from the build context, IN THE SAME BUILD STAGE,
 * before each install that resolves it -- the first yarn install-equivalent after any COPY of the
 * consumer's own manifest (`yarn install`, a flag-only `yarn`, `yarn --cwd <dir> install`, or any
 * unrecognized `yarn` form; known non-install commands are skipped). Comparing whole-file offsets
 * would let a COPY in another stage satisfy the check while the image breaks (#4465, #4635).
 */
export function missingPortalManifestCopies(dockerfile, edges) {
  const instructions = dockerInstructions(dockerfile);
  const copies = (contextPath, before = instructions.length, stage = undefined) =>
    instructions.flatMap((instruction, index) =>
      index < before &&
      (stage === undefined || instruction.stage === stage) &&
      instruction.keyword === 'COPY' &&
      contextCopySources(instruction.args).includes(`${contextPath}/package.json`)
        ? [index]
        : [],
    );
  const installAfter = (index) =>
    instructions.findIndex(
      (instruction, candidate) =>
        candidate > index &&
        instruction.stage === instructions[index].stage &&
        instruction.keyword === 'RUN' &&
        runResolvesYarnInstall(instruction.args),
    );

  const missing = [];
  for (const { name, consumer, target } of edges) {
    // A consumer manifest may be copied in more than one stage; every copy an install follows
    // must have the target copied ahead of that install.
    const consumerCopies = copies(consumer);
    const installs = consumerCopies.map(installAfter).filter((install) => install >= 0);
    if (consumerCopies.length === 0) {
      missing.push(`${consumer}/package.json is never copied`);
    } else if (installs.length === 0) {
      missing.push(`${consumer}: no yarn install follows a COPY of its manifest`);
    } else if (!installs.every((install) => copies(target, install, instructions[install].stage).length > 0)) {
      missing.push(`${name} (${target}): not copied before ${consumer}'s install in its build stage`);
    }
  }
  return [...new Set(missing)];
}

/** Every `watched` context path lacking its `<prefix><path>/**` entry in railway.toml's `watchPatterns`. */
export function missingWatchPatterns(railwayConfig, watched, prefix) {
  const block = /watchPatterns\s*=\s*\[([^\]]*)\]/u.exec(railwayConfig);
  if (block === null) return ['railway.toml declares no watchPatterns'];
  const patterns = new Set([...block[1].matchAll(/"([^"]*)"/gu)].map((match) => match[1]));
  return [...new Set(watched)]
    .map((contextPath) => `${prefix}${contextPath}/**`)
    .filter((pattern) => !patterns.has(pattern));
}
