// client/src/dashboard/spa/src/routes.ts
// Canonical SPA route list — single source of truth.
// T1.4 SPA route smoke imports this so any new route automatically gets
// covered by the route-smoke gate.

export interface RouteSpec {
  path: string; // pathname (no query/hash)
  label: string; // human-readable name for test output
  /** Test-only param substitutions for parameterized routes. */
  params?: Record<string, string>;
}

export const ROUTES: RouteSpec[] = [
  { path: '/', label: 'root' },
  { path: '/overview', label: 'overview' },
  { path: '/events', label: 'events' },
  {
    path: '/events/:id',
    label: 'event-detail',
    params: { id: '1' },
  },
  { path: '/operator/execution-data', label: 'operator-execution-data' },
  { path: '/operator/claim-policy', label: 'operator-claim-policy' },
  { path: '/operator/memberships', label: 'operator-memberships' },
  { path: '/operator/registry', label: 'operator-registry' },
  { path: '/operator/network', label: 'operator-network' },
  { path: '/operator/security', label: 'operator-security' },
  { path: '/operator', label: 'operator' },
  { path: '/captures', label: 'captures' },
  { path: '/configuration', label: 'configuration' },
  { path: '/launcher/create', label: 'launcher-create' },
  {
    path: '/launcher/launched/:solverNetId',
    label: 'launcher-launched',
    params: { solverNetId: '5474_swe-rebench-v2-v1_edb172d3' },
  },
  { path: '/launcher', label: 'launcher' },
  { path: '/build', label: 'build' },
];

/** Substitute :param tokens with the spec's `params` values. */
export function expandRoutePath(spec: RouteSpec): string {
  if (!spec.params) return spec.path;
  let out = spec.path;
  for (const [k, v] of Object.entries(spec.params)) {
    out = out.replace(`:${k}`, v);
  }
  return out;
}
