// Portal-consumer path-filter coverage.
//
// A workspace-local `portal:` dependency is built from the depended-on tree's
// SOURCE, not from a published tarball. So a change confined to a portal target
// changes the behaviour of every workspace that portals it — and of every CI
// lane that builds one of those workspaces.
//
// Those lanes select themselves from the diff: most through a workflow-level
// `paths:` list, and the operator lane in `ci.yml` through an anchored
// extended-regular-expression array in its `changes` job. Neither list is
// derived from the dependency graph, so a portal target could sit outside every
// consumer's selection and a change to it would run only its own lane (#3573:
// `packages/trust/core` changed on #3563 and the operator, marketplace and
// benchmarking lanes never scheduled). The breakage then surfaces on whichever
// unrelated pull request next touches one of those trees.
//
// This module derives the requirement instead of restating it: for every lane
// that selects on some workspace's tree, every workspace in that workspace's
// transitive `portal:` closure must also be selected by that same lane. The
// conformance test is the gate; a new portal edge that escapes a consumer's
// filter fails it on the pull request that added the edge.
//
// The graph is walked from the manifests rather than read from
// `architecture/platform-packages.v1.json`: the catalog describes the published
// platform surface, while a `portal:` edge is declared in a manifest and nowhere
// else, and an unpublished workspace still consumes and breaks on one.
//
// Deliberately check-only. Rewriting a `paths:` list or a shell array in place
// would need a YAML/shell writer for a diff that is normally one or two lines,
// and the failure message below names the exact entries to add.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Directories never walked for workspace manifests. */
const SKIPPED_DIRECTORIES = Object.freeze([
  'node_modules',
  '.git',
  '.yarn',
  'dist',
  // Read-only reference subtree; in no workspace and imported by nothing.
  'legacy',
]);

/** Manifest fields whose values may carry a `portal:` protocol reference. */
const PORTAL_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'resolutions']);

const PORTAL_PROTOCOL = 'portal:';

/**
 * Walks the repository for workspace manifests and records each one's direct
 * `portal:` targets as repository-relative directories.
 *
 * @param {string} root repository root
 * @returns {Map<string, string[]>} workspace directory -> direct portal targets
 */
export function readWorkspaceGraph(root) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.name !== 'package.json') continue;
      const workspace = path.relative(root, directory);
      // The repository root is a prefix of every path, so a manifest there would
      // make every lane look like it selects every workspace. There is no root
      // manifest today; refusing one keeps the inference honest if that changes.
      if (workspace === '') continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(absolute, 'utf8'));
      } catch (cause) {
        throw new Error(`unreadable workspace manifest ${path.relative(root, absolute)}`, { cause });
      }
      const targets = new Set();
      for (const field of PORTAL_FIELDS) {
        for (const specifier of Object.values(manifest[field] ?? {})) {
          if (typeof specifier !== 'string' || !specifier.startsWith(PORTAL_PROTOCOL)) continue;
          targets.add(path.relative(root, path.resolve(directory, specifier.slice(PORTAL_PROTOCOL.length))));
        }
      }
      graph.set(workspace, [...targets].sort());
    }
  };
  walk(root);
  return graph;
}

/**
 * Transitive `portal:` closure of one workspace, excluding the workspace itself.
 *
 * @param {Map<string, string[]>} graph
 * @param {string} workspace
 * @returns {Set<string>}
 */
export function portalClosure(graph, workspace) {
  const closure = new Set();
  const pending = [workspace];
  while (pending.length > 0) {
    for (const target of graph.get(pending.pop()) ?? []) {
      if (closure.has(target)) continue;
      closure.add(target);
      pending.push(target);
    }
  }
  closure.delete(workspace);
  return closure;
}

/**
 * True when a selection entry and a workspace tree overlap in either direction:
 * the entry selects the whole workspace (`packages/trust/**` vs
 * `packages/trust/core`) or some part of it (`operator/src/**` vs `operator`).
 * Either way a change under the workspace can select the lane, which is what
 * the closure requirement is about.
 *
 * @param {string} selectedPrefix repository-relative directory prefix
 * @param {string} workspace repository-relative workspace directory
 */
export function overlaps(selectedPrefix, workspace) {
  if (selectedPrefix === '' || workspace === '') return false;
  return (
    selectedPrefix === workspace ||
    selectedPrefix.startsWith(`${workspace}/`) ||
    workspace.startsWith(`${selectedPrefix}/`)
  );
}

