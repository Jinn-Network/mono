# Jinn website redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `apps/website/index.html` so jinn.network tells the platform/market story from the [2026-07-29 platform one-pager](../../positioning/2026-07-29-jinn-platform-one-pager.md) instead of the personal-agent story, with live network numbers from the indexer.

**Architecture:** One static HTML file, edited section-by-section in scroll order. Each task replaces exactly one existing section with its successor (or inserts the one new section), so the page renders and is reviewable after every task. Existing CSS custom properties, type pairing, and component classes are reused verbatim; only section-scoped CSS blocks are swapped. One inline `<script>` progressively enhances a static explorer link into live counts.

**Tech Stack:** Plain HTML5 + CSS (no framework, no build step, no dependencies). One inline vanilla-JS IIFE. Deployed by manual `vercel deploy --prod` from `apps/website/`.

## Global Constraints

- **Spec:** [`docs/superpowers/specs/2026-07-30-jinn-website-redesign-design.md`](../specs/2026-07-30-jinn-website-redesign-design.md). Copy source of truth: [`docs/positioning/2026-07-29-jinn-platform-one-pager.md`](../../positioning/2026-07-29-jinn-platform-one-pager.md).
- **Stack:** single static `index.html`. No framework, no build step, no npm dependency, no new files under `apps/website/` except the ones this plan names. The README's deliberate stack deviation stands.
- **Copy rule 1 — no unparseable terms.** A cold reader with zero Jinn context must understand every sentence. "Evidence", "corpus", "substrate", "provenance", "harness" never appear on the page; each becomes a plain phrase (usually *the record of how the work was done*) or gets a concrete example in the same sentence.
- **Copy rule 2 — say "AI agents" out loud.** The hero and role cards name agents explicitly.
- **Copy rule 3 — no "paid"/"pays"/"payment for"/"compensation" for protocol actions.** Performers **earn** OLAS. (`CLAUDE.md` §External Communication.)
- **Copy rule 4 — no "proven", "guaranteed", "best".** It is a bet until a public gate says otherwise.
- **`BRAND.md` non-negotiables:** no emoji anywhere; no gradients as decoration; plain words whenever money or consent is on the line; softened-brutalist corners only — `--radius-1` 4px, `--radius-2` 6px, `--radius-3` 10px, `--radius-pill` for status chips.
- **"Show, don't narrate" (`CLAUDE.md` §Frontends):** no caption or subtitle whose only job is restating what the UI already shows. Prose is allowed only in empty/fallback states and as the section arguments this plan specifies verbatim.
- **American English spelling throughout, including user-facing copy** — `CLAUDE.md` Rule 5 covers user-facing copy explicitly and names `distill`, never `distil`. The current page already uses zero British spellings. Leave the existing `lang="en-GB"` attribute alone (locale tag, not spelling; changing it is out of scope per Rule 3).
- **Indexer endpoint (verified live 2026-07-30):** `GET https://jinn-indexer-production.up.railway.app/explorer/network` returns JSON, responds `200`, and sends `access-control-allow-origin: *` (cross-origin fetch from jinn.network works).
- **Explorer routes (verified):** `https://explorer.jinn.network/`, `/solvernets`, `/operators`, `/corpus`.
- **Never deploy.** `vercel deploy --prod` publishes to jinn.network and is a human-gated step (Task 10). Do not run it.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/website/index.html` | The entire site: markup, styles, one inline script | Modify (Tasks 1–8) |
| `apps/website/README.md` | Copy-source pointer, domain model, deploy notes | Modify (Task 9) |
| `docs/positioning/2026-07-07-jinn-positioning-spine.md` | Superseded-by note | Modify (Task 9) |
| `.claude/launch.json` | Local static-server entry for browser verification | Modify (Task 1). Gitignored — never committed |

`index.html` stays one file. It is ~380 lines and the established pattern for this brochure; splitting it would break the no-build deploy for no benefit.

## Verification approach (read before Task 1)

`apps/website` has no test runner, no build step, and no test directory, and adding one for a static brochure is scope creep this plan rejects. Verification is therefore **browser-based and concrete**, not vitest-based. Every task ends by asserting on the rendered page through the Browser pane tools:

- `mcp__Claude_Browser__get_page_text` / `read_page` — assert copy and structure are present.
- `mcp__Claude_Browser__read_console_messages` with `onlyErrors: true` — assert zero errors.
- `mcp__Claude_Browser__computer {action: "screenshot"}` — visual check.
- `mcp__Claude_Browser__resize_window` — responsive check (Task 10 only).

The one piece of real logic — the live-stats script — gets its three states (success, all-zero, fetch failure) exercised explicitly in Task 2 by stubbing `window.fetch` via `javascript_tool`. That is genuine edge-case verification without a toolchain.

---

### Task 1: Local preview + head, header, and hero

Switches the page's identity from personal agent to platform, and stands up the preview server every later task verifies against.

**Files:**
- Modify: `.claude/launch.json` (add a `jinn-website` configuration)
- Modify: `apps/website/index.html:6-13` (title + meta), `apps/website/index.html:203` (chip), `apps/website/index.html:217-223` (hero inner), plus the `.hero__cta` CSS block at `apps/website/index.html:109`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a running preview at `http://localhost:5188` serving `apps/website/`, reused by Tasks 2–10. The hero markup ends with `<div class="hero__cta">…</div>`; Task 2 inserts its new `<section>` immediately after the closing `</section>` of the hero.

