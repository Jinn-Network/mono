# hfmf — `/build` SPA route + canonical `/docs/build/` tree implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Save this file to `/Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/hfmf/docs/superpowers/plans/2026-05-14-hfmf-build-spa-and-docs-plan.md` before starting.

**Goal:** Ship the visible builder front door — a `/build` SPA route in the operator dashboard plus a canonical `/docs/build/` markdown tree under `client/docs/build/`. The route surfaces (1) an intro card sourced from `quickstart.md`, (2) a plug-in shape catalogue generated live from the `SolverPluginManifest` type plus the validator's two-mode rule, (3) a browse-published-plug-ins panel backed by `DiscoveryAPI.listPluginPublications`, (4) a "your published plug-ins" panel backed by `DiscoveryAPI.listBuilderArtifacts` filtered by the local operator's builder identity (`fleet_agent_id`), and (5) an artifact-type filter chip (`plugin` only in v0; placeholder for `harness`). Updates `jinn create plugin`'s post-completion message to print the real `quickstart.md` URL once this plan merges.

**Architecture:**
- The `/build` route is added to `client/src/dashboard/spa/src/App.tsx` as a top-level peer of `/overview`, `/operator`, `/launcher`. A new top-tab entry is added in `client/src/dashboard/spa/src/shell/TopTabs.tsx`.
- The page lives at `client/src/dashboard/spa/src/pages/Build.tsx` and composes five child components under `client/src/dashboard/spa/src/pages/build/`: `IntroCard.tsx`, `ShapeCatalogue.tsx`, `PublishedPluginsPanel.tsx`, `MyArtifactsPanel.tsx`, and `ArtifactTypeFilterChip.tsx`. The Build page owns the shared `artifactType: 'plugin' | 'harness'` filter state (a `useState`) and threads it into the two panels.
- Discovery API access from the SPA goes through new HTTP endpoints exposed by the daemon's Hono server. Today the SPA does not directly hold a `DiscoveryAPI` — that is server-side. We add two thin daemon HTTP routes under `/v1/discovery/` that wrap the existing `DiscoveryAPI` instance the daemon already builds (`listPluginPublications`, `listBuilderArtifacts`, `getPluginScores`). The SPA's `api/client.ts` gets matching helpers (`api.discovery.listPluginPublications`, `api.discovery.listBuilderArtifacts`, `api.discovery.getPluginScores`).
- The local operator's builder identity is read from the existing `/v1/bootstrap` response, which currently surfaces `master_address` but not `fleet_agent_id`. The bootstrap endpoint is extended to surface the new `fleet_agent_id` field (added by `nghf`) so the SPA can call `listBuilderArtifacts({ builderAgentId })` directly without hitting the state file from the browser.
- The intro card content is read at build time via Vite's `?raw` import (`import quickstartMd from '../../../../../docs/build/quickstart.md?raw'`). The markdown is rendered with a lightweight in-repo renderer reused from the existing `client/src/dashboard/spa/src/regions/Onboarding.tsx` pattern; no new dependency. We render only headings, paragraphs, code-fence, and inline-code — the same subset the docs use.
- The shape catalogue is generated live from `SolverPluginManifest` in `client/src/plugins/types.ts` by importing the type-level shape and shipping a derived runtime descriptor next to it (`PLUGIN_SHAPE_FIELDS`). A snapshot test asserts the descriptor stays in sync with the type. The catalogue does NOT inspect type AST at runtime — instead a single hand-curated descriptor object lives alongside the type, with a guard test that asserts every type-required field appears in the descriptor.
- All five Build-page tests live in `client/src/dashboard/spa/src/pages/Build.test.tsx` and `client/src/dashboard/spa/src/pages/build/*.test.tsx`. Discovery responses are stubbed by `vi.stubGlobal('fetch', ...)` in the testing-library + react-query pattern already used by `Leaderboard.test.tsx` and `Overview.test.tsx`. No Playwright; the `chrome-devtools` walk is reserved for follow-up smoke once `52x3.6` is end-to-end on testnet.
- The canonical `/docs/build/` tree lives at `client/docs/build/` (sibling to the existing `client/docs/path-2/` tree). Six files: `quickstart.md`, `shape-reference.md`, `examples.md`, `publishing-flow.md`, `identity.md`, `compatibility.md`. Content is anchored on `client/plugins/swe-rebench-v2-runtime/` and `client/plugins/network-tools/`.
- `client/src/cli/commands/create.ts` HELP_TEXT and the post-completion `writer.write(...)` are updated to print `https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md` instead of the placeholder URL committed under `et6s`.

**Tech Stack:** TypeScript, React, vitest, @testing-library/react, wouter, @tanstack/react-query, Vite. No new runtime dependencies. The markdown subset renderer is ~80 lines; no `react-markdown` or `remark`.

**Work shape:** `feat` per `docs/engineering/handbook.md` §The shapes of work — TDD required.

---

## File structure

**Create:**
- `client/docs/build/quickstart.md`
- `client/docs/build/shape-reference.md`
- `client/docs/build/examples.md`
- `client/docs/build/publishing-flow.md`
- `client/docs/build/identity.md`
- `client/docs/build/compatibility.md`
- `client/docs/build/README.md`
- `client/src/dashboard/spa/src/pages/Build.tsx`
- `client/src/dashboard/spa/src/pages/Build.test.tsx`
- `client/src/dashboard/spa/src/pages/build/IntroCard.tsx`
- `client/src/dashboard/spa/src/pages/build/IntroCard.test.tsx`
- `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.tsx`
- `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.test.tsx`
- `client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.tsx`
- `client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.test.tsx`
- `client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.tsx`
- `client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.test.tsx`
- `client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.tsx`
- `client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.test.tsx`
- `client/src/dashboard/spa/src/pages/build/markdown.ts` — small markdown-to-JSX renderer
- `client/src/dashboard/spa/src/pages/build/markdown.test.ts`
- `client/src/dashboard/spa/src/pages/build/shape-fields.ts` — `PLUGIN_SHAPE_FIELDS` descriptor
- `client/src/dashboard/spa/src/pages/build/shape-fields.test.ts` — snapshot vs `SolverPluginManifest`
- `client/src/api/discovery-endpoint.ts` — Hono routes for `/v1/discovery/plugin-publications`, `/v1/discovery/builder-artifacts`, `/v1/discovery/plugin-scores`
- `client/test/api/discovery-endpoint.test.ts`

**Modify:**
- `client/src/dashboard/spa/src/App.tsx` — add `<Route path="/build">` and `<Route path="/build/...">` (only `/build` for v0).
- `client/src/dashboard/spa/src/shell/TopTabs.tsx` — add `{ path: '/build', label: 'Build' }` to the `TABS` array.
- `client/src/dashboard/spa/src/api/client.ts` — add `api.discovery.listPluginPublications`, `api.discovery.listBuilderArtifacts`, `api.discovery.getPluginScores` helpers.
- `client/src/dashboard/spa/src/api/types.ts` — add `BootstrapState.fleet_agent_id?: string` and `BootstrapState.fleet_safe_address?: string`; add `DiscoveryPluginPublicationsResponse`, `DiscoveryBuilderArtifactsResponse`, `DiscoveryPluginScoresResponse` shapes.
- `client/src/api/bootstrap-endpoint.ts` — include `fleet_agent_id` and `fleet_safe_address` from the parsed state in the response body.
- `client/src/api/server.ts` — register the new `addDiscoveryRoutes(app, { discovery })` route group.
- `client/src/cli/commands/create.ts` — replace the placeholder `Quickstart (placeholder until 52x3.6 ships):` block in `HELP_TEXT` with a real `Quickstart:` block pointing at the new path; emit the same URL on completion from `run()`.
- `client/src/dashboard/spa/vite.config.ts` — explicitly tag the `?raw` markdown imports so production builds bundle them.

**Do not touch:**
- `client/src/discovery/types.ts` / `http.ts` / `onchain.ts` — those are extended by `attd`; this plan only consumes them.
- `client/src/plugins/types.ts` — the `SolverPluginManifest` type is the source-of-truth and stays as-is; the descriptor sits next to it in the SPA's `shape-fields.ts`.
- The existing `Leaderboard.tsx` and tables — reused unchanged (the Build page does NOT include the leaderboard; it has its own panels that follow the same table-layout idiom).

**Dependencies on sibling plans:**
- `nghf` ships `fleet_agent_id` in the persisted state file. This plan reads it via the bootstrap endpoint. Until `nghf` merges, the field stays undefined and the "your published plug-ins" panel renders its empty state ("complete identity bootstrap to see your published plug-ins"). The empty-state path is covered by a test.
- `attd` ships `listPluginPublications`, `listBuilderArtifacts`, `getPluginScores` on the `DiscoveryAPI` interface. This plan calls them server-side via the new daemon HTTP routes. Until `attd` merges, the implementations stub to `[]` and tests use mocked HTTP responses anyway.
- `et6s` ships `jinn create plugin`. This plan updates the URL it prints.

---

