# Operator local app — OSS reuse audit

**Status:** complete (audit; informs Tasks 10, 16, 17)
**Author:** ritsukai (with Claude Opus 4.7)
**Date:** 2026-05-01
**Bead:** jinn-mono-3ois
**Related:**
- `docs/superpowers/specs/2026-05-01-operator-local-app-design.md` (spec)
- `docs/superpowers/plans/2026-05-01-operator-local-app.md` (plan)

## Purpose

Decide which existing open-source projects we should lift, reference, or skip when building the operator-facing local web app (v1-Slim). The plan defaulted to `Vite + React + Tailwind + shadcn/ui + xterm.js`. This audit either confirms or flips that default, and names the chosen building block per surface.

## Constraints recap

- Localhost-only web app (no Electron / Tauri).
- Served by the existing Hono daemon at `http://127.0.0.1:7331`.
- Embeds a `claude --enable-auto-mode` subprocess piped to the browser.
- Two distinct Claude Code surfaces in-daemon: the existing per-restoration runner (untouched) and the new operator-facing session.
- Auto Mode is the safety floor; we are not adding our own permission-confirmation modal layer.
- Single-binary distribution. No external services.

## "Lift / reference / skip" — what the words mean

- **Lift.** Take a direct dependency. Use the project's API, ship its components, follow its update cadence.
- **Reference.** Don't depend on it; read its source for patterns, reuse small snippets under its license, but write our own surface.
- **Skip.** Wrong scope, abandoned, license-incompatible, or solves a problem we don't have. Build minimal locally if we still need the capability.

---

## 1. Web UIs around `claude` / Claude Code sessions

The category we most expected to find a "lift" candidate in. Several real projects exist; most are out of scope for our use case in subtle ways.

### 1.1 `getAsterisk/claudia` (recently rebranded `winfunc/opcode`)