- [ ] **Step 1: Add the local static-server entry**

`.claude/launch.json` already exists with an `explorer-spa` entry and is gitignored (`.gitignore:13`). Add a second configuration to the `configurations` array, keeping `explorer-spa` untouched:

```json
    {
      "name": "jinn-website",
      "runtimeExecutable": "sh",
      "runtimeArgs": [
        "-c",
        "cd apps/website && exec python3 -m http.server 5188 --bind 127.0.0.1"
      ],
      "port": 5188
    }
```

- [ ] **Step 2: Start the preview and confirm the current page loads**

Call `mcp__Claude_Browser__preview_start` with `{name: "jinn-website"}`.
Then `mcp__Claude_Browser__get_page_text`.
Expected: text contains `An agent that gets better as more people use it.` (the old hero — confirms the server serves the right file before any edit).

- [ ] **Step 3: Replace the head metadata**

In `apps/website/index.html`, replace lines 6–13 (the `<title>` through the `twitter:card` meta) with:

```html
<title>Jinn — an open market for work done by AI agents</title>
<meta name="description" content="Jinn is an open market for work done by AI agents. Every job delivers a result to whoever asked, and leaves a verifiable record of how it was done that anyone can build on.">
<link rel="canonical" href="https://jinn.network/">
<meta property="og:title" content="Jinn — open work that compounds">
<meta property="og:description" content="An open market for work done by AI agents. Every job delivers a result — and leaves a verifiable record of how it was done that anyone can build on.">
<meta property="og:url" content="https://jinn.network/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
```

Leave line 8's original `<link rel="canonical">` position as handled above (the replacement block includes it exactly once — verify there is no duplicate canonical tag afterwards).

- [ ] **Step 4: Add the secondary-link CSS**

Immediately after the `.hero__cta` rule (line 109), add:

```css
  .hero__link { font-size: 13px; color: var(--fg-muted); text-decoration: none; }
  .hero__link:hover { color: var(--sky-hover); }
```

- [ ] **Step 5: Replace the hero content**

Replace the contents of `<div class="container hero__inner">` (lines 218–222) with:

```html
      <h1>Open work that compounds.</h1>
      <p class="hero__sub">Jinn is an open market for work done by AI agents. Every job delivers a result to whoever asked — and leaves a verifiable record of how it was done, which anyone can build on.</p>
      <div class="hero__cta">
        <a class="btn" href="https://t.me/jinnNetwork">Join the Telegram</a>
        <a class="hero__link" href="https://explorer.jinn.network">Watch the network live →</a>
      </div>
```

Leave the `Testnet` chip (line 203), the `.hero__texture` div, and the `.hero__watermark` div exactly as they are.

- [ ] **Step 6: Verify the hero renders and nothing errored**

Reload: `mcp__Claude_Browser__navigate` to `http://localhost:5188`.
Then `mcp__Claude_Browser__get_page_text`.
Expected: contains `Open work that compounds.` and `an open market for work done by AI agents`; does **not** contain `An agent that gets better as more people use it.`
Then `mcp__Claude_Browser__read_console_messages` with `{onlyErrors: true}`.
Expected: empty (no errors).

- [ ] **Step 7: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): reposition head metadata and hero to platform story"
```

---

### Task 2: Live network strip

The only JavaScript on the page. Static markup is the honest fallback link; JS upgrades it to real counts.

**Files:**
- Modify: `apps/website/index.html` — new CSS block after the `.hero__link` rules (Task 1 Step 4); new `<section>` immediately after the hero's closing `</section>`; new `<script>` immediately before `</body>`

**Interfaces:**
- Consumes: the hero section's closing `</section>` tag as its insertion point (Task 1).
- Produces: element IDs `net-grid` and `net-fallback`, referenced only by the inline script in this task. No later task depends on them.

- [ ] **Step 1: Add the stats CSS**

After the `.hero__link:hover` rule added in Task 1, add:

```css
  /* Live network */
  .stats__inner { padding-top: clamp(28px, 4vw, 40px); padding-bottom: clamp(28px, 4vw, 40px); }
  .stats__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: clamp(20px, 4vw, 48px); }
  .stats__cell { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: var(--fg); }
  .stats__value { font-family: var(--serif); font-size: clamp(28px, 4vw, 44px); line-height: 1; color: var(--sky); }
  .stats__cell:hover .stats__value { color: var(--sky-hover); }
  .stats__fallback a { font-size: 13px; }
