import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureFieldIds,
  fetchFieldIds,
  getFieldCache,
  isStaleFieldError,
  resetFieldCache,
} from '../../src/dispatcher/field-cache.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Canned `gh project field-list` JSON. Mirrors the shape used in
 * `dispatch.test.ts` so future Status-option callers reading from the cache
 * (e.g. an eventual "In Review" mover, see plan §"Out of scope") get every
 * option for free.
 */
const FIELD_LIST_JSON = JSON.stringify({
  fields: [
    {
      id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
      name: 'Blocked on',
      options: [
        { id: '122744bf', name: 'Nothing' },
        { id: 'a20d20ac', name: 'Human' },
        { id: 'e3e1b0c4', name: 'Another issue' },
      ],
    },
    {
      id: 'PVTSSF_STATUS_FIELD_ID',
      name: 'Status',
      options: [
        { id: 'opt_todo', name: 'Todo' },
        { id: 'opt_in_progress', name: 'In Progress' },
        { id: 'opt_human', name: 'Human' },
        { id: 'opt_in_review', name: 'In Review' },
        { id: 'opt_done', name: 'Done' },
      ],
    },
    {
      id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRw',
      name: 'Effort',
      options: [
        { id: 'ef2a043d', name: 'Low' },
        { id: '6539eb71', name: 'Medium' },
        { id: '081839fa', name: 'High' },
      ],
    },
  ],
});

type RunnerCall = { cmd: string; args: string[] };