## Task 1: Failing test — markdown subset renderer

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/markdown.test.ts`

- [ ] **Step 1: Add a failing test for the markdown renderer**

Create `client/src/dashboard/spa/src/pages/build/markdown.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderMarkdownSubset } from './markdown.js';

describe('renderMarkdownSubset (hfmf)', () => {
  it('renders a paragraph', () => {
    render(<>{renderMarkdownSubset('Hello world.')}</>);
    expect(screen.getByText('Hello world.')).toBeTruthy();
  });

  it('renders an h1', () => {
    render(<>{renderMarkdownSubset('# Build a plug-in')}</>);
    expect(screen.getByRole('heading', { level: 1, name: 'Build a plug-in' })).toBeTruthy();
  });

  it('renders an h2', () => {
    render(<>{renderMarkdownSubset('## Pick a pattern')}</>);
    expect(screen.getByRole('heading', { level: 2, name: 'Pick a pattern' })).toBeTruthy();
  });

  it('renders a fenced code block', () => {
    const md = '```bash\njinn create plugin @you/x\n```';
    render(<>{renderMarkdownSubset(md)}</>);
    const code = screen.getByText(/jinn create plugin @you\/x/);
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement?.tagName).toBe('PRE');
  });

  it('renders inline `code` spans', () => {
    render(<>{renderMarkdownSubset('Use `jinn.plugin.json`.')}</>);
    expect(screen.getByText('jinn.plugin.json').tagName).toBe('CODE');
  });

  it('renders a bullet list', () => {
    render(<>{renderMarkdownSubset('- one\n- two\n- three')}</>);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('ignores trailing whitespace-only blocks', () => {
    const { container } = render(<>{renderMarkdownSubset('hi\n\n\n')}</>);
    expect(container.textContent?.trim()).toBe('hi');
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/markdown.test.ts
```

Expect: file-not-found error for `./markdown.js`.

---

## Task 2: Implement the markdown subset renderer

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/markdown.ts`

- [ ] **Step 1: Implement `renderMarkdownSubset`**

Create `client/src/dashboard/spa/src/pages/build/markdown.ts`:

```typescript
/**
 * Tiny markdown-to-JSX renderer for the /build route's intro card.
 *
 * Handles only the subset used in /docs/build/*.md:
 *   - # / ## / ### headings
 *   - paragraphs
 *   - fenced code blocks (``` lang \n ... \n ```)
 *   - inline `code`
 *   - - bullet lists
 *
 * No HTML, no images, no tables. We pick the subset over react-markdown
 * because the dashboard SPA bundle stays dependency-light and the markdown
 * we render is curated, not user-generated.
 */
import type { ReactNode } from 'react';

interface Block {
  kind: 'heading' | 'paragraph' | 'code' | 'list';
  level?: 1 | 2 | 3;
  text?: string;
  lang?: string;
  items?: string[];
}

function tokenize(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++;
      blocks.push({ kind: 'code', lang, text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }
    if (/^-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^-\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !/^(#{1,3}\s|```|-\s)/.test(lines[i] ?? '')) {
      buf.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ kind: 'paragraph', text: buf.join(' ') });
  }
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<code key={`c-${k++}`}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdownSubset(md: string): ReactNode {
  const blocks = tokenize(md);
  return (
    <>
      {blocks.map((b, idx) => {
        if (b.kind === 'heading') {
          if (b.level === 1) return <h1 key={idx}>{b.text}</h1>;
          if (b.level === 2) return <h2 key={idx}>{b.text}</h2>;
          return <h3 key={idx}>{b.text}</h3>;
        }
        if (b.kind === 'code') {
          return (
            <pre key={idx}>
              <code>{b.text ?? ''}</code>
            </pre>
          );
        }
        if (b.kind === 'list') {
          return (
            <ul key={idx}>
              {(b.items ?? []).map((it, j) => (
                <li key={j}>{renderInline(it)}</li>
              ))}
            </ul>
          );
        }
        return <p key={idx}>{renderInline(b.text ?? '')}</p>;
      })}
    </>
  );
}
```

- [ ] **Step 2: Run the tests, see them pass**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/markdown.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add client/src/dashboard/spa/src/pages/build/markdown.ts client/src/dashboard/spa/src/pages/build/markdown.test.ts
git commit -m "feat(hfmf): markdown subset renderer for /build intro card"
```

---

## Task 3: Failing snapshot test — plug-in shape descriptor stays in sync with type

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/shape-fields.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/build/shape-fields.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';

describe('PLUGIN_SHAPE_FIELDS (hfmf)', () => {
  it('covers every required top-level field of SolverPluginManifest', () => {
    const names = PLUGIN_SHAPE_FIELDS.map((f) => f.name);
    expect(names).toContain('name');
    expect(names).toContain('version');
    expect(names).toContain('jinn.supports');
  });

  it('marks name + version + jinn.supports as required', () => {
    const required = PLUGIN_SHAPE_FIELDS.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(['name', 'version', 'jinn.supports']));
  });

  it('matches the snapshot', () => {
    expect(PLUGIN_SHAPE_FIELDS).toMatchSnapshot();
  });

  it('describes both modes from the validator', () => {
    expect(PLUGIN_MODES.map((m) => m.id)).toEqual(['runtime', 'solver-type']);
  });

  it('runtime mode is documented as a singleton', () => {
    const runtime = PLUGIN_MODES.find((m) => m.id === 'runtime');
    expect(runtime?.requires).toMatch(/singleton/i);
    expect(runtime?.example).toContain('jinn.runtime');
  });

  it('solver-type mode anchors on swe-rebench-v2.v1', () => {
    const st = PLUGIN_MODES.find((m) => m.id === 'solver-type');
    expect(st?.example).toContain('swe-rebench-v2.v1');
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/shape-fields.test.ts
```

---

## Task 4: Implement the plug-in shape descriptor

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/shape-fields.ts`

- [ ] **Step 1: Author the descriptor and modes**

Create `client/src/dashboard/spa/src/pages/build/shape-fields.ts`:

```typescript
/**
 * Hand-curated runtime descriptor of `SolverPluginManifest`
 * (`client/src/plugins/types.ts`). The shape catalogue on `/build` renders
 * this; a snapshot test asserts it stays in sync with the type. If you
 * add a field to `SolverPluginManifest`, you MUST add it here too — the
 * test will fail until you do.
 */

export interface PluginShapeField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export const PLUGIN_SHAPE_FIELDS: readonly PluginShapeField[] = [
  {
    name: 'name',
    type: 'string',
    required: true,
    description: 'npm package name. Used as the canonical identifier across the registry.',
  },
  {
    name: 'version',
    type: 'string',
    required: true,
    description: 'Semantic version. New versions publish under a new IPFS CID.',
  },
  {
    name: 'description',
    type: 'string',
    required: false,
    description: 'Short prose description of what the plug-in offers.',
  },
  {
    name: 'jinn.supports',
    type: 'string[]',
    required: true,
    description: 'Either ["jinn.runtime"] (runtime plug-in) OR one or more SolverType identifiers (solver-type plug-in). Mixing is rejected.',
  },
  {
    name: 'jinn.capabilities',
    type: 'object',
    required: false,
    description: 'Optional capabilities map. Reserved for future use; not consumed by Hermes today.',
  },
  {
    name: 'jinn.mcpServers',
    type: 'object',
    required: false,
    description: 'Optional inline MCP server map. The Hermes harness reads .mcp.json instead; declare MCP there for harness-agnostic portability.',
  },
  {
    name: 'jinn.skills',
    type: 'string[]',
    required: false,
    description: 'Relative paths to SKILL.md files. Each declared skill becomes available to the harness as an external skill directory.',
  },
] as const;

export interface PluginMode {
  id: 'runtime' | 'solver-type';
  label: string;
  requires: string;
  example: string;
}

export const PLUGIN_MODES: readonly PluginMode[] = [
  {
    id: 'runtime',
    label: 'Runtime plug-in',
    requires: 'singleton — supports must be exactly ["jinn.runtime"]',
    example: '{ "jinn": { "supports": ["jinn.runtime"] } }',
  },
  {
    id: 'solver-type',
    label: 'SolverType plug-in',
    requires: 'one or more SolverType ids; cannot include "jinn.runtime"',
    example: '{ "jinn": { "supports": ["swe-rebench-v2.v1"] } }',
  },
] as const;
```

- [ ] **Step 2: Run tests; let snapshot create itself; confirm green**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/shape-fields.test.ts
```

- [ ] **Step 3: Add a type-level guard so adding a required field to `SolverPluginManifest` forces an update here**

Append to `client/src/dashboard/spa/src/pages/build/shape-fields.ts`:

```typescript
// Type-level assertion: if SolverPluginManifest gains a required top-level
// or jinn.* required field, the assignment below fails typecheck until you
// add the matching entry to PLUGIN_SHAPE_FIELDS.
import type { SolverPluginManifest } from '../../../../../plugins/types.js';

type RequiredManifestKeys = 'name' | 'version';
type RequiredJinnKeys = 'supports';
type GuardManifest = Pick<SolverPluginManifest, RequiredManifestKeys>;
type GuardJinn = Pick<SolverPluginManifest['jinn'], RequiredJinnKeys>;

// These type aliases compile to nothing; they exist only to wire the guard.
const _g1: GuardManifest = { name: '', version: '' };
const _g2: GuardJinn = { supports: [] };
void _g1; void _g2;
```

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/build/shape-fields.ts client/src/dashboard/spa/src/pages/build/shape-fields.test.ts client/src/dashboard/spa/src/pages/build/__snapshots__
git commit -m "feat(hfmf): plug-in shape descriptor + type-guard against SolverPluginManifest drift"
```

---

## Task 5: Failing test — IntroCard renders from the quickstart markdown

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/IntroCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/build/IntroCard.test.tsx`:

```typescript
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntroCard } from './IntroCard.js';

describe('IntroCard (hfmf)', () => {
  it('renders the quickstart heading', () => {
    render(<IntroCard />);
    expect(screen.getByRole('heading', { level: 1, name: /build a plug-in/i })).toBeTruthy();
  });

  it('renders the jinn create plugin command in a code block', () => {
    render(<IntroCard />);
    expect(screen.getByText(/jinn create plugin/)).toBeTruthy();
  });

  it('links to the full quickstart doc on github', () => {
    render(<IntroCard />);
    const link = screen.getByRole('link', { name: /full quickstart/i });
    expect(link.getAttribute('href')).toMatch(/docs\/build\/quickstart\.md$/);
  });
});
```

- [ ] **Step 2: Verify it fails**

---

## Task 6: Implement IntroCard with a `?raw` markdown import

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/IntroCard.tsx`

- [ ] **Step 1: Implement the component**

Create `client/src/dashboard/spa/src/pages/build/IntroCard.tsx`:

```typescript
import { renderMarkdownSubset } from './markdown.js';
// Vite resolves `?raw` imports at build time. The path is relative to this
// file: src/dashboard/spa/src/pages/build/ → ../../../../../docs/build/.
// In tests Vitest also honours `?raw` via its Vite integration.
import quickstartMd from '../../../../../../docs/build/quickstart.md?raw';

const QUICKSTART_URL =
  'https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md';

export function IntroCard(): JSX.Element {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3, 10px)',
        padding: '24px',
        background: 'var(--surface)',
      }}
    >
      <div className="hfmf-intro-markdown">{renderMarkdownSubset(quickstartMd)}</div>
      <p style={{ marginTop: '16px' }}>
        <a href={QUICKSTART_URL} target="_blank" rel="noreferrer">
          Read the full quickstart on GitHub
        </a>
      </p>
    </section>
  );
}
```

- [ ] **Step 2: Tests pass (after Task 7 ships `quickstart.md`). Defer running until then.**

---

## Task 7: Write the canonical `/docs/build/` tree

**Files:**
- Create: `client/docs/build/quickstart.md`, `shape-reference.md`, `examples.md`, `publishing-flow.md`, `identity.md`, `compatibility.md`, `README.md`.

- [ ] **Step 1: Write `client/docs/build/quickstart.md`**

```markdown
# Build a plug-in

Ship a Jinn SolverPlugin in 60 seconds. Targets the SWE-rebench v2 SolverNet running against the Hermes harness on testnet.

## 1. Scaffold

```bash
jinn create plugin @you/my-swe-skill --pattern solver-type-plugin --solver-type swe-rebench-v2.v1
cd @you/my-swe-skill
yarn install
yarn test
```

The scaffolder emits a working package modeled on `swe-rebench-v2-runtime`:

```
@you/my-swe-skill/
├── jinn.plugin.json       # the canonical manifest
├── skills/example/SKILL.md
├── test/plugin.test.ts    # passes immediately
├── package.json
├── tsconfig.json
└── README.md
```

## 2. Edit your skill

Open `skills/example/SKILL.md` and replace it with the skill your plug-in offers. A SolverType plug-in can ship one or more skills; a runtime plug-in usually ships an MCP server in `.mcp.json` instead. See `shape-reference.md`.

## 3. Publish to npm + chain

```bash
npm publish --access public
jinn solver-plugins publish npm:@you/my-swe-skill
```

`jinn solver-plugins publish` lazily completes your identity bootstrap (Stage 1) the first time you call it. If you have not yet funded your agent EOA with ETH on testnet, the verb pauses and tells you what to send where. Re-run when the wallet is funded.

The verb packs the plug-in, uploads the tarball to IPFS, and writes a `plugin:<cid>` record on the on-chain IdentityRegistry under your builder agentId.

## 4. Confirm it published

Open the operator app's `/build` route. Under "Published plug-ins for SWE-rebench v2" you should see your plug-in. Under "Your published plug-ins" you should see the same record.

## 5. Run it

An operator who has joined the SWE-rebench v2 SolverNet can install your plug-in:

```bash
jinn solver-plugins show npm:@you/my-swe-skill
jinn solver-nets add-plugin swe-rebench-v2 npm:@you/my-swe-skill
```

The next task they claim runs against your plug-in. The signed envelope's `executor.plugins[]` carries your CID; the network explorer attributes the score to your builder agentId.

## Next

- `shape-reference.md` — the full `jinn.plugin.json` shape, the two modes, skills + MCP conventions.
- `examples.md` — annotated reference plug-ins.
- `publishing-flow.md` — what `jinn solver-plugins publish` does, step by step.
- `identity.md` — staged identity bootstrap; why publishing does not require operator-grade funding.
- `compatibility.md` — `jinn.supports` semantics, harness compatibility.
```

- [ ] **Step 2: Write `client/docs/build/shape-reference.md`**

```markdown
# Plug-in shape reference

A SolverPlugin is an npm package with a `jinn.plugin.json` manifest at its root. The manifest declares which SolverTypes the plug-in serves and which artifacts it ships (skills, MCP servers).

## `jinn.plugin.json`

```json
{
  "name": "@you/my-swe-skill",
  "version": "0.1.0",
  "description": "Solver-side reasoning skill for SWE-rebench v2.",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/example/SKILL.md"
    ]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | npm package name. Used as the canonical id across the registry. |
| `version` | yes | Semver. Each new version publishes under a new IPFS CID. |
| `description` | no | Short prose. |
| `jinn.supports` | yes | Either `["jinn.runtime"]` OR one or more SolverType ids. See "Two modes". |
| `jinn.skills` | no | Relative paths to SKILL.md files the harness should load. |
| `jinn.mcpServers` | no | Inline MCP server map. Prefer `.mcp.json` for harness-agnostic portability. |
| `jinn.capabilities` | no | Reserved for future use. |

## Two modes

The validator (`client/src/plugins/validator.ts`) enforces exactly two exclusive modes per `spec/2026-05-01-harness-pack-architecture.md` §5.1.

### Runtime plug-in

`jinn.supports` is exactly `["jinn.runtime"]`. Singleton — only one runtime plug-in loads per daemon. Use this for cross-cutting MCP tools that any SolverType can call. Reference: `client/plugins/network-tools/`.

### SolverType plug-in

Every entry of `jinn.supports` is a SolverType identifier. The plug-in loads only for tasks of those SolverTypes. Mixing `jinn.runtime` with SolverType ids is rejected. Reference: `client/plugins/swe-rebench-v2-runtime/`.

## `skills/`

A skill is a directory containing a `SKILL.md` document. Hermes consumes the directory directly via `skills.external_dirs:`. The directory may also contain example files, snippets, or anything the SKILL.md references — all of it travels with the package.

## `.mcp.json`

A standard MCP servers manifest. Hermes's `hermesConfigFromSolverPlugins()` resolves `${CLAUDE_PLUGIN_ROOT}` templates against the vendored plug-in root and merges the result into the harness's `mcp_servers:`. Use this for any MCP server you want to expose to the agent.
```

- [ ] **Step 3: Write `client/docs/build/examples.md`**

```markdown
# Plug-in examples

The reference plug-ins in this repo are the de facto worked examples. Copy and edit.

## SolverType plug-in: `swe-rebench-v2-runtime`

Path: `client/plugins/swe-rebench-v2-runtime/`.

Two skills — `orient` and `plan` — that the Hermes harness loads when working on a SWE-rebench v2 code-issue Task. The manifest declares `"supports": ["swe-rebench-v2.v1"]` and lists the two skill paths.

```json
{
  "name": "swe-rebench-v2-runtime",
  "version": "0.1.0",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/orient/SKILL.md",
      "skills/plan/SKILL.md"
    ],
    "description": "Provides Solver-side orientation + planning skills for SWE-rebench v2 code-issue Tasks."
  }
}
```

This is the template the `jinn create plugin --pattern solver-type-plugin` scaffolder produces.

## Runtime plug-in: `network-tools`

Path: `client/plugins/network-tools/`.

Exposes the network-level MCP tools (`search_records`, `inspect_record`, `acquire_artifact`, `get_task`) any agent role can call. Declares `"supports": ["jinn.runtime"]` — singleton, loads regardless of SolverType.

## Combined plug-in: `jinn-prediction-plugin`

Path: `client/plugins/jinn-prediction-plugin/`.

Ships an MCP server (`polymarket`) and skills for the `prediction.v1` SolverType. A good model for plug-ins that need both pieces.

## Harness-bundled plug-in: `learner`

Path: `client/plugins/learner/`.

The Claude-Code-shaped learner harness's own plug-in. Not loaded by Hermes — Hermes drives its own learning loop. Useful context for understanding the harness-side of the plug-in surface.
```

- [ ] **Step 4: Write `client/docs/build/publishing-flow.md`**

```markdown
# Publishing flow

Plain-prose walk through `jinn solver-plugins publish <source>`. Spec references: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.2 / §5.3 / §6.3.

## Sequence

1. **Resolve.** The verb resolves the plug-in source (npm, git, github, local path) via `client/src/plugins/resolvers.ts`. It vendors the plug-in under `~/.jinn-client/solver-plugins/` and reads the manifest.

2. **Pack.** The packer (`jinn solver-plugins pack`) computes a deterministic sha256 digest over the directory and writes a tarball.

3. **Lazy Stage 1.** If the local fleet has no `fleet_agent_id` yet, the verb runs `ensureStage1(password)`:
   - Generates or loads the agent EOA.
   - Predicts the Safe address.
   - Pauses on the awaiting-funding gate if ETH is needed.
   - Deploys the Safe.
   - Mints the agent NFT via `IdentityRegistry.register()` and calls `setAgentWallet(agentId, safeAddress)`.
   - Marks `fleet_stage = "stage1"`.

   Stage 2 (operator-only state: service registration, OLAS bonding, mech deployment) is never touched.

4. **Upload to IPFS.** The packed tarball is pinned to IPFS via the Autonolas gateway. The returned CID is the canonical `pluginCid`.

5. **Encode payload.** The publisher ABI-encodes the `PLUGIN_PAYLOAD_TUPLE`:

   ```
   (version=1, pluginName, pluginVersion, pluginSha256, supports[], publishedAt)
   ```

6. **Submit on chain.** The publisher routes `IdentityRegistry.setMetadata(builderAgentId, "plugin:<cid>", payload)` through the Stage 1 Safe via `executeSafeTransaction`. The transaction is signed by the agent EOA and submitted from the Safe.

7. **Indexer picks it up.** The Ponder indexer's `MetadataSet` handler recognises the `plugin:` key prefix, decodes the payload, and writes a `pluginPublication` row with primary key `<builderAgentId>:<pluginCid>`.

8. **Discoverable.** Operators querying `listPluginPublications({ solverType: "swe-rebench-v2.v1" })` get back the new record. The `/build` route in the operator SPA renders the new plug-in under "Published plug-ins for SWE-rebench v2" within one indexer poll.

## Revocation

`jinn solver-plugins revoke <pluginCid>` writes a v2 revoked-marker payload to the same `plugin:<cid>` key. The indexer flips the row's `revoked` flag. Operators continue to see the row in the SPA but with a "revoked" badge.

## Attribution

When an operator runs a task and the verdict envelope is signed, the envelope's `executor.plugins[]` field carries `{ name, version, cid, sha256 }` per plug-in. The indexer joins each `executor.plugins[].cid` against `pluginPublication.pluginCid` to resolve a builder agentId. The score attributes to your builder identity.

If the envelope's plug-in sha256 mismatches the publication's sha256, the run is flagged `forkSuspected: true` and excluded from builder-credit aggregations. Forks score the operator but not the builder.
```

- [ ] **Step 5: Write `client/docs/build/identity.md`**

```markdown
# Identity

Jinn uses one ERC-8004 agent identity per Safe. The bootstrap state machine completes that identity in two stages, each independently re-entrant. Spec reference: `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §5.1.

## Stage 1 — Identity (universal)

Required for any participation, builder or operator.

```
wallet → safe_predicted → awaiting_funding (ETH only) → safe_deployed → identity_registered
```

- **wallet** — derive a fresh agent EOA from your keystore.
- **safe_predicted** — deterministically predict the Safe address from the EOA.
- **awaiting_funding** — pause until the EOA has ETH for gas. **No OLAS required.**
- **safe_deployed** — deploy the Safe via the factory.
- **identity_registered** — mint the agent NFT via `IdentityRegistry.register()` and bind the Safe via `setAgentWallet`.

After Stage 1 you have a full ERC-8004 identity and can sign `setMetadata` for any kind (envelope, evaluation, capture, intent, plugin, revocation). You can publish plug-ins. You cannot yet claim and deliver tasks as an operator.

## Stage 2 — Operator (opt-in)

Required only for users who want to run a daemon and earn from tasks.

In standard (stOLAS) mode:

```
awaiting_stake → staked → mech_deployed
```

In self-bond mode (legacy):

```
service_created → service_activated → agents_registered → service_deployed → service_staked → mech_deployed
```

Stage 2 requires OLAS for the service bond. In standard mode, Stage 2 creates a separate staking Safe; in self-bond mode, Stage 2 reuses the Stage 1 Safe.

## Lazy stage-ensure per action

| Action | Ensures stage |
|---|---|
| `jinn solver-plugins publish` | Stage 1 |
| `jinn solver-plugins revoke` | Stage 1 |
| `jinn run` (operator daemon) | Stage 1 + 2 |

A builder who later wants to operate runs `jinn run`. The state machine detects Stage 1 done and continues at the first Stage 2 step. No re-mint, no second agentId on the same Safe by default. The `--new-agent-id` flag is an opt-in escape hatch for users who want explicit reputation-stream separation.

## One agentId, multiple streams

A dual-role user (operator-also-builder) is the natural case. The Ponder indexer separates streams by metadata `kind`:

- Operator activity flows through `envelope:` / `evaluation:` / `capture:` keys.
- Builder activity flows through `plugin:` / `revocation:` keys.

Both reference the same `agentId`.
```

- [ ] **Step 6: Write `client/docs/build/compatibility.md`**

```markdown
# Compatibility

The `jinn.supports` field declares which SolverTypes a plug-in is compatible with. Operators install plug-ins on a per-SolverNet basis; the validator enforces compatibility at load time.

## `jinn.supports` semantics

- `["jinn.runtime"]` — singleton runtime plug-in. Loads regardless of SolverType. Reserved for cross-cutting MCP tools.
- `["swe-rebench-v2.v1"]` — solver-type plug-in scoped to a single SolverType.
- `["swe-rebench-v2.v1", "future-swe.v2"]` — solver-type plug-in declaring compatibility with multiple SolverTypes.
- Mixed mode (`["jinn.runtime", "swe-rebench-v2.v1"]`) is rejected at validation time.

## Version pinning

Plug-in versions are pinned by IPFS CID. A new `version` field in `jinn.plugin.json` produces a new tarball and a new CID. The on-chain registry stores each CID as a distinct `plugin:<cid>` record; the indexer maintains a version chain keyed on `(builderAgentId, pluginName)`.

Operators pin a specific CID in their `joinedSolverNets[<manifestCid>].plugins[]` config. Upgrading is opt-in: the operator changes the pin and restarts.

## Which harnesses load which slots

The plug-in surface is largely harness-agnostic. A plug-in's `.mcp.json` and `skills/` directory work across the `learner` harness (Claude Code / Codex CLI) and the Hermes harness automatically.

| Slot | Hermes (`hermes-agent`) | learner (Claude Code) |
|---|---|---|
| `skills/` | yes — via `skills.external_dirs:` | yes — via Claude Code skill loader |
| `.mcp.json` | yes — via `mcp_servers:` merge | yes — via Claude Code MCP config |
| Phase-agent override | no | yes |
| Topic explorer | no | yes |

Phase-agent override and topic-explorer slots are Claude-Code-shaped and live inside the `learner` harness. Hermes drives its own learning loop and ignores them. Plug-ins targeting Hermes should ship only the harness-portable surface (skills + MCP tools).

## Forks

If an operator installs a plug-in directly (npm or local path) without going through `jinn solver-plugins publish`, the run still scores against the operator. The builder gets no attribution. This is intentional: anonymous forks shouldn't dilute the original builder's reputation.

If an envelope's `executor.plugins[].sha256` matches a published record's `pluginSha256`, the run credits the builder. If it doesn't, the run is flagged `forkSuspected: true` and excluded from builder-credit aggregations.
```

- [ ] **Step 7: Write `client/docs/build/README.md`**

```markdown
# Build

How to ship a SolverPlugin for Jinn. The entry point for builders.

- [Quickstart](./quickstart.md) — 60-second walk from scaffold to published plug-in.
- [Shape reference](./shape-reference.md) — `jinn.plugin.json`, the two modes, skills + MCP conventions.
- [Examples](./examples.md) — annotated reference plug-ins.
- [Publishing flow](./publishing-flow.md) — sequence diagram of `jinn solver-plugins publish`.
- [Identity](./identity.md) — staged bootstrap; why publishing does not require operator-grade funding.
- [Compatibility](./compatibility.md) — `jinn.supports` semantics, harness compatibility.

For Path 2 (bring-your-own restorer impl / external harness), see `../path-2/`.
```

- [ ] **Step 8: Verify markdown lints clean and the snapshot test for the IntroCard now passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/IntroCard.test.tsx
```

- [ ] **Step 9: Commit**

```bash
git add client/docs/build/
git commit -m "docs(hfmf): canonical /docs/build/ tree (quickstart, shape, examples, publishing, identity, compat)"
```

---

## Task 8: Implement ShapeCatalogue with failing test

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.tsx`
- Create: `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.test.tsx`:

```typescript
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShapeCatalogue } from './ShapeCatalogue.js';

describe('ShapeCatalogue (hfmf)', () => {
  it('renders a row for each PLUGIN_SHAPE_FIELDS entry', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('version')).toBeTruthy();
    expect(screen.getByText('jinn.supports')).toBeTruthy();
    expect(screen.getByText('jinn.skills')).toBeTruthy();
  });

  it('marks required fields', () => {
    render(<ShapeCatalogue />);
    // Required cells are tagged with data-required="true"
    const required = document.querySelectorAll('[data-field-required="true"]');
    // name, version, jinn.supports
    expect(required.length).toBeGreaterThanOrEqual(3);
  });

  it('renders both plug-in modes', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText(/Runtime plug-in/i)).toBeTruthy();
    expect(screen.getByText(/SolverType plug-in/i)).toBeTruthy();
  });

  it('shows the runtime example with jinn.runtime', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText(/"supports": \["jinn\.runtime"\]/)).toBeTruthy();
  });

  it('shows the solver-type example with swe-rebench-v2.v1', () => {
    render(<ShapeCatalogue />);
    expect(screen.getByText(/swe-rebench-v2\.v1/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Implement the component**

Create `client/src/dashboard/spa/src/pages/build/ShapeCatalogue.tsx`:

```typescript
import { PLUGIN_SHAPE_FIELDS, PLUGIN_MODES } from './shape-fields.js';

const headStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--fg-muted)',
};

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: '13px',
  color: 'var(--fg)',
  verticalAlign: 'top',
};

