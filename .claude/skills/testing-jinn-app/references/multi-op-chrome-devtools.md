# Multi-op chrome-devtools driving

For manual smoke tests where you drive two operator apps side by side. Uses the `chrome-devtools` MCP server's multi-page support.

## Prereqs

- Both daemons spawned (see [multi-op-spawn.md](multi-op-spawn.md)). Capture both handshake URLs.
- `chrome-devtools` MCP loaded in your session. Verify with `ToolSearch query="chrome devtools navigate"` — if `mcp__chrome-devtools__new_page` and `mcp__chrome-devtools__select_page` don't surface, this MCP isn't loaded and the recipe below won't work; fall back to manual two-browser-window driving.

## Recipe

```typescript
// 1. Open a page per operator
const opAPage = await mcp__chrome_devtools__new_page({ url: opAHandshakeUrl });
const opBPage = await mcp__chrome_devtools__new_page({ url: opBHandshakeUrl });

// 2. Drive op-a — explicitly select before each action
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__click({ selector: 'button:has-text("Create SolverNet")' });
// ... wizard steps ...

// 3. Drive op-b — explicitly select again
await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__navigate_page({ url: opBHandshakeUrl + '/operator/join' });
await mcp__chrome_devtools__take_screenshot({});

// 4. Cross-verify: switch back to op-a and check op-a sees op-b's action
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__navigate_page({ url: opAHandshakeUrl + '/launcher/launched/<id>' });
```

## Critical rule: always select before acting

chrome-devtools MCP maintains an "active page" pointer. Every click / type / navigate operates on the currently-selected page. If you fan out across two pages without explicit `select_page` calls, you'll drive whichever happened to be selected last — often the wrong one.

**Pattern:**
```typescript
async function driveOnPage(pageId: string, action: () => Promise<void>): Promise<void> {
  await mcp__chrome_devtools__select_page({ pageId });
  await action();
}
```

Wrap every cross-page operation in this pattern.

## Cross-op visibility lag

When op-a performs an action that op-b should see (e.g. op-a launches a SolverNet, op-b should see it in the catalog), there's a delay equal to:

- One indexer poll interval (~5 sec for the Ponder indexer at default config)
- Plus one SPA poll interval (~1.5 sec for useQuery defaults)

**Don't assert op-b's view immediately after op-a's action.** Wait at least 10 seconds for indexer + SPA polls. Use `wait_for` with the expected DOM state, not a fixed sleep:

```typescript
await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__wait_for({
  text: 'my-new-solvernet',
  timeout: 30000,                  // generous; indexer can lag
});
```

## Screenshot conventions

When reporting a multi-op smoke result, take screenshots of both pages at each critical state, named consistently:

```typescript
await mcp__chrome_devtools__select_page({ pageId: opAPage });
await mcp__chrome_devtools__take_screenshot({ name: '01-op-a-after-create' });

await mcp__chrome_devtools__select_page({ pageId: opBPage });
await mcp__chrome_devtools__take_screenshot({ name: '02-op-b-catalog-shows-new' });
```

Screenshot pairs at each step make cross-op state comparison readable.

## Common failure modes

| Failure | Likely cause | Fix |
|---|---|---|
| Action happens on wrong page | forgot to `select_page` before action | wrap in `driveOnPage` helper |
| op-b doesn't see op-a's change | not waiting for indexer/SPA poll | use `wait_for` with expected text, not sleep |
| Stale screenshot | took screenshot before page actually updated | wait for the indicator DOM change first |
| MCP not loaded | session doesn't have chrome-devtools MCP | check `ToolSearch query="chrome devtools navigate"`; fall back to Playwright recipe |
