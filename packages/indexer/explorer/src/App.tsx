/**
 * App — root layout.
 *
 * Structure:
 *   <Chrome>       — sticky header (Logo + TopNav + SearchBox)
 *   <main>         — routed content, max-width 1280px, centred
 *     Route /                  → NetworkView
 *     Route /solvernets        → SolverNetsListView
 *     Route /solvernet/:cid    → SolverNetView
 *     Route /operators         → OperatorsView
 *     Route /operator/:addr    → OperatorView
 *     Route /explore/:cid      → Redirect to /solvernet/:cid (preserves query)
 *     fallback                 → 404 inline
 *
 * Each view renders its own <StatusBar> (fixed footer) from its own query data.
 * The StatusBar sits inside the view so it has access to the per-view freshness.
 */

import { Redirect, Route, Switch, useParams, useSearch } from 'wouter';
import { Chrome } from './components/Chrome';
import { NetworkView } from './views/NetworkView';
import { SolverNetsListView } from './views/SolverNetsListView';
import { SolverNetView } from './views/SolverNetView';
import { OperatorsView } from './views/OperatorsView';
import { OperatorView } from './views/OperatorView';

/**
 * /explore/<cid> back-compat redirect.
 *
 * After the merge of /explore into /solvernet/<cid> (refactor #676), the
 * /explore route is a one-line redirect that preserves the query string.
 * Historical deep-links (e.g. the locked Milestone #2 URL) and OperatorView's
 * old deep-link target both resolve transparently.
 */
function ExploreRedirect() {
  const params = useParams<{ cid: string }>();
  const search = useSearch();
  const cid = params?.cid ?? '';
  const target = `/solvernet/${cid}${search ? `?${search}` : ''}`;
  return <Redirect to={target} replace />;
}

function NotFound() {
  return (
    <div
      style={{
        padding: '64px 28px',
        fontFamily: 'var(--font-mono)',
        color: 'var(--fg-muted)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        404
      </div>
      <p style={{ color: 'var(--fg-dim)', fontSize: 13 }}>
        No such route.
      </p>
    </div>
  );
}

export function App() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
      }}
    >
      <Chrome />
      <main
        style={{
          flex: 1,
          maxWidth: 1280,
          width: '100%',
          margin: '0 auto',
          // Bottom padding leaves room for the fixed StatusBar (≈28px tall)
          paddingBottom: 28,
        }}
      >
        <Switch>
          <Route path="/" component={NetworkView} />
          <Route path="/solvernets" component={SolverNetsListView} />
          <Route path="/solvernet/:cid" component={SolverNetView} />
          <Route path="/operators" component={OperatorsView} />
          <Route path="/operator/:addr" component={OperatorView} />
          <Route path="/explore/:cid" component={ExploreRedirect} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}