/**
 * True when a selection entry selects the WHOLE of a workspace tree. Coverage of
 * a portal target is judged this way rather than by `overlaps`: an entry for
 * `packages/trust/core/src/**` overlaps `packages/trust/core` but would still
 * let a change to that package's `package.json` or `tsconfig.json` escape.
 *
 * @param {string} selectedPrefix repository-relative directory prefix
 * @param {string} workspace repository-relative workspace directory
 */
export function contains(selectedPrefix, workspace) {
  if (selectedPrefix === '' || workspace === '') return false;
  return selectedPrefix === workspace || workspace.startsWith(`${selectedPrefix}/`);
}

/**
 * Reduces one `paths:` glob to the directory prefix a change must sit under for
 * the glob to match, or null when it selects no directory tree (a bare filename
 * glob such as `*.md`).
 *
 * @param {string} glob
 * @returns {string | null}
 */
export function globPrefix(glob) {
  const segments = [];
  for (const segment of glob.split('/')) {
    if (segment.includes('*')) break;
    segments.push(segment);
  }
  const prefix = segments.join('/');
  return prefix === '' ? null : prefix;
}

/**
 * The prefix a glob covers ENTIRELY, or null when it covers no whole tree.
 *
 * `globPrefix` truncates at the first wildcard, so a glob with an interior `*`
 * segment reduces to the literal head above it — a fine answer for "could a
 * change here select this lane", and a wrong one for "is this tree covered":
 * such a glob matches no manifest or tsconfig directly under that head.
 * Crediting the truncation as coverage would reopen, through the prefix
 * reduction, the same leak `contains` closes.
 *
 * @param {string} glob
 * @returns {string | null}
 */
export function globCoveragePrefix(glob) {
  const segments = glob.split('/');
  const wildcard = segments.findIndex((segment) => segment.includes('*'));
  // A wildcard is only harmless as the trailing `**`: anything after it means
  // the glob skips part of the tree its literal head names.
  if (wildcard !== -1 && !(wildcard === segments.length - 1 && segments[wildcard] === '**')) return null;
  return globPrefix(glob);
}

/**
 * Reduces one anchored extended regular expression from the operator lane's
 * selection array to the directory prefix it selects on.
 *
 * Only a `^literal/` prefix pattern counts. `^packages/.*\/package\.json$` is
 * deliberately excluded: `ci.yml` documents it as manifests-only, and treating
 * it as tree coverage would make every package look selected.
 *
 * @param {string} pattern
 * @returns {string | null}
 */
export function erePrefix(pattern) {
  const match = /^\^((?:[A-Za-z0-9_.@-]|\\\.)+(?:\/(?:[A-Za-z0-9_.@-]|\\\.)+)*)\/$/u.exec(pattern);
  return match === null ? null : match[1].replaceAll('\\.', '.');
}

/**
 * Every `paths:` block in a workflow file, tagged with the trigger it sits
 * under. Both blocks of a lane must carry the same closure: a `push:` block
 * that drifts from its `pull_request:` block reopens the hole on `next`.
 *
 * @param {string} source
 * @returns {{ trigger: string, entries: string[] }[]}
 */
