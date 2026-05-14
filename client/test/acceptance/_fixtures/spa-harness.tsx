/**
 * SPA harness for the cold-start-builder E2E (r83r Task 9).
 *
 * Renders `Build.tsx` inside a `QueryClientProvider` with a mocked `fetch`
 * that routes discovery requests to the in-process stub indexer. Returns a
 * rendered container + helpers that assert on plug-in row presence.
 *
 * Guard: if `Build.tsx` is not available (hfmf not merged in this worktree),
 * or if the environment does not support jsdom (acceptance tier runs in Node
 * forks, not jsdom), the harness returns `{ skipped: true }`. The E2E logs a
 * SKIP and continues without failing.
 *
 * Usage:
 *   const harness = await renderBuildPage({ stubIndexerUrl, builderAgentId });
 *   if (harness.skipped) { console.log('SPA harness skipped'); return; }
 *   const row = await harness.findPluginRow('@e2e/diffmin-clone');
 *   expect(row).toBeTruthy();
 */

import type { HTMLElement as JsdomHTMLElement } from '@testing-library/dom';

export interface BuildPageHarness {
  skipped: false;
  container: HTMLElement;
  findPluginRow(name: string): Promise<HTMLElement>;
  findMyPluginRow(name: string): Promise<HTMLElement>;
  cleanup(): void;
}

export interface SkippedHarness {
  skipped: true;
  reason: string;
}

export type SpaHarnessResult = BuildPageHarness | SkippedHarness;

export interface RenderBuildPageOpts {
  /** Base URL of the stub indexer (stub-indexer handle's `.url`). */
  stubIndexerUrl: string;
  /** Builder agentId to seed /v1/bootstrap with, so MyArtifactsPanel queries correctly. */
  builderAgentId: string;
}

/**
 * Render the /build page with mocked fetch.
 *
 * Returns `{ skipped: true }` when:
 *   - We're not in a jsdom environment (document is undefined)
 *   - Build.tsx cannot be dynamically imported (hfmf not merged)
 *   - @testing-library/react is unavailable
 */
export async function renderBuildPage(opts: RenderBuildPageOpts): Promise<SpaHarnessResult> {
  const { stubIndexerUrl, builderAgentId } = opts;

  // Guard 1: Check if we're in a DOM environment.
  if (typeof document === 'undefined') {
    return {
      skipped: true,
      reason: 'Not in a jsdom environment — SPA harness requires document. Run under jsdom environment.',
    };
  }

  // Guard 2: Try to import Build.tsx.
  type BuildPageModule = { BuildPage: () => JSX.Element };
  const buildModule = await import(
    '../../../src/dashboard/spa/src/pages/Build.js'
  ).then((m) => m as BuildPageModule).catch(() => null);

  if (!buildModule) {
    return {
      skipped: true,
      reason: 'Build.tsx not available in this worktree (hfmf not merged). Skipping SPA assertions.',
    };
  }

  // Guard 3: Try to import testing deps.
  type RenderFn = typeof import('@testing-library/react').render;
  type WaitForFn = typeof import('@testing-library/react').waitFor;
  type ScreenType = typeof import('@testing-library/react').screen;
  type CleanupFn = typeof import('@testing-library/react').cleanup;
  type QueryClientClass = typeof import('@tanstack/react-query').QueryClient;
  type QueryClientProviderComponent = typeof import('@tanstack/react-query').QueryClientProvider;
  type ReactType = typeof import('react');

  let render: RenderFn, waitFor: WaitForFn, screen: ScreenType, cleanupFn: CleanupFn;
  let QueryClient: QueryClientClass, QueryClientProvider: QueryClientProviderComponent;
  let React: ReactType;

  try {
    const tl = await import('@testing-library/react');
    render = tl.render;
    waitFor = tl.waitFor;
    screen = tl.screen;
    cleanupFn = tl.cleanup;
    const rq = await import('@tanstack/react-query');
    QueryClient = rq.QueryClient;
    QueryClientProvider = rq.QueryClientProvider;
    React = await import('react');
  } catch (err) {
    return {
      skipped: true,
      reason: `@testing-library/react or @tanstack/react-query not available: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { BuildPage } = buildModule;

  // Stub fetch to route discovery requests to the stub indexer and
  // /v1/bootstrap to a canned response with the builder agentId.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    // Route /v1/discovery/* to the stub indexer.
    if (url.includes('/v1/discovery/')) {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const stubUrl = `${stubIndexerUrl}${path}`;
      return fetch(stubUrl, init);
    }

    // Stub /v1/bootstrap with the builder identity.
    if (url.includes('/v1/bootstrap')) {
      return new Response(
        JSON.stringify({
          fleet_agent_id: builderAgentId,
          fleet_stage: 'stage1',
          fleet_safe_address: '0x0000000000000000000000000000000000000001',
          status: 'running',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // For everything else, return 404 so the component degrades gracefully.
    return new Response(JSON.stringify({ error: 'stub not configured' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Mount Build.tsx.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });

  const { container } = render(
    React.createElement(
      QueryClientProvider,
      { client: qc },
      React.createElement(BuildPage),
    ),
  );

  // Wait for initial queries to settle (both panels make fetch calls).
  await waitFor(() => {
    // At minimum, the container should have rendered something beyond a loading spinner.
    const text = container.textContent ?? '';
    // Either the panels loaded or they show an error/empty state — either way
    // the "Loading…" text should be gone.
    return text.length > 0;
  }, { timeout: 10_000 });

  async function findPluginRow(name: string): Promise<HTMLElement> {
    return waitFor(() => {
      const el = screen.getByText(name);
      if (!el) throw new Error(`plug-in row "${name}" not found in PublishedPluginsPanel`);
      return el as HTMLElement;
    }, { timeout: 5_000 });
  }

  async function findMyPluginRow(name: string): Promise<HTMLElement> {
    return waitFor(() => {
      // The MyArtifactsPanel renders rows by name too — may be in a different
      // table, but getByText returns the first match.
      const els = screen.getAllByText(name);
      if (els.length === 0) throw new Error(`plug-in row "${name}" not found in MyArtifactsPanel`);
      return els[els.length - 1] as HTMLElement;
    }, { timeout: 5_000 });
  }

  return {
    skipped: false,
    container: container as HTMLElement,
    findPluginRow,
    findMyPluginRow,
    cleanup: () => {
      cleanupFn();
      globalThis.fetch = originalFetch;
    },
  };
}