```

- [ ] **Step 2: Add the stats markup**

Immediately after the hero section's closing `</section>`, insert:

```html
  <!-- Live network -->
  <section class="section stats">
    <div class="container stats__inner">
      <div class="stats__fallback" id="net-fallback">
        <a href="https://explorer.jinn.network">Watch the network live →</a>
      </div>
      <div class="stats__grid" id="net-grid" hidden></div>
    </div>
  </section>
```

The fallback link is the default rendering. With JavaScript disabled, an unreachable indexer, or all-zero counts, this is what ships — never a zero, never a spinner.

- [ ] **Step 3: Add the inline script**

Immediately before `</body>`, insert:

```html
<script>
  (function () {
    var API = 'https://jinn-indexer-production.up.railway.app/explorer/network';
    var EXPLORER = 'https://explorer.jinn.network';
    var METRICS = [
      { key: 'tasksPosted',            label: 'Tasks posted',       href: EXPLORER + '/' },
      { key: 'attempts',               label: 'Attempts',           href: EXPLORER + '/' },
      { key: 'solverNetsRunning',      label: 'SolverNets running', href: EXPLORER + '/solvernets' },
      { key: 'everAttemptedOperators', label: 'Operators',          href: EXPLORER + '/operators' }
    ];
    var grid = document.getElementById('net-grid');
    var fallback = document.getElementById('net-fallback');
    if (!grid || !fallback || !window.fetch) return;

    fetch(API, { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var cells = METRICS.filter(function (m) {
          return typeof data[m.key] === 'number' && data[m.key] > 0;
        });
        if (!cells.length) return;
        grid.innerHTML = cells.map(function (m) {
          return '<a class="stats__cell" href="' + m.href + '">'
            + '<span class="stats__value">' + data[m.key].toLocaleString('en-GB') + '</span>'
            + '<span class="label label--dim">' + m.label + '</span></a>';
        }).join('');
        grid.hidden = false;
        fallback.hidden = true;
      })
      .catch(function () {
        /* fallback link stays visible */
      });
  })();
</script>
```

Two properties to preserve if you touch this script: every value interpolated into `innerHTML` is guarded by `typeof … === 'number'`, and every label and href is a hardcoded constant — so indexer data cannot inject markup. The `> 0` filter is what keeps zero-valued metrics off the page.

**Why these four metrics:** a live fetch on 2026-07-30 returned `tasksPosted: 1208`, `attempts: 125`, `solverNetsRunning: 8`, `everAttemptedOperators: 6`, and `verdicts: 0`. The design spec listed "verdicts recorded" as a candidate; it is zero today, so it is excluded from `METRICS`. The `> 0` filter means adding it back later is safe regardless of its value.

- [ ] **Step 4: Verify the success state against the real indexer**

Reload `http://localhost:5188`, then `mcp__Claude_Browser__get_page_text`.
Expected: contains `Tasks posted`, `Attempts`, `SolverNets running`, `Operators`, and a thousands-separated number (e.g. `1,208`); does **not** contain `Watch the network live →` twice (the fallback is hidden, so `get_page_text` should show it at most once, from the hero).
Then `mcp__Claude_Browser__read_console_messages` with `{onlyErrors: true}`.
Expected: empty.

- [ ] **Step 5: Verify the fetch-failure state**

Run via `mcp__Claude_Browser__javascript_tool`:

```javascript
(async () => {
  window.fetch = () => Promise.reject(new Error('offline'));
  document.getElementById('net-grid').hidden = true;
  document.getElementById('net-grid').innerHTML = '';
  document.getElementById('net-fallback').hidden = false;
  const s = document.createElement('script');
  s.textContent = document.querySelector('body > script').textContent;
  document.body.appendChild(s);
  await new Promise(r => setTimeout(r, 300));
  return {
    gridHidden: document.getElementById('net-grid').hidden,
    fallbackHidden: document.getElementById('net-fallback').hidden
  };
})()
```

Expected: `{gridHidden: true, fallbackHidden: false}` — the fallback link survives a dead indexer.

- [ ] **Step 6: Verify the all-zero state**

Reload the page first (to restore real `fetch`), then run via `javascript_tool`:

```javascript
(async () => {
  window.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      tasksPosted: 0, attempts: 0, solverNetsRunning: 0, everAttemptedOperators: 0
    })
  });
  document.getElementById('net-grid').hidden = true;
  document.getElementById('net-grid').innerHTML = '';
  document.getElementById('net-fallback').hidden = false;
  const s = document.createElement('script');
  s.textContent = document.querySelector('body > script').textContent;
  document.body.appendChild(s);
  await new Promise(r => setTimeout(r, 300));
  return {
    gridHidden: document.getElementById('net-grid').hidden,
    gridHtml: document.getElementById('net-grid').innerHTML,
    fallbackHidden: document.getElementById('net-fallback').hidden
  };
})()
```

Expected: `{gridHidden: true, gridHtml: "", fallbackHidden: false}` — no zeros reach the page.

- [ ] **Step 7: Reload to restore the real state, then commit**

Navigate to `http://localhost:5188` once more so the page is left in its genuine state, then:

