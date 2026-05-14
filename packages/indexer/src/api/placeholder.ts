/**
 * Placeholder HTML for the Jinn network explorer at `/`.
 *
 * Served inline via c.html() — no static-file infra, no new deps.
 * The real SPA (ebu7.4) will replace this; the route wiring stays identical.
 *
 * Design tokens from DESIGN.md (Protocol Brutalism idiom):
 *   bg #0c1628, fg #f2f7fc, accent-sky #7aa7dc, border #1f3a66
 *   JetBrains Mono for body, Instrument Serif for the heading
 *   No gradients, no emoji, no external resources, no web fonts
 */
export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Jinn network explorer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:          #0c1628;
      --bg-elevated: #142340;
      --fg:          #f2f7fc;
      --fg-muted:    #a4b0c2;
      --border:      #1f3a66;
      --accent:      #7aa7dc;
      --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
      --serif: 'Instrument Serif', 'Times New Roman', serif;
    }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.7;
      letter-spacing: -0.01em;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 48px 32px 32px;
      max-width: 860px;
      margin: 0 auto;
    }
    h1 {
      font-family: var(--serif);
      font-size: 48px;
      font-weight: 400;
      line-height: 1.2;
      color: var(--fg);
      margin-bottom: 16px;
    }
    .subtitle { color: var(--fg-muted); margin-bottom: 32px; }
    .subtitle a { color: var(--accent); text-decoration: none; }
    .subtitle a:hover { text-decoration: underline; }
    .panel {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 20px 24px;
      background: var(--bg-elevated);
      margin-bottom: 24px;
    }
    .panel-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.14em;
      color: var(--accent);
      text-transform: uppercase;
      margin-bottom: 12px;
    }
    pre#net {
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.6;
      color: var(--fg);
      white-space: pre-wrap;
      word-break: break-all;
    }
    footer {
      margin-top: auto;
      padding-top: 24px;
      font-size: 11px;
      color: var(--fg-muted);
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <h1>Jinn network explorer</h1>
  <p class="subtitle">
    Read substrate live. UI coming soon —
    see <a href="https://github.com/Jinn-Network/mono/blob/main/docs/superpowers/specs/2026-05-12-network-explorer-design.md">docs/superpowers/specs/2026-05-12-network-explorer-design.md</a>
  </p>

  <div class="panel">
    <div class="panel-label">/explorer/network</div>
    <pre id="net">loading...</pre>
  </div>

  <footer>served by @jinn-network/indexer &mdash; <a style="color:var(--accent);text-decoration:none" href="/graphql">GraphQL endpoint</a></footer>

  <script>
    fetch('/explorer/network')
      .then(function(r) { return r.json(); })
      .then(function(d) { document.getElementById('net').textContent = JSON.stringify(d, null, 2); })
      .catch(function(e) { document.getElementById('net').textContent = 'failed to load /explorer/network: ' + e; });
  </script>
</body>
</html>
`;