function makeRunner(payload: string): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'gh' && args[0] === 'project' && args[1] === 'field-list') {
      return payload;
    }
    throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('field-cache', () => {
  beforeEach(() => {
    resetFieldCache();
  });

  it('fetchFieldIds parses Status and Blocked on into FieldCache', async () => {
    const { runner, calls } = makeRunner(FIELD_LIST_JSON);
    const cache = await fetchFieldIds(runner);

    // Project id constant (mirrors dispatch.ts PROJECT_ID — duplication is
    // deliberate per plan §"Out of scope: constants extraction").
    expect(cache.projectId).toBe('PVT_kwDODh3-Ac4BXYaI');

    // Status field — every option captured, not just "In Progress".
    expect(cache.status.fieldId).toBe('PVTSSF_STATUS_FIELD_ID');
    expect(cache.status.options.Todo).toBe('opt_todo');
    expect(cache.status.options['In Progress']).toBe('opt_in_progress');
    expect(cache.status.options['In Review']).toBe('opt_in_review');
    expect(cache.status.options.Done).toBe('opt_done');

    // Blocked on field — every option captured, not just "Human".
    expect(cache.blockedOn.fieldId).toBe('PVTSSF_lADODh3-Ac4BXYaIzhTdqRo');
    expect(cache.blockedOn.options.Nothing).toBe('122744bf');
    expect(cache.blockedOn.options.Human).toBe('a20d20ac');
    expect(cache.blockedOn.options['Another issue']).toBe('e3e1b0c4');

    // Exactly one `gh project field-list` call, with the canonical args.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: 'gh',
      args: ['project', 'field-list', '1', '--owner', 'Jinn-Network', '--format', 'json'],
    });
  });

  it('fetchFieldIds throws ProjectFieldCacheError when Status field is missing', async () => {
    const payload = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
          name: 'Blocked on',
          options: [
            { id: '122744bf', name: 'Nothing' },
            { id: 'a20d20ac', name: 'Human' },
            { id: 'e3e1b0c4', name: 'Another issue' },
          ],
        },
      ],
    });
    const { runner } = makeRunner(payload);

    await expect(fetchFieldIds(runner)).rejects.toMatchObject({
      name: 'ProjectFieldCacheError',
    });
    await expect(fetchFieldIds(runner)).rejects.toThrow(/Status/);
  });

  it('fetchFieldIds throws ProjectFieldCacheError when a Status option is missing', async () => {
    const payload = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
          name: 'Blocked on',
          options: [
            { id: '122744bf', name: 'Nothing' },
            { id: 'a20d20ac', name: 'Human' },
            { id: 'e3e1b0c4', name: 'Another issue' },
          ],
        },
        {
          id: 'PVTSSF_STATUS_FIELD_ID',
          name: 'Status',
          options: [
            { id: 'opt_todo', name: 'Todo' },
            // missing "In Progress"
            { id: 'opt_in_review', name: 'In Review' },
            { id: 'opt_done', name: 'Done' },
          ],
        },
      ],
    });
    const { runner } = makeRunner(payload);

    await expect(fetchFieldIds(runner)).rejects.toMatchObject({
      name: 'ProjectFieldCacheError',
    });
    await expect(fetchFieldIds(runner)).rejects.toThrow(/In Progress/);
  });

  it('fetchFieldIds throws ProjectFieldCacheError when Blocked on field is missing', async () => {
    const payload = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_STATUS_FIELD_ID',
          name: 'Status',
          options: [
            { id: 'opt_todo', name: 'Todo' },
            { id: 'opt_in_progress', name: 'In Progress' },
            { id: 'opt_in_review', name: 'In Review' },
            { id: 'opt_done', name: 'Done' },
          ],
        },
      ],
    });
    const { runner } = makeRunner(payload);

    await expect(fetchFieldIds(runner)).rejects.toMatchObject({
      name: 'ProjectFieldCacheError',
    });
    await expect(fetchFieldIds(runner)).rejects.toThrow(/Blocked on/);
  });

  it('fetchFieldIds throws ProjectFieldCacheError when a Blocked-on option is missing', async () => {
    const payload = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
          name: 'Blocked on',
          options: [
            { id: '122744bf', name: 'Nothing' },
            // missing "Human"
            { id: 'e3e1b0c4', name: 'Another issue' },
          ],
        },
        {
          id: 'PVTSSF_STATUS_FIELD_ID',
          name: 'Status',
          options: [
            { id: 'opt_todo', name: 'Todo' },
            { id: 'opt_in_progress', name: 'In Progress' },
            { id: 'opt_in_review', name: 'In Review' },
            { id: 'opt_done', name: 'Done' },
          ],
        },
      ],
    });
    const { runner } = makeRunner(payload);

    await expect(fetchFieldIds(runner)).rejects.toMatchObject({
      name: 'ProjectFieldCacheError',
    });
    await expect(fetchFieldIds(runner)).rejects.toThrow(/Human/);
  });

  it('getFieldCache returns the populated cache after fetch; resetFieldCache clears it', async () => {
    const { runner } = makeRunner(FIELD_LIST_JSON);

    expect(getFieldCache()).toBeNull();
    const cache = await fetchFieldIds(runner);
    expect(getFieldCache()).toBe(cache);

    resetFieldCache();
    expect(getFieldCache()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // isStaleFieldError — predicate the dispatch retry switches on (#599)
  // -------------------------------------------------------------------------

  describe('isStaleFieldError', () => {
    it('matches the observed gh "Could not resolve to a node" phrasing', () => {
      const err = new Error(
        'failed to run git: Could not resolve to a node with the global id of "..."',
      );
      expect(isStaleFieldError(err)).toBe(true);
    });

    it('matches a "Field not found" phrasing', () => {
      expect(isStaleFieldError(new Error('Field not found'))).toBe(true);
    });

    it('matches an HTTP 404 phrasing', () => {
      expect(isStaleFieldError(new Error('HTTP 404: not found'))).toBe(true);
    });

    it('matches "No field with id" phrasing', () => {
      expect(isStaleFieldError(new Error('No field with id PVTSSF_… exists'))).toBe(true);
    });

    it('is case-insensitive on the match', () => {
      expect(
        isStaleFieldError(new Error('COULD NOT RESOLVE to a node')),
      ).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isStaleFieldError(new Error('rate limit exceeded'))).toBe(false);
      expect(isStaleFieldError(new Error('connection reset'))).toBe(false);
    });

    it('returns false for non-Error throwables', () => {
      expect(isStaleFieldError('Could not resolve to a node')).toBe(false);
      expect(isStaleFieldError(42)).toBe(false);
      expect(isStaleFieldError(null)).toBe(false);
      expect(isStaleFieldError(undefined)).toBe(false);
      expect(isStaleFieldError({ message: 'Could not resolve to a node' })).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton swap — run-autopilot.ts's per-cycle `getFieldCache()` re-read
  // depends on this so a stale-id refresh inside dispatchIssue propagates to
  // the next cycle. (#599 — Stage 5 Finding 1)
  // -------------------------------------------------------------------------

  it('getFieldCache returns the *new* object after a re-fetch (proves cross-cycle singleton swap)', async () => {
    const { runner: r1 } = makeRunner(FIELD_LIST_JSON);
    const first = await fetchFieldIds(r1);
    expect(getFieldCache()).toBe(first);

    const altPayload = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
          name: 'Blocked on',
          options: [
            { id: '122744bf', name: 'Nothing' },
            { id: 'a20d20ac', name: 'Human' },
            { id: 'e3e1b0c4', name: 'Another issue' },
          ],
        },
        {
          id: 'PVTSSF_STATUS_FIELD_ID_NEW',
          name: 'Status',
          options: [
            { id: 'opt_todo_new', name: 'Todo' },
            { id: 'opt_in_progress_NEW', name: 'In Progress' },
            { id: 'opt_human_new', name: 'Human' },
            { id: 'opt_in_review_new', name: 'In Review' },
            { id: 'opt_done_new', name: 'Done' },
          ],
        },
      ],
    });
    const { runner: r2 } = makeRunner(altPayload);
    const second = await fetchFieldIds(r2);

    // The singleton swap is the invariant: getFieldCache() must follow the
    // new reference. A `const fieldCache` captured before the re-fetch would
    // still see `first`; the next cycle's re-read sees `second`.
    expect(second).not.toBe(first);
    expect(getFieldCache()).toBe(second);
    expect(getFieldCache()).not.toBe(first);
  });

  it('fetchFieldIds replaces the cached value on a second call', async () => {
    const payloadFirst = FIELD_LIST_JSON;
    const payloadSecond = JSON.stringify({
      fields: [
        {
          id: 'PVTSSF_lADODh3-Ac4BXYaIzhTdqRo',
          name: 'Blocked on',
          options: [
            { id: '122744bf', name: 'Nothing' },
            { id: 'a20d20ac', name: 'Human' },
            { id: 'e3e1b0c4', name: 'Another issue' },
          ],
        },
        {
          id: 'PVTSSF_STATUS_FIELD_ID_NEW',
          name: 'Status',
          options: [
            { id: 'opt_todo_new', name: 'Todo' },
            { id: 'opt_in_progress_NEW', name: 'In Progress' },
            { id: 'opt_human_new', name: 'Human' },
            { id: 'opt_in_review_new', name: 'In Review' },
            { id: 'opt_done_new', name: 'Done' },
          ],
        },
      ],
    });

    const { runner: r1 } = makeRunner(payloadFirst);
    const first = await fetchFieldIds(r1);
    expect(first.status.fieldId).toBe('PVTSSF_STATUS_FIELD_ID');
    expect(first.status.options['In Progress']).toBe('opt_in_progress');

    const { runner: r2 } = makeRunner(payloadSecond);
    const second = await fetchFieldIds(r2);
    expect(second.status.fieldId).toBe('PVTSSF_STATUS_FIELD_ID_NEW');
    expect(second.status.options['In Progress']).toBe('opt_in_progress_NEW');
    expect(getFieldCache()).toBe(second);
  });
});

describe('ensureFieldIds', () => {
  it('fetches once, then serves the module cache without re-running field-list', async () => {
    resetFieldCache();
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return FIELD_LIST_JSON;
    };
    const first = await ensureFieldIds(runner);
    const second = await ensureFieldIds(runner);
    expect(first).toBe(second);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('field-list');
  });
});
