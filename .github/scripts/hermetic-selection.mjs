// Decides whether hermetic-gate's suite job needs to run.
//
// The required context is a native terminal job, so the workflow must fire on
// every pull_request and merge_group (no workflow-level `paths:`). Selection
// lives here so a cannot-affect diff skips the ~10 minute Anvil suite without
// silencing the required context.
//
// Opt-out, fail-loud. Every changed path must be on the cannot-affect list to
// skip. An empty list, an unknown event, or any unmatched path selects on.
// `push` always selects on: that run is the SHA-bound evidence the publish
// guard queries.

export const IGNORABLE_PREFIXES = Object.freeze([
  'docs/',
  'log/',
  'spec/',
  'apps/website/',
  'growth/',
  'legacy/',
  '.agents/',
  '.claude/',
  '.codex/',
  '.cursor/',
  'architecture/generated/',
]);

export const IGNORABLE_FILES = Object.freeze([
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'PRINCIPLES.md',
  'SPEC.md',
  'THESIS.md',
  'BRAND.md',
  'GROWTH.md',
  'GLOSSARY.md',
  'DESIGN.md',
  'DESIGN.json',
  'README.md',
  'LICENSE',
  '.github/CODEOWNERS',
  '.github/architecture-owners',
]);

function isUnder(path, prefix) {
  if (prefix.endsWith('/')) return path === prefix.slice(0, -1) || path.startsWith(prefix);
  return path === prefix;
}

function isIgnorable(path) {
  if (IGNORABLE_FILES.includes(path)) return true;
  return IGNORABLE_PREFIXES.some((prefix) => isUnder(path, prefix));
}

/**
 * @param {{ eventName: string, changedFiles: string[] }} input
 * @returns {{ run: boolean, reason: string }}
 */
export function selectHermetic({ eventName, changedFiles }) {
  if (!Array.isArray(changedFiles)) throw new Error('changedFiles must be an array');

  if (eventName !== 'pull_request' && eventName !== 'merge_group') {
    return { run: true, reason: `${eventName || 'unknown event'} always runs the suite` };
  }

  const normalized = changedFiles.map((path) => path.trim()).filter((path) => path !== '');
  if (normalized.length === 0) {
    return { run: true, reason: 'no changed files reported' };
  }

  const affecting = normalized.filter((path) => !isIgnorable(path));
  if (affecting.length === 0) {
    return { run: false, reason: 'every changed path is on the cannot-affect list' };
  }

  return {
    run: true,
    reason: `affecting paths: ${affecting.slice(0, 5).join(', ')}`,
  };
}

function parseArgs(argv) {
  const parsed = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--changed-file') {
      if (value === undefined) throw new Error('--changed-file requires a value');
      parsed.changedFiles.push(value);
      index += 1;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  return parsed;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { changedFiles } = parseArgs(process.argv.slice(2));
  const stdinFiles = process.stdin.isTTY
    ? []
    : (await new Promise((resolveInput) => {
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buffer += chunk; });
      process.stdin.on('end', () => resolveInput(buffer));
    })).split('\n');

  const result = selectHermetic({
    eventName: process.env.EVENT_NAME ?? '',
    changedFiles: [...changedFiles, ...stdinFiles],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