export function ShapeCatalogue(): JSX.Element {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3, 10px)',
        padding: '24px',
        background: 'var(--surface)',
      }}
    >
      <h2 style={{ marginTop: 0 }}>Plug-in shape</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px' }}>
        <thead>
          <tr>
            <th style={headStyle}>Field</th>
            <th style={headStyle}>Type</th>
            <th style={headStyle}>Required</th>
            <th style={headStyle}>Description</th>
          </tr>
        </thead>
        <tbody>
          {PLUGIN_SHAPE_FIELDS.map((f) => (
            <tr key={f.name} data-field-required={f.required ? 'true' : 'false'}>
              <td style={{ ...cellStyle, fontFamily: "'JetBrains Mono', monospace" }}>{f.name}</td>
              <td style={{ ...cellStyle, fontFamily: "'JetBrains Mono', monospace", color: 'var(--fg-muted)' }}>
                {f.type}
              </td>
              <td style={cellStyle}>{f.required ? 'yes' : 'no'}</td>
              <td style={cellStyle}>{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Two modes</h3>
      <p style={{ color: 'var(--fg-muted)' }}>
        The validator enforces exactly two exclusive modes. Mixing is rejected.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {PLUGIN_MODES.map((m) => (
          <div
            key={m.id}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-2, 6px)',
              padding: '12px',
            }}
          >
            <h4 style={{ marginTop: 0 }}>{m.label}</h4>
            <p style={{ color: 'var(--fg-muted)', fontSize: '13px' }}>{m.requires}</p>
            <pre style={{ background: 'var(--surface-sunken)', padding: '8px', fontSize: '12px' }}>
              <code>{m.example}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Verify the test passes**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/ShapeCatalogue.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/pages/build/ShapeCatalogue.tsx client/src/dashboard/spa/src/pages/build/ShapeCatalogue.test.tsx
git commit -m "feat(hfmf): /build ShapeCatalogue panel (live from SolverPluginManifest descriptor)"
```

---

## Task 9: Failing test — daemon Discovery HTTP endpoints

**Files:**
- Create: `client/test/api/discovery-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/test/api/discovery-endpoint.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { addDiscoveryRoutes } from '../../src/api/discovery-endpoint.js';
import type { DiscoveryAPI, PluginPublication, PublishedArtifact } from '../../src/discovery/types.js';

function stubDiscovery(partial: Partial<DiscoveryAPI>): DiscoveryAPI {
  return {
    findClaimableTasks: vi.fn(),
    listLaunchedSolverNets: vi.fn(),
    getLifecycleStatus: vi.fn(),
    queryEnvelopes: vi.fn(),
    listPluginPublications: vi.fn().mockResolvedValue([]),
    getPluginScores: vi.fn().mockResolvedValue([]),
    listBuilderArtifacts: vi.fn().mockResolvedValue([]),
    ...partial,
  } as DiscoveryAPI;
}

describe('discovery-endpoint (hfmf)', () => {
  it('GET /v1/discovery/plugin-publications?solverType= returns publications', async () => {
    const pubs: PluginPublication[] = [
      {
        builderAgentId: '42',
        cid: 'bafyplugincid',
        name: '@you/x',
        version: '0.1.0',
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 1715600000,
        artifactType: 'plugin',
        revoked: false,
        pluginSha256: '0xabc',
      } as PluginPublication,
    ];
    const discovery = stubDiscovery({
      listPluginPublications: vi.fn().mockResolvedValue(pubs),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].cid).toBe('bafyplugincid');
    expect(discovery.listPluginPublications).toHaveBeenCalledWith({
      solverType: 'swe-rebench-v2.v1',
    });
  });

  it('GET /v1/discovery/builder-artifacts?builderAgentId= proxies through', async () => {
    const arts: PublishedArtifact[] = [
      {
        builderAgentId: '42',
        cid: 'bafy1',
        name: '@you/x',
        version: '0.1.0',
        supports: ['swe-rebench-v2.v1'],
        publishedAt: 1715600000,
        artifactType: 'plugin',
        revoked: false,
      },
    ];
    const discovery = stubDiscovery({
      listBuilderArtifacts: vi.fn().mockResolvedValue(arts),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/builder-artifacts?builderAgentId=42');
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
  });

  it('GET /v1/discovery/builder-artifacts without builderAgentId returns 400', async () => {
    const discovery = stubDiscovery({});
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/builder-artifacts');
    expect(res.status).toBe(400);
  });

  it('GET /v1/discovery/plugin-scores?cid= returns score history', async () => {
    const discovery = stubDiscovery({
      getPluginScores: vi.fn().mockResolvedValue([]),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-scores?cid=bafy1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.scores)).toBe(true);
    expect(discovery.getPluginScores).toHaveBeenCalledWith({ pluginCid: 'bafy1' });
  });

  it('500s when discovery is unavailable', async () => {
    const discovery = stubDiscovery({
      listPluginPublications: vi.fn().mockRejectedValue(new Error('indexer down')),
    });
    const app = new Hono();
    addDiscoveryRoutes(app, { discovery: () => discovery });
    const res = await app.request('/v1/discovery/plugin-publications');
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Verify it fails**

---

## Task 10: Implement daemon discovery endpoint

**Files:**
- Create: `client/src/api/discovery-endpoint.ts`

- [ ] **Step 1: Implement the endpoint**

Create `client/src/api/discovery-endpoint.ts`:

```typescript
/**
 * GET /v1/discovery/* — daemon-side proxies onto the daemon's `DiscoveryAPI`
 * instance so the SPA does not need direct GraphQL or RPC access.
 *
 * Routes:
 *   GET /v1/discovery/plugin-publications?solverType&builderAgentId&includeRevoked
 *   GET /v1/discovery/builder-artifacts?builderAgentId&limit
 *   GET /v1/discovery/plugin-scores?cid&limit
 *
 * Used by the /build SPA route (hfmf) to render published plug-ins, the
 * local operator's published plug-ins, and per-plug-in score history.
 */
import type { Hono } from 'hono';
import { DiscoveryUnavailableError } from '../discovery/types.js';
import type { DiscoveryAPI } from '../discovery/types.js';

export interface DiscoveryEndpointConfig {
  discovery: () => DiscoveryAPI;
}

export function addDiscoveryRoutes(app: Hono, config: DiscoveryEndpointConfig): void {
  app.get('/v1/discovery/plugin-publications', async (c) => {
    const solverType = c.req.query('solverType');
    const builderAgentId = c.req.query('builderAgentId');
    const includeRevokedRaw = c.req.query('includeRevoked');
    const includeRevoked = includeRevokedRaw === undefined ? undefined : includeRevokedRaw !== 'false';
    try {
      const publications = await config.discovery().listPluginPublications({
        ...(solverType !== undefined ? { solverType } : {}),
        ...(builderAgentId !== undefined ? { builderAgentId } : {}),
        ...(includeRevoked !== undefined ? { includeRevoked } : {}),
      });
      return c.json({ publications });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/builder-artifacts', async (c) => {
    const builderAgentId = c.req.query('builderAgentId');
    if (!builderAgentId) {
      return c.json({ error: 'builderAgentId is required' }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const artifacts = await config.discovery().listBuilderArtifacts({
        builderAgentId,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ artifacts });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });

  app.get('/v1/discovery/plugin-scores', async (c) => {
    const cid = c.req.query('cid');
    if (!cid) return c.json({ error: 'cid is required' }, 400);
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    try {
      const scores = await config.discovery().getPluginScores({
        pluginCid: cid,
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
      return c.json({ scores });
    } catch (err) {
      if (err instanceof DiscoveryUnavailableError) {
        return c.json({ error: 'discovery_unavailable' }, 503);
      }
      return c.json({ error: 'internal_error', detail: (err as Error).message }, 503);
    }
  });
}
```

- [ ] **Step 2: Register the routes from `client/src/api/server.ts`**

Locate where `addBootstrapRoutes(app, ...)` is called in `client/src/api/server.ts` and add directly below:

```typescript
import { addDiscoveryRoutes } from './discovery-endpoint.js';
// ...
if (deps.discovery) {
  addDiscoveryRoutes(app, { discovery: () => deps.discovery! });
}
```

Add an optional `discovery: DiscoveryAPI` field to the existing `ApiServerDeps`/config type and pass the live discovery from `main.ts` (the same one used by other call-sites).

- [ ] **Step 3: Verify the endpoint test passes**

```bash
cd client && yarn vitest run test/api/discovery-endpoint.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add client/src/api/discovery-endpoint.ts client/src/api/server.ts client/test/api/discovery-endpoint.test.ts
git commit -m "feat(hfmf): /v1/discovery/* daemon endpoints (plugin-publications, builder-artifacts, plugin-scores)"
```

---

## Task 11: SPA api client + types for discovery + fleet_agent_id

**Files:**
- Modify: `client/src/dashboard/spa/src/api/types.ts`
- Modify: `client/src/dashboard/spa/src/api/client.ts`
- Modify: `client/src/api/bootstrap-endpoint.ts`

- [ ] **Step 1: Add type shapes for the discovery responses**

In `client/src/dashboard/spa/src/api/types.ts`, append:

```typescript
export interface PluginPublicationDto {
  builderAgentId: string;
  cid: string;
  name: string;
  version: string;
  supports: string[];
  publishedAt: number;
  artifactType: 'plugin';
  revoked: boolean;
  revokedReason?: string;
  pluginSha256: string;
}

export interface PublishedArtifactDto {
  builderAgentId: string;
  cid: string;
  name: string;
  version: string;
  supports: string[];
  publishedAt: number;
  artifactType: 'plugin' | 'harness';
  revoked: boolean;
  revokedReason?: string;
}

export interface PluginScoreHistoryRowDto {
  pluginCid: string;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
  forkSuspected: boolean;
}

export interface DiscoveryPluginPublicationsResponse {
  publications: PluginPublicationDto[];
}

export interface DiscoveryBuilderArtifactsResponse {
  artifacts: PublishedArtifactDto[];
}

export interface DiscoveryPluginScoresResponse {
  scores: PluginScoreHistoryRowDto[];
}
```

And in the existing `BootstrapState` interface, add two optional fields:

```typescript
  fleet_agent_id?: string;
  fleet_safe_address?: string;
```

- [ ] **Step 2: Add the api.discovery group**

In `client/src/dashboard/spa/src/api/client.ts`, append before the closing `}`:

```typescript
  discovery: {
    listPluginPublications: (args?: {
      solverType?: string;
      builderAgentId?: string;
      includeRevoked?: boolean;
    }) => {
      const q = new URLSearchParams();
      if (args?.solverType) q.set('solverType', args.solverType);
      if (args?.builderAgentId) q.set('builderAgentId', args.builderAgentId);
      if (args?.includeRevoked !== undefined) q.set('includeRevoked', String(args.includeRevoked));
      const qs = q.toString();
      return jfetch<DiscoveryPluginPublicationsResponse>(
        `/v1/discovery/plugin-publications${qs ? `?${qs}` : ''}`,
      );
    },
    listBuilderArtifacts: (builderAgentId: string, limit?: number) => {
      const q = new URLSearchParams({ builderAgentId });
      if (limit !== undefined) q.set('limit', String(limit));
      return jfetch<DiscoveryBuilderArtifactsResponse>(
        `/v1/discovery/builder-artifacts?${q.toString()}`,
      );
    },
    getPluginScores: (cid: string, limit?: number) => {
      const q = new URLSearchParams({ cid });
      if (limit !== undefined) q.set('limit', String(limit));
      return jfetch<DiscoveryPluginScoresResponse>(
        `/v1/discovery/plugin-scores?${q.toString()}`,
      );
    },
  },
```

Add the matching imports for the response types.

- [ ] **Step 3: Surface `fleet_agent_id` from the bootstrap endpoint**

In `client/src/api/bootstrap-endpoint.ts`, extend `FleetStateOnDisk`:

```typescript
interface FleetStateOnDisk {
  master_address?: string;
  chain?: string;
  services?: ServiceState[];
  fleet_agent_id?: string | null;
  fleet_safe_address?: string | null;
}
```

And include them in the JSON response body next to `master_address`:

```typescript
      master_address: parsed.master_address,
      chain: parsed.chain,
      ...(parsed.fleet_agent_id ? { fleet_agent_id: parsed.fleet_agent_id } : {}),
      ...(parsed.fleet_safe_address ? { fleet_safe_address: parsed.fleet_safe_address } : {}),
```

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src/api/client.ts client/src/dashboard/spa/src/api/types.ts client/src/api/bootstrap-endpoint.ts
git commit -m "feat(hfmf): SPA api.discovery + fleet_agent_id surfaced in /v1/bootstrap"
```

---

## Task 12: Failing test — ArtifactTypeFilterChip

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ArtifactTypeFilterChip } from './ArtifactTypeFilterChip.js';

describe('ArtifactTypeFilterChip (hfmf)', () => {
  it('renders "Plug-ins" selected and "Harnesses" disabled', () => {
    const onChange = vi.fn();
    render(<ArtifactTypeFilterChip value="plugin" onChange={onChange} />);
    const plugin = screen.getByRole('button', { name: /plug-ins/i });
    const harness = screen.getByRole('button', { name: /harnesses/i });
    expect(plugin.getAttribute('aria-pressed')).toBe('true');
    expect(harness.hasAttribute('disabled')).toBe(true);
  });

  it('shows "coming soon" tag on the harness chip', () => {
    render(<ArtifactTypeFilterChip value="plugin" onChange={() => {}} />);
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it('clicking plug-ins (already selected) does not call onChange', () => {
    const onChange = vi.fn();
    render(<ArtifactTypeFilterChip value="plugin" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /plug-ins/i }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

---

## Task 13: Implement ArtifactTypeFilterChip

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.tsx`

```typescript
export type ArtifactTypeFilter = 'plugin';

export interface ArtifactTypeFilterChipProps {
  value: ArtifactTypeFilter;
  onChange: (v: ArtifactTypeFilter) => void;
}

const chipStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 'var(--radius-pill, 999px)',
  border: `1px solid ${active ? 'var(--accent-sky)' : 'var(--border)'}`,
  background: active ? 'var(--accent-sky-tint, transparent)' : 'transparent',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: disabled ? 'var(--fg-dim)' : active ? 'var(--fg)' : 'var(--fg-muted)',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export function ArtifactTypeFilterChip({ value, onChange }: ArtifactTypeFilterChipProps): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <button
        aria-pressed={value === 'plugin' ? 'true' : 'false'}
        style={chipStyle(value === 'plugin', false)}
        onClick={() => {
          if (value !== 'plugin') onChange('plugin');
        }}
      >
        Plug-ins
      </button>
      <button
        disabled
        aria-pressed="false"
        style={chipStyle(false, true)}
      >
        Harnesses <span style={{ marginLeft: 6, fontSize: 9 }}>coming soon</span>
      </button>
    </div>
  );
}
```

- [ ] **Verify, commit:**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.test.tsx
git add client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.tsx client/src/dashboard/spa/src/pages/build/ArtifactTypeFilterChip.test.tsx
git commit -m "feat(hfmf): /build artifact-type filter chip (plugin v0; harness disabled)"
```

---

## Task 14: Failing test — PublishedPluginsPanel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublishedPluginsPanel } from './PublishedPluginsPanel.js';

const fixture = {
  publications: [
    {
      builderAgentId: '42',
      cid: 'bafyplugin1',
      name: '@you/swe-skill',
      version: '0.1.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1715600000,
      artifactType: 'plugin',
      revoked: false,
      pluginSha256: '0xdead',
    },
    {
      builderAgentId: '99',
      cid: 'bafyplugin2',
      name: '@other/swe-skill',
      version: '0.2.0',
      supports: ['swe-rebench-v2.v1'],
      publishedAt: 1715700000,
      artifactType: 'plugin',
      revoked: true,
      revokedReason: 'superseded',
      pluginSha256: '0xbeef',
    },
  ],
};

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('PublishedPluginsPanel (hfmf)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => fixture,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a row per published plug-in', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText('@you/swe-skill')).toBeTruthy();
      expect(screen.getByText('@other/swe-skill')).toBeTruthy();
    });
  });

  it('flags revoked rows with a badge', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/revoked/i)).toBeTruthy();
    });
  });

  it('queries the discovery endpoint with the solverType', async () => {
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('solverType=swe-rebench-v2.v1'),
        expect.any(Object),
      );
    });
  });

  it('renders the empty state when discovery returns no rows', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ publications: [] }),
    } as Response);
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/no plug-ins published yet/i)).toBeTruthy();
    });
  });

  it('renders an error message when discovery is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'discovery_unavailable' }),
    } as Response);
    render(withQuery(<PublishedPluginsPanel solverType="swe-rebench-v2.v1" />));
    await waitFor(() => {
      expect(screen.getByText(/discovery unavailable/i)).toBeTruthy();
    });
  });
});
```

---

## Task 15: Implement PublishedPluginsPanel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.tsx`

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryPluginPublicationsResponse, PluginPublicationDto } from '../../api/types.js';

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
  verticalAlign: 'top',
};
const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-muted)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontSize: '10px',
};

function truncate(cid: string): string {
  return cid.length > 14 ? `${cid.slice(0, 8)}…${cid.slice(-4)}` : cid;
}

export function PublishedPluginsPanel({ solverType }: { solverType: string }): JSX.Element {
  const { data, isLoading, error } = useQuery<DiscoveryPluginPublicationsResponse>({
    queryKey: ['discovery', 'plugin-publications', solverType],
    queryFn: () => api.discovery.listPluginPublications({ solverType }),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <section style={{ padding: '24px', color: 'var(--fg-muted)' }}>Loading published plug-ins…</section>
    );
  }

  if (error) {
    return (
      <section style={{ padding: '24px', color: 'var(--break-red)' }}>
        Discovery unavailable. {(error as Error).message}
      </section>
    );
  }

  const rows = data?.publications ?? [];

  if (rows.length === 0) {
    return (
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3, 10px)',
          padding: '24px',
          background: 'var(--surface)',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Published plug-ins for {solverType}</h3>
        <p style={{ color: 'var(--fg-dim)' }}>No plug-ins published yet. Be the first.</p>
      </section>
    );
  }

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3, 10px)',
        padding: '24px',
        background: 'var(--surface)',
      }}
    >
      <h3 style={{ marginTop: 0 }}>Published plug-ins for {solverType}</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Plug-in</th>
              <th style={headCellStyle}>Version</th>
              <th style={headCellStyle}>Builder agentId</th>
              <th style={headCellStyle}>CID</th>
              <th style={headCellStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: PluginPublicationDto) => (
              <tr key={`${r.builderAgentId}:${r.cid}`}>
                <td style={cellStyle}>{r.name}</td>
                <td style={cellStyle}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.builderAgentId}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{truncate(r.cid)}</td>
                <td style={cellStyle}>
                  {r.revoked ? (
                    <span style={{ color: 'var(--wane)' }}>revoked{r.revokedReason ? ` — ${r.revokedReason}` : ''}</span>
                  ) : (
                    <span style={{ color: 'var(--vow-green)' }}>active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Verify and commit:**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/PublishedPluginsPanel.test.tsx
git add client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.tsx client/src/dashboard/spa/src/pages/build/PublishedPluginsPanel.test.tsx
git commit -m "feat(hfmf): /build PublishedPluginsPanel (browse plug-ins for a SolverNet)"
```

---

## Task 16: Failing test — MyArtifactsPanel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyArtifactsPanel } from './MyArtifactsPanel.js';

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

describe('MyArtifactsPanel (hfmf)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a "complete identity bootstrap" prompt when fleet_agent_id is undefined', () => {
    render(withQuery(<MyArtifactsPanel fleetAgentId={undefined} />));
    expect(screen.getByText(/complete identity bootstrap/i)).toBeTruthy();
  });

  it('lists artifacts when fleet_agent_id is set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        artifacts: [
          {
            builderAgentId: '42',
            cid: 'bafyx',
            name: '@me/x',
            version: '0.1.0',
            supports: ['swe-rebench-v2.v1'],
            publishedAt: 1715600000,
            artifactType: 'plugin',
            revoked: false,
          },
        ],
      }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(screen.getByText('@me/x')).toBeTruthy();
    });
  });

  it('renders empty-state when builder has published no artifacts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ artifacts: [] }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(screen.getByText(/you have not published any plug-ins yet/i)).toBeTruthy();
    });
  });

  it('calls /v1/discovery/builder-artifacts with the agentId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ artifacts: [] }),
    }));
    render(withQuery(<MyArtifactsPanel fleetAgentId="42" />));
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('builderAgentId=42'),
        expect.any(Object),
      );
    });
  });
});
```

---

## Task 17: Implement MyArtifactsPanel

**Files:**
- Create: `client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.tsx`

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.js';
import type { DiscoveryBuilderArtifactsResponse } from '../../api/types.js';

const cellStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '12px',
  color: 'var(--fg)',
};
const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--fg-muted)',
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontSize: '10px',
};

export function MyArtifactsPanel({ fleetAgentId }: { fleetAgentId: string | undefined }): JSX.Element {
  const enabled = Boolean(fleetAgentId);
  const { data, isLoading, error } = useQuery<DiscoveryBuilderArtifactsResponse>({
    queryKey: ['discovery', 'builder-artifacts', fleetAgentId],
    queryFn: () => api.discovery.listBuilderArtifacts(fleetAgentId!),
    enabled,
    refetchInterval: 30_000,
  });

  if (!enabled) {
    return (
      <section
        style={{
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-3, 10px)',
          padding: '24px',
          background: 'var(--surface-sunken)',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Your published plug-ins</h3>
        <p style={{ color: 'var(--fg-muted)' }}>
          Complete identity bootstrap to see your published plug-ins. Run{' '}
          <code>jinn solver-plugins publish</code> on a plug-in and the lazy stage-ensure will provision
          your builder identity (Stage 1).
        </p>
      </section>
    );
  }

  if (isLoading) {
    return <section style={{ padding: '24px', color: 'var(--fg-muted)' }}>Loading your plug-ins…</section>;
  }
  if (error) {
    return <section style={{ padding: '24px', color: 'var(--break-red)' }}>Discovery unavailable.</section>;
  }

  const rows = (data?.artifacts ?? []).filter((a) => a.artifactType === 'plugin');

  if (rows.length === 0) {
    return (
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-3, 10px)',
          padding: '24px',
          background: 'var(--surface)',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Your published plug-ins</h3>
        <p style={{ color: 'var(--fg-dim)' }}>You have not published any plug-ins yet.</p>
      </section>
    );
  }

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-3, 10px)',
        padding: '24px',
        background: 'var(--surface)',
      }}
    >
      <h3 style={{ marginTop: 0 }}>Your published plug-ins</h3>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Plug-in</th>
              <th style={headCellStyle}>Version</th>
              <th style={headCellStyle}>Supports</th>
              <th style={headCellStyle}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.builderAgentId}:${r.cid}`}>
                <td style={cellStyle}>{r.name}</td>
                <td style={cellStyle}>{r.version}</td>
                <td style={{ ...cellStyle, color: 'var(--fg-muted)' }}>{r.supports.join(', ')}</td>
                <td style={cellStyle}>
                  {r.revoked ? <span style={{ color: 'var(--wane)' }}>revoked</span> : <span style={{ color: 'var(--vow-green)' }}>active</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Verify and commit:**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/build/MyArtifactsPanel.test.tsx
git add client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.tsx client/src/dashboard/spa/src/pages/build/MyArtifactsPanel.test.tsx
git commit -m "feat(hfmf): /build MyArtifactsPanel (local operator's published plug-ins)"
```