export function parsePathsBlocks(source) {
  /** @type {{ trigger: string, entries: string[] }[]} */
  const blocks = [];
  let trigger = null;
  let block = null;
  let blockIndent = null;
  for (const line of source.split('\n')) {
    const triggerKey = /^ {2}([a-z_]+):\s*(?:#.*)?$/u.exec(line);
    if (triggerKey !== null) trigger = triggerKey[1];
    // `paths-ignore:` is deliberately not matched: an ignored path is the
    // opposite of coverage, and reading one as coverage would silence the gate.
    const flow = /^ {4}paths:\s*\[(.*)\]\s*$/u.exec(line);
    if (flow !== null) {
      const entries = flow[1]
        .split(',')
        .map((entry) => entry.trim().replace(/^["']|["']$/gu, ''))
        .filter((entry) => entry !== '');
      // A flow sequence that yields nothing is a parse failure, not an empty
      // filter; failing loudly is the whole point of this module.
      if (entries.length === 0) throw new Error(`unparseable flow paths: ${line.trim()}`);
      blocks.push({ trigger: trigger ?? 'unknown', entries });
      blockIndent = null;
      continue;
    }
    const header = /^( {4})paths:\s*$/u.exec(line);
    if (header !== null) {
      block = { trigger: trigger ?? 'unknown', entries: [] };
      blocks.push(block);
      blockIndent = header[1].length;
      continue;
    }
    // Any other shape of a TRIGGER-LEVEL `paths:` key is a shape this parser does
    // not model. It must never be read as "this lane filters on nothing": that is
    // a silent pass, the failure mode #3573 is about. The indent bound keeps a
    // step input that happens to be called `paths:` out of it.
    if (/^ {4}paths:/u.test(line)) throw new Error(`unparseable paths: ${line.trim()}`);
    if (blockIndent === null) continue;
    // Double-quoted, single-quoted and bare entries all occur in this
    // repository. Reading only one style would make the other invisible to the
    // gate — silently, which is the exact failure mode being fixed.
    const item = /^(\s*)-\s*(?:"([^"]+)"|'([^']+)'|([^\s'"#][^\s#]*))\s*$/u.exec(line);
    if (item !== null && item[1].length > blockIndent) {
      block.entries.push(item[2] ?? item[3] ?? item[4]);
      continue;
    }
    // A comment or a blank line is part of the block, not the end of it.
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    blockIndent = null;
  }
  for (const { entries } of blocks) {
    if (entries.length === 0) throw new Error('a paths: block yielded no entries');
  }
  return blocks;
}

/**
 * Every entry of every `paths:` block, flattened.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseWorkflowPaths(source) {
  return parsePathsBlocks(source).flatMap(({ entries }) => entries);
}

/**
 * Every single-quoted entry of a `name=( ... )` shell array in a workflow file.
 *
 * @param {string} source
 * @param {string} arrayName
 * @returns {string[]}
 */
export function parseShellArray(source, arrayName) {
  const start = source.indexOf(`${arrayName}=(`);
  if (start === -1) throw new Error(`missing shell array ${arrayName}=(`);
  // Line by line to the closing `)` on its own line, skipping comments: an
  // apostrophe in a comment would otherwise pair with the next real quote and
  // shift every subsequent entry by one.
  const entries = [];
  const lines = source.slice(start).split('\n');
  for (const line of lines.slice(1)) {
    if (line.trim() === ')') return entries;
    if (line.trim().startsWith('#')) continue;
    for (const [, entry] of line.matchAll(/'([^']*)'/gu)) entries.push(entry);
  }
  throw new Error(`unterminated shell array ${arrayName}=(`);
}

/**
 * Name of the shell array that carries a lane's anchored extended regular
 * expressions, and the file its `changes` job writes them to. Four workflows
 * moved their workflow-level `paths:` filters into a `changes` job this way
 * (a required merge-queue context must not sit behind a workflow-level filter),
 * so both dialects have to be audited or the ones that migrated fall out.
 */
const SHELL_ARRAY_NAME = 'patterns';
const SHELL_SELECTION_FILE = 'selection.ere';

/**
 * Marker of a workflow that decides what to run from the changed-file list.
 */
const DIFF_SELECTION_MARKER = '--name-only';

/**
 * Workflows that select from the diff but need no portal audit, each with the
 * reason. This roster is deliberately loud: a workflow that grows diff selection
 * without matching a known dialect fails the gate until it is either audited or
 * listed here, rather than dropping out of the audit set unnoticed.
 */
const DIFF_SELECTION_EXEMPT = Object.freeze({
  'hermetic-gate.yml':
    'opt-out selection (hermetic-selection.mjs): every unlisted path selects the lane ON, ' +
    'so a portal target already schedules it.',
  'canonical-docs-check.yml': 'selects on canonical documents, which are in no workspace.',
  'platform-architecture-control.yml':
    'the workflow that hosts this gate; its jobs select from the changed-package closure, ' +
    'not from a path filter.',
});

/**
 * Every lane whose selection is derived from the diff, discovered rather than
 * listed: a hand-maintained roster is the same failure this module exists to
 * prevent, one level up. A workflow with no `paths:` block runs unconditionally
 * and needs no entry.
 *
 * @param {string} root
 * @returns {{ id: string, workflow: string, dialect: string, arrayName?: string, required: (workspace: string) => string }[]}
 */
export function discoverLanes(root) {
  const directory = '.github/workflows';
  const lanes = [];
  for (const file of readdirSync(path.join(root, directory)).sort()) {
    if (!file.endsWith('.yml')) continue;
    const workflow = `${directory}/${file}`;
    const source = readFileSync(path.join(root, workflow), 'utf8');
    if (source.includes(`${SHELL_ARRAY_NAME}=(`) && source.includes(SHELL_SELECTION_FILE)) {
      lanes.push(
        Object.freeze({
          id: file.slice(0, -'.yml'.length),
          workflow,
          dialect: 'shell-ere',
          arrayName: SHELL_ARRAY_NAME,
          required: (workspace) => `'^${workspace}/'`,
        }),
      );
      continue;
    }
    const blocks = parsePathsBlocks(source);
    if (
      blocks.length === 0 &&
      source.includes(DIFF_SELECTION_MARKER) &&
      !Object.hasOwn(DIFF_SELECTION_EXEMPT, file)
    ) {
      throw new Error(
        `${workflow} selects from the changed-file list through a mechanism this gate does not ` +
          'model. Teach discoverLanes its dialect, or add it to DIFF_SELECTION_EXEMPT with a reason.',
      );
    }
    // Only lanes that gate a PULL REQUEST are in scope. A `push:`-only lane
    // (`*-npm-publish`, `operator-images`) decides release cadence, not whether
    // a pull request was verified; widening one would change what publishes,
    // which is a release-policy call and not this gate's business.
    if (!blocks.some(({ trigger }) => trigger === 'pull_request')) continue;
    lanes.push(
      Object.freeze({
        id: file.slice(0, -'.yml'.length),
        workflow,
        dialect: 'workflow-paths',
        required: (workspace) => `"${workspace}/**"`,
      }),
    );
  }
  return lanes;
}

/**
 * The directory prefixes one lane selects on.
 *
 * @param {string} root
 * @param {ReturnType<typeof discoverLanes>[number]} lane
 * @returns {string[]}
 */
export function laneSelectedPrefixes(root, lane) {
  return laneSelectionBlocks(root, lane).flatMap(({ prefixes }) => prefixes);
}

/**
 * One entry per independently-evaluated selection block, each reduced to the
 * directory prefixes it selects on.
 *
 * @param {string} root
 * @param {ReturnType<typeof discoverLanes>[number]} lane
 * @returns {{ trigger: string, prefixes: string[], coveragePrefixes: string[] }[]}
 */
export function laneSelectionBlocks(root, lane) {
  const source = readFileSync(path.join(root, lane.workflow), 'utf8');
  const reduce = (raw) => [...new Set(raw.filter((prefix) => prefix !== null))].sort();
  if (lane.dialect === 'shell-ere') {
    const prefixes = reduce(parseShellArray(source, lane.arrayName).map(erePrefix));
    // An anchored `^dir/` names a whole tree, so selection and coverage coincide.
    return [{ trigger: 'diff', prefixes, coveragePrefixes: prefixes }];
  }
  return parsePathsBlocks(source).map(({ trigger, entries }) => ({
    trigger,
    prefixes: reduce(entries.map(globPrefix)),
    coveragePrefixes: reduce(entries.map(globCoveragePrefix)),
  }));
}

/**
 * Audits one lane: the workspaces it selects on, and the portal targets of those
 * workspaces that some selection block of that lane does not select on.
 *
 * @param {{ root: string, graph: Map<string, string[]>, lane: ReturnType<typeof discoverLanes>[number] }} input
 * @returns {{ id: string, workflow: string, required: (workspace: string) => string, selected: string[], missing: string[] }}
 */
export function auditLane({ root, graph, lane }) {
  const blocks = laneSelectionBlocks(root, lane);
  const coversAnywhere = (workspace) =>
    blocks.some(({ prefixes }) => prefixes.some((prefix) => overlaps(prefix, workspace)));
  const selected = [...graph.keys()].filter(coversAnywhere).sort();
  const missing = new Set();
  for (const workspace of selected) {
    for (const target of portalClosure(graph, workspace)) {
      for (const { coveragePrefixes } of blocks) {
        if (!coveragePrefixes.some((prefix) => contains(prefix, target))) missing.add(target);
      }
    }
  }
  return {
    id: lane.id,
    workflow: lane.workflow,
    required: lane.required,
    selected,
    missing: [...missing].sort(),
  };
}

/**
 * Audits every lane.
 *
 * @param {string} root
 * @returns {ReturnType<typeof auditLane>[]}
 */
export function auditLanes(root) {
  const graph = readWorkspaceGraph(root);
  return discoverLanes(root).map((lane) => auditLane({ root, graph, lane }));
}

/**
 * Human-readable remediation for one lane's gap.
 *
 * @param {ReturnType<typeof auditLane> & { required: (workspace: string) => string }} audit
 * @returns {string}
 */
export function describeGap(audit) {
  const entries = audit.missing.map((workspace) => `    ${audit.required(workspace)}`).join('\n');
  return [
    `${audit.workflow} selects on a workspace whose portal: closure it does not select on.`,
    `A change confined to one of these trees would not schedule the ${audit.id} lane,`,
    'even though it is built from source into a workspace that lane verifies.',
    'Add to that lane’s selection:',
    entries,
  ].join('\n');
}
