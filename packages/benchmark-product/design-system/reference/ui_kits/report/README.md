# UI kit — Public benchmark report

The flagship brand surface. A published Colophon report is what travels: a skeptic opens it, reads
the method, checks the accounting, sees the disagreement, and cites, clones, reruns or challenges it.

**Files**
- `index.html` — the assembled report (start here)
- `ReportHeader.jsx` — sticky nav + masthead (title, standfirst, method lock)
- `ResultTable.jsx` — the configuration comparison table
- `ReportBody.jsx` — sections 01–05 and the imprint
- `data.js` — the sample report record
- `kit-icons.jsx` — Lucide wrapper + asterism mark

**Structural rules this kit encodes**
1. Scores are denominated by *expected* executions, never by returned ones.
2. The method lock sits above the result, not below it.
3. Every report carries a limitation callout and a guarantee-boundary callout.
4. Disagreement is a published section, not a hidden state.
5. The imprint closes the report and is the only place "Built on Jinn." appears.
6. Compact assets (badge, social card, embed) resolve to this page.