```bash
git add apps/website/index.html
git commit -m "feat(website): add fail-silent live network strip from indexer"
```

---

### Task 3: How it works (replaces "How it learns")

**Files:**
- Modify: `apps/website/index.html` — replace the `/* How it learns */` CSS block (originally lines 111–120) and the entire `<section class="section learn">` (originally lines 227–273)

**Interfaces:**
- Consumes: nothing from Tasks 1–2 beyond the running preview.
- Produces: `<section class="section loop">` — Task 4 inserts its section immediately after this one's closing `</section>`.

- [ ] **Step 1: Replace the CSS block**

Delete the whole `/* How it learns */` comment block and its `.learn*` rules, and put in their place:

```css
  /* How it works */
  .loop h2 { font-size: clamp(30px, 4.5vw, 48px); line-height: 1.15; margin: 0 0 56px; max-width: 24ch; }
  .loop .label { margin-bottom: 20px; }
  .loop__row { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 16px; }
  .loop__step { border: 1px solid var(--border); border-radius: 10px; padding: 24px 20px; background: var(--bg); }
  .loop__step--split { border-color: var(--border-gold); }
  .loop__step .label { display: block; margin-bottom: 12px; }
  .loop__step p { margin: 0; font-size: 14px; line-height: 1.7; }
  .loop__after { margin: 40px 0 0; max-width: 62ch; font-size: 14px; line-height: 1.7; color: var(--fg-muted); text-wrap: pretty; }
```

- [ ] **Step 2: Replace the section markup**

Replace the entire `<section class="section learn">…</section>` block with:

```html
  <!-- How it works -->
  <section class="section loop">
    <div class="container section-pad">
      <div class="label">How it works</div>
      <h2>Every job produces two things.</h2>
      <ol class="loop__row">
        <li class="loop__step">
          <div class="label label--dim">01 — Request</div>
          <p>Someone posts a task and funds it.</p>
        </li>
        <li class="loop__step">
          <div class="label label--dim">02 — Work</div>
          <p>An agent picks it up and does the work.</p>
        </li>
        <li class="loop__step">
          <div class="label label--dim">03 — Check</div>
          <p>An independent evaluator checks the result.</p>
        </li>
        <li class="loop__step loop__step--split">
          <div class="label label--gold">04 — Two outputs</div>
          <p>The requester gets the result. The record of how it was done is kept.</p>
        </li>
        <li class="loop__step">
          <div class="label label--dim">05 — Reuse</div>
          <p>Anyone can build on that record.</p>
        </li>
      </ol>
      <p class="loop__after">A normal marketplace ends at result and payment. Jinn also keeps the record — so the next job, and everyone else's, starts smarter.</p>
    </div>
  </section>
```

**Deliberate deviation from the spec:** the spec described arrows between steps. On a `repeat(auto-fit, …)` grid that wraps at narrow widths, arrows point into empty space at the end of each row. The `01`–`05` labels carry the sequence instead. No arrow glyphs.

- [ ] **Step 3: Verify**

Reload `http://localhost:5188`, then `get_page_text`.
Expected: contains `Every job produces two things.`, `01 — Request`, `05 — Reuse`, and `A normal marketplace ends at result and payment.`; does **not** contain `Skills are earned by doing the work.` or `Deepen`.
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): replace how-it-learns with the request-to-reuse loop"
```

---

### Task 4: Three ways in (replaces the terminal-demo section)

**Files:**
- Modify: `apps/website/index.html` — delete the `/* Corpus signal */` CSS block (originally lines 122–147, including every `.signal*`, `.term*`, and `.t-*` rule) and replace the entire `<section class="section signal">` (originally lines 276–307)

**Interfaces:**
- Consumes: the `.loop` section's closing `</section>` as its insertion point (Task 3).
- Produces: `<section class="section roles">` — Task 5 replaces the section immediately following it.

- [ ] **Step 1: Delete the terminal CSS and add the roles CSS**

Remove the entire `/* Corpus signal */` block — all of `.signal h2`, `.signal__wrap`, `.signal__status`, `.signal__dot`, `.term`, `.term__bar`, `.term__title`, `.term__net`, `.term__body`, `.t-dim`, `.t-quote`, `.t-sky`, `.t-fg`, `.t-gold`, `.t-green`, `.t-bound`, `.signal__caption` — and put in its place:

```css
  /* Three ways in */
  .roles h2 { font-size: clamp(30px, 4.5vw, 48px); line-height: 1.15; margin: 0 0 56px; max-width: 24ch; }
  .roles .label { margin-bottom: 20px; }
  .roles__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  .roles__card {
    display: flex; flex-direction: column;
    border: 1px solid var(--border); border-radius: 10px; padding: 32px 28px; background: var(--bg);
  }
  .roles__card h3 { font-family: var(--serif); font-weight: 400; font-size: 26px; line-height: 1.2; margin: 0 0 16px; }
  .roles__card p { margin: 0 0 16px; font-size: 14px; line-height: 1.7; }
  .roles__eg { color: var(--fg-dim); font-size: 12px; line-height: 1.7; }
  .roles__action { margin-top: auto; font-size: 13px; text-decoration: none; }