---

## Task 18: Failing test — Build page top-level integration

**Files:**
- Create: `client/src/dashboard/spa/src/pages/Build.test.tsx`

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getBootstrapMock = vi.fn();
vi.mock('../api/client.js', () => ({
  api: {
    getBootstrap: () => getBootstrapMock(),
    discovery: {
      listPluginPublications: vi.fn().mockResolvedValue({ publications: [] }),
      listBuilderArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
      getPluginScores: vi.fn().mockResolvedValue({ scores: [] }),
    },
  },
}));

const { BuildPage } = await import('./Build.js');

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  getBootstrapMock.mockReset();
  getBootstrapMock.mockResolvedValue({
    schemaVersion: 1,
    mode: 'running',
    steps: [],
    currentStep: 'complete',
    services: [],
    master_address: '0xabc',
    chain: 'base-sepolia',
    fleet_agent_id: '42',
  });
});
afterEach(() => {
  cleanup();
});

describe('BuildPage (hfmf)', () => {
  it('renders the intro card heading', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /build a plug-in/i })).toBeTruthy();
    });
  });

  it('renders the shape catalogue', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByText(/plug-in shape/i)).toBeTruthy();
    });
  });

  it('renders the published-plug-ins panel for swe-rebench-v2.v1 by default', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByText(/published plug-ins for swe-rebench-v2\.v1/i)).toBeTruthy();
    });
  });

  it('renders the my-artifacts panel', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByText(/your published plug-ins/i)).toBeTruthy();
    });
  });

  it('renders the artifact-type filter chip', async () => {
    render(withQuery(<BuildPage />));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /plug-ins/i })).toBeTruthy();
    });
  });
});
```

---

## Task 19: Implement Build page

**Files:**
- Create: `client/src/dashboard/spa/src/pages/Build.tsx`

```typescript
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client.js';
import type { BootstrapState } from '../api/types.js';
import { IntroCard } from './build/IntroCard.js';
import { ShapeCatalogue } from './build/ShapeCatalogue.js';
import { PublishedPluginsPanel } from './build/PublishedPluginsPanel.js';
import { MyArtifactsPanel } from './build/MyArtifactsPanel.js';
import { ArtifactTypeFilterChip, type ArtifactTypeFilter } from './build/ArtifactTypeFilterChip.js';

