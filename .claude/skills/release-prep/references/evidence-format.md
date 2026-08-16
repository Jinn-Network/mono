# Evidence format

> **Superseded gate, retained diagnostic.** Per the two-gate redesign
> (`docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md` §7),
> the **publish gate is two SHA-bound check-runs** — `hermetic-gate` and
> `environment-suite`, posted via `operator/scripts/release/post-check-run-verdict.mjs`
> — **not** the `marker.txt` documented below. The `jinn-release-evidence:v1`
> marker is **no longer parsed by `npm-publish.yml`** and no longer gates a
> release; if release-prep is run at all (its mechanical run-role is retired —
> see `.claude/skills/release-prep/SKILL.md`), treat `marker.txt` as a
> human-readable **diagnostic artifact** only. The authoritative verdict shape is
> the check-run verdict JSON
> (`{ context, headSha, conclusion, scenarios[], summary }`).

Each release-prep run produces three artifact types under `<outputDir>/`:

1. **`summary.json`** — structured verdict list, parseable by release-readiness.

   ```json
   {
     "candidateVersion": "v0.1.7",
     "timestamp": "2026-05-26T11:30:00Z",
     "verdicts": [
       {
         "scenarioId": "T1.1",
         "verdict": "pass",
         "wallClockMs": 87234,
         "evidencePath": "tier-1-evidence/2026-05-26T11-30-00/T1.1.log",
         "failClass": null,
         "failNotes": null
       },
       { "scenarioId": "T1.2", "verdict": "pass", "..." : "..." }
     ],
     "allPassed": true
   }
   ```

2. **`marker.txt`** — historical pasteable marker (diagnostic only; no longer the publish gate — see the banner above).

   ```
   <!-- jinn-release-evidence:v1
   release-candidate=v0.1.7
   tier-1-bootstrap=passed
   tier-1-harness-readiness=passed
   tier-1-spa-route-smoke=passed
   tier-1-overall=passed
   -->
   ```

   The schema extends the existing `jinn-release-evidence:v1` shape with the `tier-1-*` keys defined in the release-readiness spec §"Marker schema extension": `tier-1-bootstrap` (T1.1), `tier-1-harness-readiness` (T1.2), `tier-1-spa-route-smoke` (T1.4). Status is one of `passed`, `failed:<failClass>`, or `skipped:<reason>`. `tier-1-overall` is `passed` (all scenarios passed), `passed-with-skips` (no failures but at least one scenario skipped), or `failed` (at least one scenario failed).

3. **`<scenarioId>.log`** — per-scenario evidence file. Free-form text written by each scenario; convention is to include phase markers and timestamps.

## Consumption

`release-readiness` reads `summary.json` directly (structured). Historically the `marker.txt` block was pasted into the GH Release body so a marker check in `.github/workflows/npm-publish.yml` could validate it — **that marker check is retired** (the publish guard now queries the `hermetic-gate` + `environment-suite` check-runs on the release SHA, spec §7). The `.log` files are for humans investigating failures.

## Output directory layout

```
tier-1-evidence/
  2026-05-26T11-30-00-abc4/
    summary.json
    marker.txt
    T1.1.log
    T1.2.log
    T1.4.log
```

Older directories under `tier-1-evidence/` should be cleaned up periodically (analogous to substrate's workspace reaper). Out of scope for Plan C.