```

- [ ] **Step 2: Replace the section markup**

Replace the entire `<section class="section signal">…</section>` block with:

```html
  <!-- Three ways in -->
  <section class="section roles">
    <div class="container section-pad">
      <div class="label">Three ways in</div>
      <h2>Where you fit.</h2>
      <div class="roles__grid">
        <div class="roles__card">
          <h3>Get work done</h3>
          <p>Post a task and fund it. An agent picks it up, does it, and the result is checked before you receive it.</p>
          <p class="roles__eg">Patches · reports · datasets · evaluations · forecasts</p>
          <a class="roles__action" href="https://t.me/jinnNetwork">Bring us a task →</a>
        </div>
        <div class="roles__card">
          <h3>Put your agent to work</h3>
          <p>Run an agent that performs or checks tasks on the network. Work that passes verification earns OLAS.</p>
          <p class="roles__eg">The protocol doesn't mind who performs the work — agent, person, or service. In practice it's mostly AI agents.</p>
          <a class="roles__action" href="https://t.me/jinnNetwork">Run an agent →</a>
        </div>
        <div class="roles__card">
          <h3>Build on the work records</h3>
          <p>Every job leaves a public trace: what was asked, what the agent did, what it produced, and how it was judged. Use those records to benchmark models, score performers, train agents, or distill skills.</p>
          <p class="roles__eg">Benchmarks · reputation · datasets · fine-tuning · agent memory</p>
          <a class="roles__action" href="https://explorer.jinn.network">Browse the records →</a>
        </div>
      </div>
    </div>
  </section>
```

- [ ] **Step 3: Verify**

Reload, then `get_page_text`.
Expected: contains `Where you fit.`, `Get work done`, `Put your agent to work`, `Build on the work records`, `earns OLAS`; does **not** contain `jinn "file last month's receipts for tax"`, `invoice-triage`, or `bound`.
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): replace terminal demo with the three market roles"
```

---

### Task 5: Open by design (replaces the trust section)

**Files:**
- Modify: `apps/website/index.html` — replace the `/* Trust */` CSS block (originally lines 149–159) and the entire `<section class="section trust">` (originally lines 310–342)

**Interfaces:**
- Consumes: the `.roles` section's closing `</section>` as its position marker (Task 4).
- Produces: `<section class="section contrast">` — Task 6 replaces the section immediately following it.

- [ ] **Step 1: Replace the CSS block**

Delete the `/* Trust */` block and all `.trust*` rules, and put in their place:

```css
  /* Open by design */
  .contrast h2 { font-size: clamp(30px, 4.5vw, 48px); line-height: 1.15; margin: 0 0 48px; max-width: 24ch; }
  .contrast .label { margin-bottom: 20px; }
  .contrast__pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  .contrast__col { border: 1px solid var(--border); border-radius: 10px; padding: 32px 28px; background: var(--bg); }
  .contrast__col--jinn { border-color: var(--border-gold); }
  .contrast__col .label { margin-bottom: 24px; }
  .contrast__list { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .contrast__list li { font-size: 13px; color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 10px 14px; }
  .contrast__note { margin: 0; font-size: 13px; line-height: 1.7; color: var(--fg-muted); }
  .contrast__arrows { font-size: 13px; color: var(--fg-dim); letter-spacing: 0.5em; margin-bottom: 8px; }
  .contrast__pooled {
    font-size: 13px; color: var(--fg); border: 1px solid var(--border-gold);
    border-radius: 4px; padding: 10px 14px; margin-bottom: 8px;
  }
  .contrast__wager { margin: 48px 0 0; max-width: 62ch; font-size: 15px; line-height: 1.7; text-wrap: pretty; }
  .contrast__tradeoff { margin: 20px 0 0; max-width: 62ch; font-size: 14px; line-height: 1.7; color: var(--fg-muted); text-wrap: pretty; }
```

- [ ] **Step 2: Replace the section markup**

Replace the entire `<section class="section trust">…</section>` block with:

```html
  <!-- Open by design -->
  <section class="section contrast">
    <div class="container section-pad">
      <div class="label">Open by design</div>
      <h2>A closed system only learns from itself.</h2>
      <div class="contrast__pair">
        <div class="contrast__col">
          <div class="label label--dim">Closed</div>
          <ul class="contrast__list">
            <li>Project A — own work, own data, own gains</li>
            <li>Project B — own work, own data, own gains</li>
            <li>Project C — own work, own data, own gains</li>
          </ul>
          <p class="contrast__note">Each project rebuilds the same capability alone.</p>
        </div>
        <div class="contrast__col contrast__col--jinn">
          <div class="label label--gold">On Jinn</div>
          <ul class="contrast__list">
            <li>Project A</li>
            <li>Project B</li>
            <li>Project C</li>
          </ul>
          <div class="contrast__arrows" aria-hidden="true">↓↓↓</div>
          <div class="contrast__pooled">A shared record of everything they've done</div>
          <div class="contrast__arrows" aria-hidden="true">↓↓↓</div>
          <p class="contrast__note">Every project draws on the work of all of them.</p>
        </div>
      </div>
      <p class="contrast__wager">No single open project runs enough work to match a well-funded private platform. A network of projects contributing to and drawing from a shared record can.</p>
      <p class="contrast__tradeoff">Work that has to stay private is a poor fit for this, and that's deliberate. Jinn is built for work whose record can be shared — so that an execution performed for one open project can later help another one evaluate a performer, compare systems, or find an approach that already worked.</p>
    </div>
  </section>
```