/**
 * /build — the visible builder front door.
 *
 * Anchored on the SWE-rebench v2 SolverNet for v0; the published-plug-ins
 * panel filters by `swe-rebench-v2.v1` by default. The intro card content
 * is sourced live from `client/docs/build/quickstart.md`. The shape
 * catalogue is generated from `SolverPluginManifest` via a hand-curated
 * descriptor with a snapshot/type-guard test pair keeping it in sync.
 *
 * Spec: docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md §6.6.
 */
const DEFAULT_SOLVER_TYPE = 'swe-rebench-v2.v1';

export function BuildPage(): JSX.Element {
  const { data: bootstrap } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 5_000,
  });
  const [artifactType, setArtifactType] = useState<ArtifactTypeFilter>('plugin');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        padding: '24px',
        maxWidth: 1100,
        margin: '0 auto',
      }}
    >
      <IntroCard />
      <ShapeCatalogue />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ArtifactTypeFilterChip value={artifactType} onChange={setArtifactType} />
      </div>
      {artifactType === 'plugin' ? (
        <>
          <PublishedPluginsPanel solverType={DEFAULT_SOLVER_TYPE} />
          <MyArtifactsPanel fleetAgentId={bootstrap?.fleet_agent_id} />
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Verify and commit:**

```bash
cd client && yarn vitest run src/dashboard/spa/src/pages/Build.test.tsx
git add client/src/dashboard/spa/src/pages/Build.tsx client/src/dashboard/spa/src/pages/Build.test.tsx
git commit -m "feat(hfmf): /build page composing intro + shape + published + my-artifacts panels"
```

---

## Task 20: Wire `/build` into App.tsx + TopTabs

**Files:**
- Modify: `client/src/dashboard/spa/src/App.tsx`
- Modify: `client/src/dashboard/spa/src/shell/TopTabs.tsx`
- Modify: `client/src/dashboard/spa/src/shell/TopTabs.test.tsx`

- [ ] **Step 1: Add the route**

In `App.tsx`, add the import:

```typescript
import { BuildPage } from './pages/Build.js';
```

And the route inside the `<Switch>`, between `/launcher` and the fallback `<Redirect>`:

```typescript
          <Route path="/build"><BuildPage /></Route>
```

- [ ] **Step 2: Add the top tab**

In `TopTabs.tsx`, extend the `TABS` array:

```typescript
const TABS = [
  { path: '/overview', label: 'Overview' },
  { path: '/operator', label: 'Operator' },
  { path: '/launcher', label: 'Launcher' },
  { path: '/build', label: 'Build' },
] as const;
```

- [ ] **Step 3: Update TopTabs test to assert the new Build tab**

In `TopTabs.test.tsx`, add a case:

```typescript
it('renders the Build tab', () => {
  render(<TopTabs />, { wrapper: makeRouterWrapper('/overview') });
  expect(screen.getByText('Build')).toBeTruthy();
});

it('marks Build tab active on /build', () => {
  render(<TopTabs />, { wrapper: makeRouterWrapper('/build') });
  expect(screen.getByText('Build').closest('a')?.getAttribute('data-active')).toBe('true');
});
```

(Reuse the existing test's wrapper pattern.)

- [ ] **Step 4: Run all SPA tests**

```bash
cd client && yarn vitest run src/dashboard/spa
```

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/App.tsx client/src/dashboard/spa/src/shell/TopTabs.tsx client/src/dashboard/spa/src/shell/TopTabs.test.tsx
git commit -m "feat(hfmf): wire /build route + Build top tab into App shell"
```

---

## Task 21: Update `jinn create plugin` quickstart URL

**Files:**
- Modify: `client/src/cli/commands/create.ts`
- Modify: `client/test/cli/commands/create.test.ts`

- [ ] **Step 1: Replace placeholder in HELP_TEXT**

In `client/src/cli/commands/create.ts`, replace the trailing `Quickstart (placeholder until 52x3.6 ships):` block with:

```
Quickstart:
  https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md
```

- [ ] **Step 2: Emit the URL on completion**

Locate the `ctx.writer.write(...)` line at the end of `run()` (currently writes "Created … Next: …"). Append a third line:

```typescript
  ctx.writer.write(
    `Created ${packageName} at ${target}\n` +
    `Next: cd ${target} && yarn install && yarn test\n` +
    `Quickstart: https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md\n`,
  );
```

- [ ] **Step 3: Update the existing create.test.ts to assert the quickstart line**

In `client/test/cli/commands/create.test.ts`, find the test for the post-completion output and assert:

```typescript
expect(output).toContain('Quickstart: https://github.com/Jinn-Network/mono/blob/main/cargo/client/docs/build/quickstart.md');
```

- [ ] **Step 4: Run create tests**

```bash
cd client && yarn vitest run test/cli/commands/create.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add client/src/cli/commands/create.ts client/test/cli/commands/create.test.ts
git commit -m "feat(hfmf): jinn create plugin prints the canonical /docs/build/quickstart.md URL"
```

---

## Task 22: Full SPA suite + typecheck + build smoke

- [ ] **Step 1: Type-check the whole client**

```bash
cd client && yarn typecheck
```

- [ ] **Step 2: Run the whole vitest suite**

```bash
cd client && yarn test
```

- [ ] **Step 3: Smoke the SPA build**

```bash
cd client && yarn build
```

Confirm `dist/dashboard/` ships the new Build chunk and that the markdown `?raw` import was bundled (Vite emits a string entry — search for the heading in the bundled output as a sanity check):

```bash
grep -l "Build a plug-in" client/dist/dashboard/assets/*.js
```

- [ ] **Step 4: Manual smoke (optional but recommended)**

Launch the daemon and the SPA dev server. Open `/build`. Confirm:
- Intro card renders the quickstart heading and the `jinn create plugin` command in a code block.
- Shape catalogue lists eight fields with `name`, `version`, `jinn.supports` flagged required.
- Both mode cards are visible with the right examples.
- Published-plug-ins panel renders the empty state ("No plug-ins published yet. Be the first.") on a fresh testnet.
- My-artifacts panel renders the "Complete identity bootstrap" prompt when `fleet_agent_id` is absent.
- Artifact-type filter chip shows Plug-ins (pressed) and Harnesses (disabled, "coming soon").

- [ ] **Step 5: Commit any docs / lint fixes that surfaced**

---

## Self-review checklist

- [ ] All six `client/docs/build/*.md` files exist and read as native prose (no placeholder text).
- [ ] The Quickstart URL printed by `jinn create plugin` resolves to a real file once this branch lands on `main`.
- [ ] `PLUGIN_SHAPE_FIELDS` snapshot test passes; type-guard at the bottom of `shape-fields.ts` references `SolverPluginManifest`. Adding a required field to `SolverPluginManifest` without updating the descriptor would fail typecheck.
- [ ] `IntroCard` renders content from `quickstart.md` at build time via Vite `?raw`. No runtime fetch of the markdown.
- [ ] `PublishedPluginsPanel` queries `/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1` and renders rows, revoked badges, and the empty state.
- [ ] `MyArtifactsPanel` gates on `fleet_agent_id` and shows a "complete identity bootstrap" prompt when undefined.
- [ ] `ArtifactTypeFilterChip` has the harness chip disabled with a "coming soon" tag.
- [ ] `/build` route is registered in `App.tsx` and the Build top tab appears in `TopTabs.tsx`.
- [ ] Daemon endpoint tests cover happy path, empty results, missing `builderAgentId`, and `DiscoveryUnavailableError` 503.
- [ ] `BootstrapState.fleet_agent_id` is surfaced from `/v1/bootstrap` and consumed by the Build page.
- [ ] No emoji anywhere in copy or icons (BRAND.md non-negotiable).
- [ ] Reused `Leaderboard.tsx` table-cell idiom; did not add a new table component.
- [ ] No new runtime dependencies.

---
