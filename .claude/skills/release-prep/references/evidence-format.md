# Evidence format

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

2. **`marker.txt`** — pasteable marker for the GitHub Release body.

   ```
   <!-- jinn-release-evidence:v1
   release-candidate=v0.1.7
   tier-1-bootstrap=passed
   tier-1-harness-readiness=passed
   tier-1-indexer-roundtrip=skipped:helper-pending
   tier-1-spa-route-smoke=passed
   tier-1-overall=passed-with-skips
   -->
   ```

   The schema extends the existing `jinn-release-evidence:v1` shape with the `tier-1-*` keys defined in the release-readiness spec §"Marker schema extension": `tier-1-bootstrap` (T1.1), `tier-1-harness-readiness` (T1.2), `tier-1-indexer-roundtrip` (T1.3), `tier-1-spa-route-smoke` (T1.4). Status is one of `passed`, `failed:<failClass>`, or `skipped:<reason>`. `tier-1-overall` is `passed` (all scenarios passed), `passed-with-skips` (no failures but at least one scenario skipped — e.g. T1.3 pending its Ponder helper), or `failed` (at least one scenario failed).

3. **`<scenarioId>.log`** — per-scenario evidence file. Free-form text written by each scenario; convention is to include phase markers and timestamps.

## Consumption

`release-readiness` reads `summary.json` directly (structured). The marker block in `marker.txt` is what gets pasted into the GH Release body so the existing marker check in `.github/workflows/npm-publish.yml` validates it. The `.log` files are for humans investigating failures.

## Output directory layout

```
tier-1-evidence/
  2026-05-26T11-30-00-abc4/
    summary.json
    marker.txt
    T1.1.log
    T1.2.log
    T1.3.log
    T1.4.log
```

Older directories under `tier-1-evidence/` should be cleaned up periodically (analogous to substrate's workspace reaper). Out of scope for Plan C.