- [ ] **Step 3: Verify**

Reload, then `get_page_text`.
Expected: contains `A closed system only learns from itself.`, `A shared record of everything they've done`, `No single open project runs enough work`, `Work that has to stay private is a poor fit`; does **not** contain `Try it cold`, `Sharing is off by default`, or `scrubbed`.
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): replace trust section with the open-by-design wager"
```

---

### Task 6: Built on Jinn (replaces the earning section)

**Files:**
- Modify: `apps/website/index.html` — replace the `/* Earning */` CSS block (originally lines 161–167) and the entire `<section class="section earning">` (originally lines 345–353)

**Interfaces:**
- Consumes: the `.contrast` section's closing `</section>` as its position marker (Task 5).
- Produces: `<section class="section boundary">` — Task 7 replaces the two sections that follow it.

- [ ] **Step 1: Replace the CSS block**

Delete the `/* Earning */` block and all `.earning*` rules, and put in their place:

```css
  /* Built on Jinn */
  .boundary { background: var(--bg-sunken); }
  .boundary h2 { font-size: clamp(28px, 4vw, 44px); line-height: 1.15; margin: 0 0 40px; max-width: 26ch; }
  .boundary .label { margin-bottom: 20px; }
  .boundary__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .boundary__item {
    font-size: 13px; color: var(--fg);
    border: 1px solid var(--border); border-radius: 4px; padding: 14px 16px;
  }
  .boundary__after { margin: 32px 0 0; max-width: 62ch; font-size: 14px; line-height: 1.7; color: var(--fg-muted); text-wrap: pretty; }
```

- [ ] **Step 2: Replace the section markup**

Replace the entire `<section class="section earning">…</section>` block with:

```html
  <!-- Built on Jinn -->
  <section class="section boundary">
    <div class="container section-pad">
      <div class="label label--gold">The boundary</div>
      <h2>Jinn coordinates the work and keeps the records. Everything else is built on top.</h2>
      <div class="boundary__grid">
        <div class="boundary__item">Repository maintenance</div>
        <div class="boundary__item">Research tools</div>
        <div class="boundary__item">Benchmarking platforms</div>
        <div class="boundary__item">Audit trails</div>
        <div class="boundary__item">Reputation systems</div>
        <div class="boundary__item">Skill libraries</div>
        <div class="boundary__item">Dataset builders</div>
        <div class="boundary__item">Fine-tuning services</div>
        <div class="boundary__item">Agent tuning</div>
        <div class="boundary__item">Agent memory</div>
        <div class="boundary__item">Reinforcement learning</div>
      </div>
      <p class="boundary__after">These are applications, not Jinn. They may request work, perform it, use the records, or all three. Jinn doesn't decide what any record means — each application decides what it trusts and how it uses it.</p>
    </div>
  </section>
```

- [ ] **Step 3: Verify**

Reload, then `get_page_text`.
Expected: contains `Jinn coordinates the work and keeps the records.`, `Benchmarking platforms`, `Reinforcement learning`, `These are applications, not Jinn.`; does **not** contain `Verified contributions earn OLAS.` or `No token is needed to use Jinn.`
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): replace earning block with the platform boundary"
```

---

### Task 7: Closing CTA and footer

**Files:**
- Modify: `apps/website/index.html` — the closing `<section>` (originally lines 356–361) and the `<footer>` links (originally lines 374–377)

**Interfaces:**
- Consumes: the `.boundary` section's closing `</section>` as its position marker (Task 6).
- Produces: the final page structure. Task 8 audits the whole file; no new identifiers.

- [ ] **Step 1: Replace the closing CTA copy**

In the closing section, replace the `<h2>` line:

```html
      <h2>The network is small and early. That's when it's easiest to shape.</h2>
```

Leave the `<a class="btn" href="https://t.me/jinnNetwork">Join the Telegram</a>` line and the `.closing` CSS unchanged.

- [ ] **Step 2: Add the positioning-doc link to the footer**

Replace the `<div class="footer__links">` block with:

```html
      <div class="footer__links">
        <a class="footer__link" href="https://explorer.jinn.network">explorer.jinn.network</a>
        <a class="footer__link" href="https://github.com/Jinn-Network/mono">github.com/Jinn-Network/mono</a>
        <a class="footer__link" href="https://github.com/Jinn-Network/mono/blob/main/docs/positioning/2026-07-29-jinn-platform-one-pager.md">what Jinn is, in full</a>
      </div>
```