- **Link:** https://github.com/getAsterisk/claudia
- **License:** AGPL-3.0
- **Stars / activity:** 21.7k stars; active development on `main` (200+ commits).
- **What it solves:** Full GUI for managing Claude Code sessions: session browser, custom agent definitions (system prompts, sandboxed exec), usage analytics, MCP server management, per-project history.
- **What it doesn't:** **Tauri-based desktop app.** Frontend is React 18 + TypeScript, but the backend is Rust running in-process via Tauri. The web frontend is not a freestanding browser app — it talks to Rust over Tauri's IPC, not HTTP/WebSocket. Lifting the React shell would require replacing every Tauri IPC call with HTTP/WS calls into our Hono daemon, which is most of the work.
- **License posture:** AGPL-3.0 is workable for our case (we're already open-source, the daemon already serves the SPA), but copy-pasting components into our MIT-licensed monorepo would relicense the file. We'd need clear file-level boundaries.
- **Recommendation:** **Reference.** Read their session-list, agent-detail, and analytics screens for layout ideas. Don't take the dependency. The Tauri coupling and AGPL together make a clean lift impractical.

### 1.2 `siteboon/claudecodeui` (a.k.a. CloudCLI)

- **Link:** https://github.com/siteboon/claudecodeui
- **License:** AGPL-3.0-or-later
- **Stars / activity:** 10.4k stars; v1.31.5 released 2026-04-30 (very active).
- **What it solves:** Genuinely the closest match to our v1-Slim. Web UI (React + Vite + Tailwind, CodeMirror) that wraps Claude Code (and Cursor CLI / Codex) via a local Node.js server. Reads from / writes to `~/.claude` config natively, exposes file explorer + git + MCP management + shell terminal + chat. `npx @cloudcli-ai/cloudcli` and you have a localhost web UI for your existing Claude Code sessions.
- **What it doesn't:** It's a **general** Claude Code UI — projects, sessions, files, git. We need an **operator** UI: status, bootstrap journey, intent visibility, with a docked Claude Code panel as one of several regions. Their app *is* the Claude Code session; ours embeds a Claude Code session inside an operator console. Importing their UI wholesale would invert our information architecture.
- **License posture:** AGPL — same considerations as `claudia`. We could in principle run it as a sibling app and link to it from the operator console, but that's two apps, not one.
- **Recommendation:** **Reference, heavily.** Their xterm.js-over-WebSocket bridge to Claude Code is exactly the pattern we need; their MCP management screen is a useful template; their session-list UX is mature. Read their server-side TTY bridge code in particular. Don't take the runtime dependency.

### 1.3 `vultuk/claude-code-web`

- **Link:** https://github.com/vultuk/claude-code-web
- **License:** MIT (clean for us).
- **Stars / activity:** ~70 stars; v3.4.0 released 2025-10-23. Smaller, less polished.
- **What it solves:** Vanilla-JS Express + WebSocket server that spawns Claude Code via `node-pty` and streams the PTY to xterm.js. Multi-session, multi-browser. The architecture we'd build if we built minimal.
- **What it doesn't:** No framework (vanilla JS, not React), no chat UI — just terminal-in-browser. Single-purpose. UI is utilitarian.
- **Recommendation:** **Reference (server side).** Their Express + node-pty + WebSocket plumbing is a 200-line file we can read in an afternoon and crib the structure. It confirms the Hono + node-pty + WebSocket path is well-trodden.

### 1.4 `sugyan/claude-code-webui`

- **Link:** https://github.com/sugyan/claude-code-webui
- **License:** MIT.
- **Stars / activity:** 1.1k stars; v0.1.56 released 2025-09-18. Not abandoned but less active than CloudCLI.
- **What it solves:** Frontend (Vite) + backend (Deno or Node) that wraps the Claude CLI. Streams responses; web UI for new conversations.
- **What it doesn't:** Documentation is thin; technical implementation (TTY vs JSON streaming) is not clearly disclosed in the README. Smaller scope than CloudCLI.
- **Recommendation:** **Skip.** CloudCLI covers the same ground with more momentum and clearer architecture.

### 1.5 `d-kimuson/claude-code-viewer`

- **Link:** https://github.com/d-kimuson/claude-code-viewer
- **License:** MIT.
- **Stars / activity:** 1.2k stars; v0.7.3 released 2026-04-05 (active).
- **What it solves:** Web client for managing Claude Code projects — start/resume sessions, monitor running tasks, browse history. TypeScript-heavy. Has a "bottom panel terminal over WebSocket."
- **What it doesn't:** Closer to a session viewer than an embedded operator co-pilot. Same IA-inversion issue as CloudCLI.
- **Recommendation:** **Reference** for session browsing and history UI patterns. Skip as a runtime dependency.

### 1.6 `anthropic-ai/claude-code-vscode` and a "web counterpart"

- Searched. The official VS Code extension exists. **No official web counterpart from Anthropic.** Anthropic does offer a hosted Claude Code experience at `code.claude.com`, but that's a managed product, not a wrappable open-source project.
- **Recommendation:** **Skip.** No artifact to lift.

### 1.7 `wcrichton/claude-code-web`

- Searched (Will Crichton's GitHub and the literal name). **Not found** as a real public repo. The name surfaces in search results as a confused reference to `vultuk/claude-code-web`.
- **Recommendation:** **Skip** (does not exist as searched).

### 1.8 npm tag survey: `claude-code` + `web`

- Searched the npm registry tags and GitHub topics for `claude-code-web`, `claude-code-ui`, `claude-cli-web`. Beyond the four projects above, the long tail is forks, abandoned scripts, and Cursor / Codex variants that don't apply.

### Category 1 verdict

There is no existing project we can lift wholesale that gives us "operator console with embedded Claude Code session." The closest match (CloudCLI) is an inverse-IA app under AGPL. We'll **build the embedding ourselves**, but we'll **reference CloudCLI's TTY-over-WebSocket bridge** and `vultuk/claude-code-web`'s server plumbing as the reference implementations. This validates the planned stack rather than replacing it.

---

## 2. Agent chat component libraries

The category where we *most* hope to avoid hand-rolling tool-call cards.

### 2.1 `@assistant-ui/react` (`assistant-ui/assistant-ui`)

- **Link:** https://github.com/assistant-ui/assistant-ui · https://www.assistant-ui.com
- **License:** MIT.
- **Stars / activity:** 9.9k stars; very active development (3,000+ commits on `main`).
- **What it solves:** Headless / Radix-style primitives for a ChatGPT-quality chat surface in React. Streaming, message parts, tool-call rendering as components, human approvals inline. Composes with arbitrary backends — explicitly supports an `ExternalStoreRuntime` where *you* own the message store and the adapter just translates to/from `ThreadMessageLike`.
- **MCP tool calls?** Renders tool calls as components via `makeAssistantToolUI` regardless of where the tool is defined (backend, MCP server, LangGraph). The library treats tool calls as message parts; you write a component per tool name (or a generic fallback) and it handles streaming + final state.
- **Custom backend (not OpenAI direct)?** Yes. `ExternalStoreRuntime` does not require AI SDK. Documentation confirms "any async source that yields chunks" works.
- **Stdio-piped Claude Code subprocess via WebSocket?** Yes, this is exactly what `ExternalStoreRuntime` is designed for. Our daemon parses Claude Code's `stream-json` output, ships message-part deltas over WebSocket, our store accumulates them, the runtime renders them.
- **What it doesn't:** It's a chat surface, not a terminal. We'd still need xterm.js for the raw-TTY toggle (if we keep one). It has its own opinions about message shape (`ThreadMessageLike`) that we'd have to map Claude Code's stream-json into.
- **Recommendation:** **Lift.** This is the right level of abstraction for the agent panel. It saves us the hand-roll of message bubbles, tool-call cards, streaming UI, and human-approval affordances, while giving us full control over the backend transport. The `ExternalStoreRuntime` + `makeAssistantToolUI` combination matches our architecture cleanly.

### 2.2 Vercel AI SDK chat components (`ai/react` + `ai-elements`)

- **Link:** https://github.com/vercel/ai-elements · https://elements.ai-sdk.dev
- **License:** MIT.
- **Stars / activity:** 2k stars; v1.9.0 released 2026-03-12. Backed by Vercel.
- **What it solves:** Copy-paste shadcn-style component library for AI chat. 50+ components across 8 families — message, conversation, prompt-input, reasoning, tool-use, agent, artifact, sandbox. Designed for streaming, status states, type safety. Integrates tightly with Vercel AI SDK's message-parts model.
- **MCP tool calls?** Yes — there's a dedicated `tool-use` family. AI SDK 5+ surfaces dynamic tools (e.g., from MCP servers) as a `dynamic-tool` part, and AI Elements has matching renderers.
- **Custom backend (not OpenAI direct)?** Technically yes (AI SDK supports custom providers), but **the components assume the AI SDK message-part shape**. If we don't run the AI SDK on our backend, we have to reshape our Claude Code stream-json into AI SDK message parts to use these components. That's adapter work.
- **Stdio-piped Claude Code subprocess via WebSocket?** No first-class support. AI SDK's `useChat` is HTTP/SSE-oriented. Adapting to WebSocket-from-PTY is doable but cuts against the grain of the SDK.
- **What it doesn't:** Tight coupling to Vercel's AI SDK and Next.js. Marketing prerequisite is "Next.js project with AI SDK installed." Standalone use against a non-AI-SDK backend is friction.
- **Recommendation:** **Reference.** Read `tool-use`, `reasoning`, and `artifact` component sources for visual patterns, but don't take the dependency. Their assumed message shape is the wrong shape for us.

### 2.3 CopilotKit

- **Link:** https://github.com/CopilotKit/CopilotKit
- **License:** MIT.
- **Stars / activity:** 30.5k stars; v1.56.5 released 2026-04-30 (very active).
- **What it solves:** React frontend SDK for "agent-native applications" — chat, copilot side-panel, generative UI, MCP client, multi-agent orchestration. Built on **AG-UI**, an event-based protocol they champion (adopted by Google, LangChain, AWS, Microsoft per their README).
- **MCP tool calls?** Yes, native support — CopilotKit can act as an MCP client, registering tools and rendering their calls.
- **Custom backend?** Designed to talk to LangGraph / CrewAI / their own runtime over AG-UI. "Custom backend" means "implement AG-UI on your backend." Our backend is "spawn `claude --enable-auto-mode` and stream its JSON." The protocol gap is non-trivial.
- **Stdio-piped Claude Code subprocess via WebSocket?** Not without writing an AG-UI shim around Claude Code. That's a project of its own.
- **What it doesn't:** Heavyweight for our use case. Wants to own the agent runtime, not just render messages. Our agent runtime is `claude --enable-auto-mode`, full stop — we don't want a parallel orchestration layer.
- **Recommendation:** **Skip.** Wrong abstraction layer for v1-Slim. Revisit if we ever build a multi-agent operator surface where AG-UI's standardisation actually helps.

### 2.4 `shadcn.io/ai` (third-party shadcn registry)

- **Link:** https://www.shadcn.io/ai
- **License:** Not clearly disclosed (treat as unknown).
- **What it solves:** 50+ AI chat components (8 families) installable via `shadcn` CLI from a third-party registry. Heavy overlap with Vercel's AI Elements; brands itself as the same product space.
- **What it doesn't:** Unclear licensing, third-party registry, similar AI-SDK assumptions.
- **Recommendation:** **Skip.** Use AI Elements as the visual reference if we need component patterns; don't pull from this registry.

### Category 2 verdict

`@assistant-ui/react` is the win. It's the only library that takes the "you own the backend, we own the surface" stance cleanly, supports MCP-style tool rendering as components, and works with WebSocket-fed message streams without a protocol adapter. We lift it, write a thin adapter that consumes `claude --output-format=stream-json` and emits `ThreadMessageLike` deltas, and skip the rest.

---

## 3. Terminal-in-browser

Only relevant if we expose a raw-TTY view of the Claude Code subprocess (we will, as a power-user toggle, even if the default surface is the assistant-ui chat).

### 3.1 `xterm.js`

- **Link:** https://github.com/xtermjs/xterm.js
- **License:** MIT.
- **Stars / activity:** 20.4k stars; v6.0.0 released 2025-12-22; monthly release cadence; actively maintained by VS Code / Hyper / Theia teams.
- **What it solves:** The de facto terminal emulator for the web. ANSI, Unicode 11/grapheme clustering, ligatures, WebGL2 rendering, image addon, search, link detection, fit-to-container.
- **Addons we'd actually use:** `@xterm/addon-fit` (resize), `@xterm/addon-webgl` (perf on long sessions), `@xterm/addon-web-links` (clickable URLs), `@xterm/addon-attach` (WebSocket binding — saves us the byte-glue layer), `@xterm/addon-serialize` (capture session state for debugging).
- **Weight:** ~100kb gzipped for core + fit + webgl. Acceptable for a localhost app.
- **Recommendation:** **Lift.** Default. There is no real alternative.

### 3.2 `node-pty`

- **Link:** https://github.com/microsoft/node-pty
- **License:** MIT.
- **Stars / activity:** 1.9k stars; v1.1.0 released 2025-12-22; maintained by Microsoft (the VS Code team).
- **What it solves:** Native `forkpty` bindings for Node. Cross-platform (Linux, macOS, Windows via conpty). The standard backend for an xterm.js bridge.
- **Constraint:** Native module → must be compiled per platform. Adds a build step. Single-binary distribution gets harder if we ship platform-specific prebuilt artifacts.
- **Recommendation:** **Lift.** We need a real PTY (not just stdio piping) to keep Claude Code's TTY behaviour intact. Plan for prebuilt binaries via `prebuildify` or the like.

### 3.3 `wetty`

- **Link:** https://github.com/butlerx/wetty
- **License:** MIT.
- **Stars / activity:** 5.3k stars; last release v2.7.0 on 2023-09-16 (slowing).
- **What it solves:** Drop-in Node.js server that exposes a local shell or SSH session as a web terminal (xterm.js + WebSocket).
- **What it doesn't:** Spawns a shell, not arbitrary processes; configured for SSH and login flows, not long-lived child-process sessions piped to a daemon. We'd be fighting it to attach to our own `claude` subprocess managed by our daemon.
- **Recommendation:** **Skip.** Wrong shape. Too much accidental complexity for our use case.

### 3.4 `ttyd`

- **Link:** https://github.com/tsl0922/ttyd
- **License:** MIT.
- **Stars / activity:** 11.5k stars; last release v1.7.7 on 2024-03-30 (slowing but stable).
- **What it solves:** Same idea as wetty but written in C. Lightweight, single binary, ships an xterm.js frontend.
- **What it doesn't:** Same wrong-shape problem. Also adds a non-Node, non-TS build artifact to a TS-only daemon — operationally awkward.
- **Recommendation:** **Skip.** Same reason as wetty.

### Category 3 verdict

`xterm.js` + `node-pty` + a thin Hono WebSocket route. This is the standard pattern; `vultuk/claude-code-web` and `siteboon/claudecodeui` both confirm it. Skip the bundled wrappers; we have specific subprocess-management needs that the wrappers fight.

---

## 4. SPA + dashboard primitives

Default assumed: Vite + React + Tailwind + shadcn/ui. The question is whether anything compelling exists *above* that for "operator console" use cases.

### 4.1 `shadcn/ui` (baseline)

- **Link:** https://ui.shadcn.com
- **License:** MIT.
- **Activity:** Very active, a moving target — but stable in the parts we'd use (Card, Tabs, Dialog, Sheet, Toast, Form, Table). Copy-paste model means we own the source after install.
- **Recommendation:** **Lift.** This is the baseline. Confirms the plan.

### 4.2 Tremor (`tremorlabs/tremor`)

- **Link:** https://github.com/tremorlabs/tremor · https://tremor.so
- **License:** Apache-2.0.
- **Stars / activity:** 3.4k stars on the main repo; active; built on Tailwind + Radix (compatible with shadcn).
- **What it solves:** 35+ accessible React components purpose-built for analytics dashboards: KPI cards, line/bar/area/donut/sparkline charts, data tables, filter controls. Copy-paste like shadcn.
- **What it doesn't:** Operator console v1-Slim is **not** an analytics dashboard. We want status cards + an event timeline + a setup checklist + a chat/terminal panel. Charts are not the load-bearing surface. We may want one or two sparklines (e.g., recent intent-completion rate) but Tailwind + Recharts (or shadcn/ui's chart wrapper, which uses Recharts) covers that.
- **Recommendation:** **Reference, optional lift later.** If we add a Phase 2 "operator analytics" surface, revisit. For v1-Slim, the chart surface is too small to justify a separate library.

### 4.3 Grafana plugins

- **Link:** https://grafana.com/grafana/plugins
- **What it solves:** Embedding our daemon's metrics inside a Grafana instance via a custom data-source or panel plugin.
- **What it doesn't:** Requires the operator to run Grafana. Our v1 ships a single binary, no external services. Out of scope by the very first constraint.
- **Recommendation:** **Skip.**

### 4.4 React admin templates (Refine, RSuite Admin, Coreui, etc.)

- Reviewed several. They're enterprise CRUD scaffolds — auth, table, form, role management. Wrong shape for an operator daemon console. Heavy chrome we'd spend a week tearing out.
- **Recommendation:** **Skip.**

### Category 4 verdict

The default stack — **Vite + React + Tailwind + shadcn/ui** — is right. Recharts (via shadcn's chart wrapper) for the rare sparkline. Tremor revisitable if a Phase 2 analytics surface emerges. No compelling "above shadcn" framework for our use case.

---

## 5. MCP tool-call visualization

Goal: avoid hand-rolling tool-call cards.

### 5.1 `assistant-ui` tool-call rendering (overlap with §2.1)

- **Mechanism:** `makeAssistantToolUI({ toolName, render })` creates a renderer keyed on tool name. Tool calls arrive as message parts with input (streaming partial JSON), output, status. The renderer gets all three plus an `addResult` for human-in-the-loop tools.
- **Recommendation:** **Lift.** This is the same recommendation as §2.1; the tool-call rendering primitives are the most valuable part of assistant-ui for our use case.

### 5.2 Official `modelcontextprotocol/inspector`

- **Link:** https://github.com/modelcontextprotocol/inspector
- **License:** MIT.
- **Stars / activity:** 9.6k stars; v0.21.2-hotfix-3 released 2026-04-14 (very active).
- **What it solves:** Standalone testing/debugging tool for MCP servers. React UI + Node.js proxy. Form-based parameter input; real-time response visualisation; request history.
- **What it doesn't:** Designed to be **run** (`npx @modelcontextprotocol/inspector`), not embedded. The React UI is an app, not a component library — the components aren't published as a reusable surface.
- **Recommendation:** **Reference.** Useful as a development tool while we build `/mcp/operator`. Read its tool-call view for layout cues. Don't try to embed its React UI inside our SPA.

### 5.3 `modelcontextprotocol/use-mcp`

- **Link:** https://github.com/modelcontextprotocol/use-mcp
- **License:** MIT.
- **Stars / activity:** 1k stars; archived 2026-02-06 (no longer maintained — verify before use).
- **What it solves:** A React hook that handles MCP server connection, auth, and `callTool()` plumbing. Transport, not visualisation.
- **What it doesn't:** Not a component library. Recently archived. Connection/auth is a non-issue for us — both Claude Code (MCP client) and `/mcp/operator` (MCP server) live in the same daemon process; the operator panel doesn't need a browser-side MCP client at all.
- **Recommendation:** **Skip.**

### 5.4 `react-mcp-*` projects

- Searched. Most are MCP-from-React experiments (`copilotkit-mcp-demo`, hobby React+MCP scaffolds). None publishes a reusable component library for tool-call visualisation that improves on assistant-ui's primitives.
- **Recommendation:** **Skip.**

### Category 5 verdict

`assistant-ui` covers tool-call rendering. The MCP Inspector is a useful side-tool while we develop, not a component to embed. Use-mcp is archived and addresses a different layer than we need. No additional dependency required for tool-call visualisation beyond §2.1's recommendation.

---

## Conclusions — final stack per surface

| Surface                              | Decision                                                                                          |
|--------------------------------------|---------------------------------------------------------------------------------------------------|
| **SPA framework**                    | Vite + React + TypeScript                                                                          |
| **CSS / component primitives**       | Tailwind + shadcn/ui (copy-paste components owned in-repo)                                         |
| **Charts (when needed)**             | shadcn/ui's chart wrapper (Recharts under the hood). Tremor only if Phase 2 analytics surface lands. |
| **Agent panel (chat + tool calls)**  | `@assistant-ui/react` with `ExternalStoreRuntime`, fed by our daemon over WebSocket               |
| **Tool-call rendering**              | `makeAssistantToolUI` per known operator-MCP tool, plus a generic JSON-tool fallback              |
| **Raw-TTY toggle (power user)**      | `xterm.js` + `@xterm/addon-fit` + `@xterm/addon-webgl` + `@xterm/addon-attach` (or our own WS glue) |
| **PTY backend in the daemon**        | `microsoft/node-pty`, prebuilt binaries per platform                                              |
| **Stream-json parsing**              | Build minimal in `client/src/operator-app/server/`. Reference `claude-code-parser` patterns.       |
| **MCP server (`/mcp/operator`)**     | Existing MCP TypeScript SDK already in the monorepo. No new deps.                                  |
| **MCP debugging during development** | `npx @modelcontextprotocol/inspector` against `/mcp/operator`. Not bundled.                        |

### Confirmation vs. flip

This audit **confirms** the default stack in `docs/superpowers/plans/2026-05-01-operator-local-app.md` — Vite + React + Tailwind + shadcn/ui + xterm.js — and **adds two specific lifts** the plan didn't mandate:

1. **`@assistant-ui/react`** as the agent-panel surface, in place of a hand-rolled chat UI.
2. **`microsoft/node-pty`** explicitly named as the PTY backend (the plan implies it but doesn't pin it).

The plan should be updated to reflect both, especially because `assistant-ui` carries an `ExternalStoreRuntime` design assumption that shapes the WebSocket message format we'll define (Tasks 10/16/17).

### Reference projects worth revisiting during build

- **`siteboon/claudecodeui`** — the closest analogous project. Read their TTY-over-WebSocket bridge and MCP management screen before building ours.
- **`vultuk/claude-code-web`** — minimal, MIT, vanilla JS. The 200-line server is the simplest reference implementation of node-pty + WebSocket + xterm.js we found.
- **`getAsterisk/claudia` / `winfunc/opcode`** — read the session-detail and analytics screens for visual ideas only; don't take the Tauri dependency.
- **`vercel/ai-elements`** — read the `tool-use`, `reasoning`, and `artifact` component sources for visual patterns when building our `makeAssistantToolUI` renderers.
- **`modelcontextprotocol/inspector`** — keep open in another tab while developing `/mcp/operator`.

### Things we explicitly chose **not** to take

- **Vercel AI SDK / AI Elements as a runtime dep.** Wrong message-part shape for our backend; tight Next.js / AI-SDK assumptions.
- **CopilotKit.** Wants to own the agent runtime; we already have one (`claude --enable-auto-mode`).
- **wetty / ttyd.** Wrong shape — both want to own the shell session, not attach to our subprocess.
- **Grafana / Tremor / admin templates.** Operator console is not an analytics dashboard or a CRUD admin.
- **AGPL projects (`claudia`, `claudecodeui`) as runtime deps.** License posture incompatible with our MIT monorepo without firewalled subdirectories — not worth the complication for v1-Slim.

## Open questions / follow-ups

- **node-pty prebuilt distribution.** Single-binary `jinn run` distribution is harder once we add a native module. We need a build-and-package plan (likely `prebuildify` + per-arch artifacts) before Task 10 finalises the WS bridge. Not a blocker for the audit, but a real packaging cost we should book.
- **assistant-ui ↔ stream-json adapter shape.** The mapping from Claude Code's `stream-json` events to `ThreadMessageLike` parts is a small but load-bearing piece. Recommend prototyping it against a recorded Claude Code session before committing to message shapes in Task 10.
- **AGPL boundary.** If we later decide to lift any AGPL component (e.g., a specific screen from `claudecodeui`), we need a clear sub-package boundary. Note for future review.

## Sources

- https://github.com/getAsterisk/claudia
- https://github.com/sugyan/claude-code-webui
- https://github.com/vultuk/claude-code-web
- https://github.com/siteboon/claudecodeui
- https://github.com/d-kimuson/claude-code-viewer
- https://github.com/assistant-ui/assistant-ui
- https://www.assistant-ui.com/docs/runtimes/custom/external-store
- https://github.com/vercel/ai-elements
- https://elements.ai-sdk.dev
- https://github.com/CopilotKit/CopilotKit
- https://github.com/xtermjs/xterm.js
- https://github.com/microsoft/node-pty
- https://github.com/butlerx/wetty
- https://github.com/tsl0922/ttyd
- https://github.com/tremorlabs/tremor
- https://github.com/modelcontextprotocol/inspector
- https://github.com/modelcontextprotocol/use-mcp
- https://code.claude.com/docs/en/headless
