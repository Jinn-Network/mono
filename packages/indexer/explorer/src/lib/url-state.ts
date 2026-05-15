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