- [ ] **Step 3: Verify**

Reload, then `get_page_text`.
Expected: contains `The network is small and early.` and `what Jinn is, in full`; does **not** contain `Stay on the edge of agentic computing.`
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add apps/website/index.html
git commit -m "feat(website): update closing CTA and footer links"
```

---

### Task 8: Dead-CSS and stale-copy audit

Six section swaps across one file leave orphans. This task is the cleanup gate.

**Files:**
- Modify: `apps/website/index.html` (deletions only)

**Interfaces:**
- Consumes: the finished markup from Tasks 1–7.
- Produces: a file with no unreferenced CSS and no personal-agent copy.

- [ ] **Step 1: Grep for orphaned CSS class prefixes**

```bash
cd apps/website
for p in learn signal term t-dim t-quote t-sky t-fg t-gold t-green t-bound trust earning; do
  echo "== $p: $(grep -c "$p" index.html)"
done
```

Expected: `0` for every prefix. Any non-zero count is either a leftover CSS rule to delete or leftover markup a prior task missed — inspect with `grep -n "<prefix>" index.html` and delete it.

- [ ] **Step 2: Grep for banned copy**

```bash
cd apps/website
grep -niE "\bpaid\b|\bpays\b|payment for|compensation|\bproven\b|guaranteed|\bcorpus\b|\bsubstrate\b|\bprovenance\b|\bharness\b" index.html
```

Expected: **one** match only — `ends at result and payment` in the `.loop__after` line, which describes what a *normal marketplace* does, not a Jinn protocol action, and is therefore allowed. Any other match violates a global constraint and must be reworded.

- [ ] **Step 3: Confirm the personal-agent story is fully gone**

```bash
cd apps/website
grep -niE "personal agent|gets better as more people|your agent|scrubb|keystore|receipts" index.html
```

Expected: no output.

- [ ] **Step 4: Confirm no emoji and exactly one script**

```bash
cd apps/website
grep -c "<script" index.html
grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" index.html || echo "no emoji"
```

Expected: `1` script tag. The emoji grep should print `no emoji`, or match only the `↓` arrows in the contrast section and `→` in link labels (U+2190–U+21FF arrows are typography, not emoji — those are fine; anything in the pictograph ranges is not).

- [ ] **Step 5: Verify the page still renders after deletions**

Reload, then `get_page_text`.
Expected: still contains `Open work that compounds.`, `Every job produces two things.`, `Where you fit.`, `A closed system only learns from itself.`, `Jinn coordinates the work and keeps the records.`, `The network is small and early.`
Then `read_console_messages {onlyErrors: true}`.
Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add apps/website/index.html
git commit -m "refactor(website): drop dead CSS and stale personal-agent copy"
```

---

### Task 9: Documentation housekeeping

**Files:**
- Modify: `apps/website/README.md`
- Modify: `docs/positioning/2026-07-07-jinn-positioning-spine.md`

**Interfaces:**
- Consumes: the finished page (Tasks 1–8).
- Produces: documentation consistent with the shipped site. No code depends on this task.

- [ ] **Step 1: Rewrite the README body**

Replace the bullet list in `apps/website/README.md` (everything after the `One static file…` line) with:

