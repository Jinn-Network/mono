# UI kit — Benchmark workspace (application shell)

The commissioning surface. A sponsor or a delegated agent moves left to right:
task set → entrants → assurance → run → publish.

**Files**
- `index.html` — click-through: configure entrants, pick assurance, watch a live run, publish
- `Shell.jsx` — sidebar, topbar, step rail
- `Screens.jsx` — the four workflow screens
- `kit-icons.jsx` — Lucide wrapper + mark

**Screens**
1. **Entrant configurations** — comparison table; cells that differ from the reference entrant are
   tinted, because only those differences can explain a gap.
2. **Evaluation assurance** — the two questions split apart: what counts as success, and how a
   delivery becomes a verdict. The right rail previews the effect on the published report.
3. **Live run** — method lock pinned above; accounting bar denominated by expected executions with
   pending work shown as dotted; the agent activity log uses the stable action vocabulary.
4. **Publish** — the social card and badges are generated beside the form, so the sponsor sees what
   will travel before committing.
