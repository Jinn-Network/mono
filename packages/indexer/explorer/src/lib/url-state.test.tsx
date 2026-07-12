/**
 * URL-state hook tests — round-trip readers/writers for query-string state.
 *
 * Uses wouter v3's memoryLocation so we can render hooks under a known URL
 * and assert that writes update the location.
 */
import { renderHook, act } from '@testing-library/react';
import { Router, useSearchParams } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import {
  useNumParam,
  useFilterParams,
  useStringArrayParam,
  useGroupParam,
  usePatchParams,
} from './url-state';
import type { ReactNode } from 'react';

function makeWrapper(initialPath: string) {
  const { hook } = memoryLocation({ path: initialPath, static: false });
  return function Wrap({ children }: { children: ReactNode }) {
    return <Router hook={hook}>{children}</Router>;
  };
}

describe('useGroupParam', () => {
  it('returns the default when no group is present', () => {
    const { result } = renderHook(() => useGroupParam(), {
      wrapper: makeWrapper('/explore/cid'),
    });
    expect(result.current[0]).toBe('none');
  });

  it('returns the parsed group when present', () => {
    const { result } = renderHook(() => useGroupParam(), {
      wrapper: makeWrapper('/explore/cid?group=operator'),
    });
    expect(result.current[0]).toBe('operator');
  });

  it('falls back to default on unknown values', () => {
    const { result } = renderHook(() => useGroupParam(), {
      wrapper: makeWrapper('/explore/cid?group=banana'),
    });
    expect(result.current[0]).toBe('none');
  });

  it('returns builder when present', () => {
    const { result } = renderHook(() => useGroupParam(), {
      wrapper: makeWrapper('/explore/cid?group=builder'),
    });
    expect(result.current[0]).toBe('builder');
  });
});

describe('useFilterParams', () => {
  it('returns an empty object when no filters are set', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid'),
    });
    expect(result.current[0]).toEqual({});
  });

  it('reads filter[harness] and filter[model] as repeated keys', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid?filter[harness]=codex&filter[model]=gpt-5.4-mini'),
    });
    expect(result.current[0]).toEqual({
      harness: ['codex'],
      model: ['gpt-5.4-mini'],
    });
  });

  it('reads comma-separated values within one key', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid?filter[operator]=0xabc,0xdef'),
    });
    expect(result.current[0]).toEqual({ operator: ['0xabc', '0xdef'] });
  });

  it('reads filter[builder] as a comma-separated allow-list', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid?filter[builder]=101,202'),
    });
    expect(result.current[0]).toEqual({ builder: ['101', '202'] });
  });

  it('removing a value via setter strips the key from the URL', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid?filter[harness]=codex&filter[model]=gpt-5.4-mini'),
    });
    act(() => {
      result.current[1]({ harness: ['codex'] });
    });
    expect(result.current[0]).toEqual({ harness: ['codex'] });
  });

  it('clearing all filters removes every filter[<dim>] key', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('/explore/cid?filter[harness]=codex'),
    });
    act(() => {
      result.current[1]({});
    });
    expect(result.current[0]).toEqual({});
  });
});

describe('useStringArrayParam', () => {
  it('returns an empty array when missing', () => {
    const { result } = renderHook(() => useStringArrayParam('include'), {
      wrapper: makeWrapper('/explore/cid'),
    });
    expect(result.current[0]).toEqual([]);
  });

  it('reads comma-separated values', () => {
    const { result } = renderHook(() => useStringArrayParam('include'), {
      wrapper: makeWrapper('/explore/cid?include=raw,debug'),
    });
    expect(result.current[0]).toEqual(['raw', 'debug']);
  });

  it('writing an empty array removes the key', () => {
    const { result } = renderHook(() => useStringArrayParam('include'), {
      wrapper: makeWrapper('/explore/cid?include=raw'),
    });
    act(() => result.current[1]([]));
    expect(result.current[0]).toEqual([]);
  });
});

describe('useNumParam — window=30 round-trip', () => {
  it('reads window=30 from URL', () => {
    const { result } = renderHook(() => useNumParam('window', 50), {
      wrapper: makeWrapper('/explore/cid?window=30'),
    });
    expect(result.current[0]).toBe(30);
  });

  it('falls back to default when the URL omits window', () => {
    const { result } = renderHook(() => useNumParam('window', 50), {
      wrapper: makeWrapper('/explore/cid'),
    });
    expect(result.current[0]).toBe(50);
  });
});

describe('usePatchParams — atomic multi-key write', () => {
  it('sets multiple keys and deletes null keys in a single write', () => {
    const { result } = renderHook(
      () => {
        const [sp] = useSearchParams();
        const patch = usePatchParams();
        return { sp, patch };
      },
      { wrapper: makeWrapper('/corpus?page=2') },
    );
    act(() => {
      // The coupled sort-change: set sort + dir, drop the page, all at once.
      result.current.patch({ sort: 'stepCount', dir: 'desc', page: null });
    });
    expect(result.current.sp.get('sort')).toBe('stepCount');
    expect(result.current.sp.get('dir')).toBe('desc');
    // page must be gone — the whole point of the reset.
    expect(result.current.sp.get('page')).toBeNull();
  });

  it('does not clobber earlier keys the way two separate setters would', () => {
    // Regression guard: routing sort + dir through ONE patch keeps both. Two
    // independent per-key setters in one handler would lose the first write.
    const { result } = renderHook(
      () => {
        const [sp] = useSearchParams();
        const patch = usePatchParams();
        return { sp, patch };
      },
      { wrapper: makeWrapper('/corpus') },
    );
    act(() => {
      result.current.patch({ sort: 'cluster', dir: 'asc' });
    });
    expect(result.current.sp.get('sort')).toBe('cluster');
    expect(result.current.sp.get('dir')).toBe('asc');
  });
});
