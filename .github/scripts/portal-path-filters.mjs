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
 * Reduces one `paths:` glob to the directory prefix it selects on, or null when
 * it selects no directory tree (a bare filename glob such as `*.md`).
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
 * Every quoted entry of every `paths:` block in a workflow file.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseWorkflowPaths(source) {
  const entries = [];
  const lines = source.split('\n');
  let blockIndent = null;
  for (const line of lines) {
    const header = /^(\s*)paths(?:-ignore)?:\s*$/u.exec(line);
    if (header !== null) {
      blockIndent = header[1].length;
      continue;
    }
    if (blockIndent === null) continue;
    const item = /^(\s*)-\s*"([^"]+)"\s*$/u.exec(line);
    if (item !== null && item[1].length > blockIndent) {
      entries.push(item[2]);
      continue;
    }
    // A comment or a blank line is part of the block, not the end of it.
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    blockIndent = null;
  }
  return entries;
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
 * The lanes whose selection is derived from the diff and must therefore honour
 * the portal closure. A lane absent from this list runs unconditionally and
 * needs no entry.
 *
 * `dialect` picks the reader and the remediation syntax; `required(workspace)`
 * renders the entry a maintainer must add.
 */
export const LANES = Object.freeze([
  Object.freeze({
    id: 'operator',
    workflow: '.github/workflows/ci.yml',
    dialect: 'shell-ere',
    arrayName: 'patterns',
    required: (workspace) => `'^${workspace}/'`,
  }),
  ...[
    'benchmark-product-ci',
    'benchmarking-ci',
    'environments-ci',
    'evidence-ci',
    'marketplace-ci',
    'plugin-tree-ci',
    'policy-ci',
    'policy-optimization-ci',
    'read-plane-ci',
    'record-discovery-ci',
    'task-execution-ci',
    'task-supply-ci',
    'trust-ci',
  ].map((id) =>
    Object.freeze({
      id,
      workflow: `.github/workflows/${id}.yml`,
      dialect: 'workflow-paths',
      required: (workspace) => `"${workspace}/**"`,
    }),
  ),
]);

/**
 * The directory prefixes one lane selects on.
 *
 * @param {string} root
 * @param {(typeof LANES)[number]} lane
 * @returns {string[]}
 */
export function laneSelectedPrefixes(root, lane) {
  const source = readFileSync(path.join(root, lane.workflow), 'utf8');
  const raw =
    lane.dialect === 'shell-ere'
      ? parseShellArray(source, lane.arrayName).map(erePrefix)
      : parseWorkflowPaths(source).map(globPrefix);
  return [...new Set(raw.filter((prefix) => prefix !== null))].sort();
}

/**
 * Audits one lane: the workspaces it selects on, and the portal targets of those
 * workspaces that it does not select on.
 *
 * @param {{ root: string, graph: Map<string, string[]>, lane: (typeof LANES)[number] }} input
 * @returns {{ id: string, workflow: string, selected: string[], missing: string[] }}
 */
export function auditLane({ root, graph, lane }) {
  const prefixes = laneSelectedPrefixes(root, lane);
  const covers = (workspace) => prefixes.some((prefix) => overlaps(prefix, workspace));
  const selected = [...graph.keys()].filter(covers).sort();
  const missing = new Set();
  for (const workspace of selected) {
    for (const target of portalClosure(graph, workspace)) {
      if (!covers(target)) missing.add(target);
    }
  }
  return { id: lane.id, workflow: lane.workflow, selected, missing: [...missing].sort() };
}

/**
 * Audits every lane.
 *
 * @param {string} root
 * @returns {ReturnType<typeof auditLane>[]}
 */
export function auditLanes(root) {
  const graph = readWorkspaceGraph(root);
  return LANES.map((lane) => auditLane({ root, graph, lane }));
}

/**
 * Human-readable remediation for one lane's gap.
 *
 * @param {ReturnType<typeof auditLane>} audit
 * @returns {string}
 */
export function describeGap(audit) {
  const lane = LANES.find(({ id }) => id === audit.id);
  const entries = audit.missing.map((workspace) => `    ${lane.required(workspace)}`).join('\n');
  return [
    `${audit.workflow} selects on a workspace whose portal: closure it does not select on.`,
    `A change confined to one of these trees would not schedule the ${audit.id} lane,`,
    'even though it is built from source into a workspace that lane verifies.',
    'Add to that lane’s selection:',
    entries,
  ].join('\n');
}