```markdown
- `index.html` — the whole site.
- **Deploy:** Vercel CLI from this directory — `vercel deploy --prod` (team `jinn-a6b5fa9d`, project `jinn-website`). `jinn.network` and `www.jinn.network` are attached to that project. There is no git integration; deploys are manual.
- **Copy** derives from the [platform one-pager](../../docs/positioning/2026-07-29-jinn-platform-one-pager.md); check any copy change against it before shipping. Design spec: [2026-07-30-jinn-website-redesign-design.md](../../docs/superpowers/specs/2026-07-30-jinn-website-redesign-design.md). Primary CTA: the Telegram group; the explorer and GitHub carry the evidence links.
- **Live numbers:** one inline script fetches counts from `GET https://jinn-indexer-production.up.railway.app/explorer/network` (the endpoint the explorer uses). It renders a metric only when its value is above zero, and falls back to a plain "Watch the network live" explorer link on any failure — no zeros, no spinners.
- **Domain model** (per the frontend spec rule): one read-only page. State — the live network counts (render-or-omit). State messages — none; the fetch-failure state is expressed structurally, not as a message. Collections — none. Actions — outbound links only (Telegram, explorer, GitHub), no lifecycle.
- **Stack deviation, deliberate:** plain static HTML, not Next.js + shadcn. A single-page brochure with no state doesn't justify an app framework; revisit if it grows beyond one page.
```

Also delete the trailing `Design source: Claude Design handoff …` line — it documents the superseded personal-agent design.

- [ ] **Step 2: Add the supersession note to the spine**

In `docs/positioning/2026-07-07-jinn-positioning-spine.md`, insert immediately after the `- **Status:** …` line in the header block:

```markdown
- **Superseded for public surfaces (2026-07-30):** jinn.network now tells the platform/market story from the [2026-07-29 platform one-pager](2026-07-29-jinn-platform-one-pager.md), which is the copy source for the site. This spine's personal-agent framing ("a personal agent backed by a shared, verified memory") no longer governs the landing page. Its messaging guardrails — no "proven"/"guaranteed"/"best", plain words on money and consent, earn-not-paid, claim only what the chain shows — still apply to every surface. A versioned rewrite of the spine under the platform framing is outstanding.
```

- [ ] **Step 3: Verify the links resolve**

```bash
cd "$(git rev-parse --show-toplevel)"
ls docs/positioning/2026-07-29-jinn-platform-one-pager.md
ls docs/superpowers/specs/2026-07-30-jinn-website-redesign-design.md
```

Expected: both paths listed, no `No such file` error.

- [ ] **Step 4: Commit**

```bash
git add apps/website/README.md docs/positioning/2026-07-07-jinn-positioning-spine.md
git commit -m "docs: point website copy source at the platform one-pager, note spine supersession"
```

---

### Task 10: Full-page verification and human deploy gate

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: the evidence the work is done, and a deploy decision for the human.

- [ ] **Step 1: Desktop render check**

`mcp__Claude_Browser__resize_window {preset: "desktop"}`, reload, then `mcp__Claude_Browser__computer {action: "screenshot"}`.
Confirm visually: nine sections in order (header, hero, stats, loop, roles, contrast, boundary, closing, footer); live numbers visible in the stats strip; gold accents on the `04 — Two outputs` step, the `On Jinn` column, and `The boundary` label.

- [ ] **Step 2: Mobile render check**

`mcp__Claude_Browser__resize_window {preset: "mobile"}`, reload, screenshot.
Confirm: no horizontal scrollbar; every grid has collapsed to a single column; the hero H1 does not overflow. Then run via `javascript_tool`:

```javascript
({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })
```

Expected: `scrollW <= clientW` (no horizontal overflow).

- [ ] **Step 3: Console and network check**

`read_console_messages {onlyErrors: true}` → expected empty.
`mcp__Claude_Browser__read_network_requests {urlPattern: "explorer/network"}` → expected one request, status 200.

- [ ] **Step 4: Reset the viewport**

`mcp__Claude_Browser__resize_window {preset: "desktop"}`.

- [ ] **Step 5: Report and stop for the human**

Summarise for the user: sections shipped, the four live metrics and their current values, the `verdicts: 0` exclusion, and the copy-audit result from Task 8.

**Do not run `vercel deploy --prod`.** Publishing to jinn.network is outward-facing and is the human's call. Offer it as the next step and wait for an explicit yes:

```bash
cd apps/website && vercel deploy --prod
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Full repositioning, platform story | 1–8 |
| One page, no thesis page | Whole plan (no new page created) |
| Static HTML, no framework, manual deploy | Global Constraints; 10 Step 5 |
| Visual system unchanged | 1–7 (tokens reused; only section CSS swapped) |
| Copy rule: no unparseable terms | Global Constraints; 8 Step 2 |
| Copy rule: say "AI agents" | 1 Step 5; 4 Step 2 |
| BRAND non-negotiables, no emoji | Global Constraints; 8 Step 4 |
| Show-don't-narrate | Global Constraints |
| Header (§1) | 1 (chip and logo untouched) |
| Hero (§2) | 1 Steps 4–5 |
| Live stats strip (§3) | 2 |
| How it works (§4) | 3 |
| Three roles (§5) | 4 |
| Open by design (§6) | 5 |
| Built on Jinn (§7) | 6 |
| Closing CTA (§8) | 7 Step 1 |
| Footer (§9) | 7 Step 2 |
| Cut terminal / trust / earning | 4, 5, 6 respectively; audited in 8 |
| Diagrams as HTML/CSS, no assets | 3, 5 (with the arrow deviation noted in 3) |
| Fail-silent stats, no zeros | 2 Steps 3, 5, 6 |
| Domain model documented | 9 Step 1 |
| Spine supersession note | 9 Step 2 |
| README pointer update | 9 Step 1 |
| One-pager committed, typo fixed | Already done — commit `1ce9195c6` |
| Success criteria 1–4 | 8, 10 |

**Placeholder scan:** no TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the literal content to paste.

**Consistency check:** element IDs `net-grid` / `net-fallback` are defined and used only in Task 2. CSS class prefixes introduced (`stats__`, `loop__`, `roles__`, `contrast__`, `boundary__`) each appear in exactly one task's CSS and that same task's markup. The prefixes deleted in Task 8's audit (`learn`, `signal`, `term`, `t-*`, `trust`, `earning`) are exactly those the earlier tasks stop using. Line numbers cited are from the pre-edit file and drift as tasks land — each task also names the section by class, which is the reliable anchor.

**Known drift risk:** Tasks 2–8 cite original line numbers from the unedited `index.html`. Locate sections by their CSS comment (`/* Trust */`) and class (`class="section trust"`) rather than by line number when the two disagree.
