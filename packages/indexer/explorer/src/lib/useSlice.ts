/**
 * useSlice — React-query hook for /explorer/slice (#611).
 *
 * Consumers (SolverNetView, later /explore) construct SliceParams and pass
 * them in; the hook encodes them to URL and returns the typed response.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './api';
import type { SliceParams, SliceResponse, SliceFilter } from './slice-types';

function encodeFilter(filter: SliceFilter): string {
  const parts: string[] = [];
  for (const [dim, values] of Object.entries(filter)) {
    if (Array.isArray(values) && values.length > 0) {
      parts.push(`filter[${dim}]=${values.map(encodeURIComponent).join(',')}`);
    }
  }
  return parts.join('&');
}

function encodeSliceParams(params: SliceParams): string {
  const base = [
    `manifestDigest=${encodeURIComponent(params.manifestDigest)}`,
    `group=${params.group}`,
    `bucket=${params.bucket}`,
  ];
  if (params.includeUnenriched) base.push('include=raw');
  if (typeof params.window === 'number') base.push(`window=${params.window}`);
  const fenc = encodeFilter(params.filter);
  if (fenc) base.push(fenc);
  return base.join('&');
}

export function useSlice(params: SliceParams) {
  return useQuery({
    queryKey: ['slice', params],
    queryFn: () =>
      fetchJson<SliceResponse>(`/explorer/slice?${encodeSliceParams(params)}`),
    enabled: Boolean(params.manifestDigest),
  });
}
