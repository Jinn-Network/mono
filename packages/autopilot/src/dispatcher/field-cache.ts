/**
 * Project field-id cache — the dispatcher's once-per-process source of truth
 * for the `Status` and `Blocked on` field/option ids on the Jinn engineering
 * Project board.
 *
 * Pre-#599 every call to `dispatchIssue` (and every wall-clock pause) made
 * its own `gh project field-list` call to translate "In Progress" / "Human"
 * into the opaque single-select option ids `gh project item-edit` requires.
 * Each call costs ≥1 GraphQL point and a subprocess fork; on a busy dispatch
 * cycle the cost is meaningful and the field-list response is constant for the
 * lifetime of the dispatcher process (Project fields are renamed by humans,
 * not by the dispatcher).
 *
 * This module owns the cache: `fetchFieldIds(runner)` runs the canonical
 * field-list call once and parses every canonical Status + Blocked-on option
 * (the full enums in `./types.ts`, not just the subset in use today).
 * `getFieldCache()` and `resetFieldCache()` are the read/clear primitives.
 *
 * The owner and number come from `./constants.ts`; only `PROJECT_ID` remains
 * a local literal here.
 *
 * Tracking: jinn-mono#599.
 */

import type { CommandRunner } from './issue-source.js';
import type { BlockedOn, ProjectStatus } from './types.js';
import { ORG, PROJECT_NUMBER } from './constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Exported (jinn-mono#1883 board-archive sweep): the board-archive executor
// needs the Project's node id for `archiveProjectV2Item` mutations, and the
// lean snapshot (`fetchProjectSnapshot`) doesn't carry a project-level id —
// only per-item ids. Reusing this constant avoids a second magic literal.
export const PROJECT_ID = 'PVT_kwDODh3-Ac4BXYaI';

/** Every ProjectStatus value — used for fail-loud option validation. */
const REQUIRED_STATUS_OPTIONS: readonly ProjectStatus[] = [
  'Todo',
  'In Progress',
  'Human',
  'In Review',
  'Done',
];

/** Every BlockedOn value — used for fail-loud option validation. */
const REQUIRED_BLOCKED_ON_OPTIONS: readonly BlockedOn[] = [
  'Nothing',
  'Human',
  'Another issue',
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FieldCache {
  projectId: string;
  status: { fieldId: string; options: Record<ProjectStatus, string> };
  blockedOn: { fieldId: string; options: Record<BlockedOn, string> };
}

/**
 * Thrown when `fetchFieldIds` cannot find an expected field or option in the
 * `gh project field-list` response. The message names the missing field /
 * option so a board rename is diagnosable from the boot log alone — mirrors
 * the loud-failure shape of `ProjectFieldSchemaError` in `project-snapshot.ts`.
 */
export class ProjectFieldCacheError extends Error {
  constructor(message: string) {
    super(`ProjectFieldCacheError: ${message}`);
    this.name = 'ProjectFieldCacheError';
  }
}

// ---------------------------------------------------------------------------
// Internal `gh project field-list` response shapes
//
// Copied (rather than imported from dispatch.ts) because dispatch.ts will
// delete them in Step 3 — the field-list parsing now lives here. Keeping the
// shapes inline avoids a cyclic dependency between dispatch.ts and this
// module.
// ---------------------------------------------------------------------------

interface GhFieldOption {
  id: string;
  name: string;
}

interface GhField {
  id: string;
  name: string;
  options?: GhFieldOption[];
}

interface GhFieldListResponse {
  fields: GhField[];
}

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let cached: FieldCache | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the Project's Status + Blocked-on field/option ids and replace the
 * module-level cache with the result. Always runs the `gh project field-list`
 * call — call `getFieldCache()` to read without re-fetching.
 *
 * Throws {@link ProjectFieldCacheError} when the response is missing the
 * Status field, the Blocked-on field, or any of the canonical options.
 */
export async function fetchFieldIds(runner: CommandRunner): Promise<FieldCache> {
  const raw = await runner('gh', [
    'project', 'field-list', String(PROJECT_NUMBER),
    '--owner', ORG,
    '--format', 'json',
  ]);
  const data = JSON.parse(raw) as GhFieldListResponse;

  const statusField = data.fields.find((f) => f.name === 'Status');
  if (statusField == null) {
    throw new ProjectFieldCacheError(
      'Status field not found in gh project field-list response',
    );
  }
  const blockedOnField = data.fields.find((f) => f.name === 'Blocked on');
  if (blockedOnField == null) {
    throw new ProjectFieldCacheError(
      'Blocked on field not found in gh project field-list response',
    );
  }

  const statusOptions = buildOptionMap<ProjectStatus>(
    statusField,
    REQUIRED_STATUS_OPTIONS,
    'Status',
  );
  const blockedOnOptions = buildOptionMap<BlockedOn>(
    blockedOnField,
    REQUIRED_BLOCKED_ON_OPTIONS,
    'Blocked on',
  );

  cached = {
    projectId: PROJECT_ID,
    status: { fieldId: statusField.id, options: statusOptions },
    blockedOn: { fieldId: blockedOnField.id, options: blockedOnOptions },
  };
  return cached;
}

/** Read the cached value, or `null` if {@link fetchFieldIds} hasn't run. */
export function getFieldCache(): FieldCache | null {
  return cached;
}

/** Drop the cached value. The next read returns `null` until the next fetch. */
export function resetFieldCache(): void {
  cached = null;
}

/**
 * Returns `true` when `err` looks like a stale field/option id failure from
 * `gh project item-edit` — the failure mode `dispatch.ts` retries by resetting
 * the field cache and re-fetching exactly once.
 *
 * `gh` does not surface a typed error code for this case, so we match on the
 * message. We accept several plausible phrasings to insulate the retry from
 * upstream wording changes; a brittle exact-substring match was hiding stale
 * id failures behind silent no-ops (the Stage 5 reviewer flagged this on
 * jinn-mono#599).
 *
 * Sample observed: 'failed to run git: Could not resolve to a node with the
 * global id of "…"' (from the project Graph endpoint when a field id is
 * referenced after the field was rebuilt).
 *
 * TODO: extend when other shapes are observed in the wild.
 */
export function isStaleFieldError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /could not resolve|field not found|404|no field with id/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildOptionMap<K extends string>(
  field: GhField,
  required: readonly K[],
  fieldLabel: string,
): Record<K, string> {
  // Fail loud per missing option — the named error message lets an operator
  // diagnose a board rename from the boot log without grepping the payload.
  const byName = new Map<string, string>();
  for (const opt of field.options ?? []) {
    byName.set(opt.name, opt.id);
  }

  const out = {} as Record<K, string>;
  for (const need of required) {
    const id = byName.get(need);
    if (id == null) {
      throw new ProjectFieldCacheError(
        `"${need}" option not found in ${fieldLabel} field`,
      );
    }
    out[need] = id;
  }
  return out;
}
