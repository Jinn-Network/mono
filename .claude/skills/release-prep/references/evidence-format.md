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
   tier-1-t1-1=passed
   tier-1-t1-2=passed
   tier-1-t1-3=skipped:helper-pending
   tier-1-t1-4=passed
   tier-1-overall=passed
   -->
   ```

   The schema extends the existing `jinn-release-evidence:v1` shape with `tier-1-*` keys. Each scenario gets one key shaped `tier-1-<id-lowercased-dot-to-dash>=<status>`. Status is one of `passed`, `failed:<failClass>`, or `skipped:<reason>`.

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
