/**
 * URL query-string as the source of truth for UI state.
 *
 * Uses wouter v3's `useSearchParams` (returns a URLSearchParams + setter that
 * calls history.replaceState by default when replace:true is set). All writes
 * use `replace: true` so the back-button is not polluted with filter changes.
 *
 * Query-string keys used across the app:
 *   (Path carries scope/cid/addr — not query string keys)
 *   sort         — leaderboard sort column name
 *   dir          — "asc" | "desc"
 *   board        — "train" | "frozen" | "all"
 *   k            — rolling window size (number)
 *   bucket       — learning curve bucket width in blocks (number)
 *   mode         — "train" | "frozen" for operator filter
 *   harness      — implName filter for operators view
 *   detail       — arbitrary detail panel id
 *   minVerdicts  — leaderboard minimum verdict threshold (number)
 */

import { useSearchParams } from 'wouter';

// ── useQueryParam ─────────────────────────────────────────────────────────────

/**
 * Read/write a single query-string parameter.
 *
 * Returns `[value, setter]` where:
 *   - `value` is the current string value of `key`, or `def` if absent
 *   - `setter(v)` writes to the URL via replaceState; pass `null` to remove
 */
export function useQueryParam(
  key: string,
  def: string,
): [string, (v: string | null) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? def;

  function set(v: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === null || v === '') {
          next.delete(key);
        } else {
          next.set(key, v);
        }
        return next;
      },
      { replace: true },
    );
  }

  return [value, set];
}

// ── useNumParam ───────────────────────────────────────────────────────────────

/**
 * Like `useQueryParam` but returns a number. Non-finite or non-parseable
 * values fall back to `def`.
 */
export function useNumParam(
  key: string,
  def: number,
): [number, (v: number | null) => void] {
  const [raw, setRaw] = useQueryParam(key, '');

  const value = raw === '' ? def : (() => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  })();

  function set(v: number | null) {
    if (v === null || v === def) {
      setRaw(null);
    } else {
      setRaw(String(v));
    }
  }

  return [value, set];
}

// ── useEnumParam ──────────────────────────────────────────────────────────────

/**
 * Like `useQueryParam` but restricted to a fixed set of allowed values.
 * Values not in `allowed` silently fall back to `def`.
 */
export function useEnumParam(
  key: string,
  def: string,
  allowed: string[],
): [string, (v: string | null) => void] {
  const [raw, setRaw] = useQueryParam(key, def);
  const value = allowed.includes(raw) ? raw : def;
  return [value, setRaw];
}

// ── useStringArrayParam ──────────────────────────────────────────────────────

/** Parse a `"a,b , c"` query value into a trimmed, non-empty string array. */
function parseCsv(raw: string | null): string[] {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Read/write a comma-separated array of strings at a single query-string key.
 *
 * Round-trip: URL `?include=raw,debug` ⇄ ['raw', 'debug']. Writing `[]`
 * removes the key. Empty strings within the array are filtered out.
 */
export function useStringArrayParam(
  key: string,
): [string[], (v: string[]) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = parseCsv(searchParams.get(key));

  function set(v: string[]) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v.length === 0) {
          next.delete(key);
        } else {
          next.set(key, v.join(','));
        }
        return next;
      },
      { replace: true },
    );
  }

  return [value, set];
}

// ── useFilterParams ──────────────────────────────────────────────────────────

/**
 * The set of filter dimensions the slice engine accepts (mirrors
 * SliceFilter in slice-types.ts).
 */
export const FILTER_DIMS = ['operator', 'harness', 'plugin', 'mode', 'model'] as const;
export type FilterDim = (typeof FILTER_DIMS)[number];
export type FilterMap = Partial<Record<FilterDim, string[]>>;

/**
 * Read/write the engine's `filter[<dim>]=<value>[,<value>]` URL state as a
 * single FilterMap. Multiple dims coexist; each dim's value is a string array.
 *
 * URL `?filter[harness]=codex&filter[model]=gpt-5.4-mini` ⇄
 *   `{ harness: ['codex'], model: ['gpt-5.4-mini'] }`.
 *
 * Writing replaces the full filter set (so passing `{ harness: ['codex'] }`
 * after a state with both harness and model present removes the model key).
 */
export function useFilterParams(): [FilterMap, (v: FilterMap) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const value: FilterMap = {};
  for (const dim of FILTER_DIMS) {
    const arr = parseCsv(searchParams.get(`filter[${dim}]`));
    if (arr.length > 0) value[dim] = arr;
  }

  function set(v: FilterMap) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        // Strip all existing filter[<dim>] keys before writing the new set.
        for (const dim of FILTER_DIMS) {
          next.delete(`filter[${dim}]`);
        }
        for (const dim of FILTER_DIMS) {
          const arr = v[dim];
          if (arr && arr.length > 0) {
            next.set(`filter[${dim}]`, arr.join(','));
          }
        }
        return next;
      },
      { replace: true },
    );
  }

  return [value, set];
}

// ── useGroupParam ────────────────────────────────────────────────────────────

export const GROUP_VALUES = [
  'none', 'operator', 'harness', 'plugin', 'mode', 'model',
] as const;
export type GroupValue = (typeof GROUP_VALUES)[number];

/**
 * Read/write the slice-engine `group` URL param, restricted to the allowed
 * enum. Unknown values fall back to 'none'.
 *
 * Setting the default ('none') removes the key from the URL — keeps the URL
 * clean when the user picks "Group by: none" in the dropdown, so the cold
 * landing URL stays `/solvernet/<cid>` (no `?group=none` pollution).
 */
export function useGroupParam(): [GroupValue, (v: GroupValue) => void] {
  const [raw, setRaw] = useEnumParam('group', 'none', GROUP_VALUES as unknown as string[]);
  function set(v: GroupValue) {
    setRaw(v === 'none' ? null : v);
  }
  return [raw as GroupValue, set];
}
