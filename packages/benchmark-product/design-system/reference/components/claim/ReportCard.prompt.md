Social card for a published benchmark. Marketable, but scoped: the headline can never be stronger than the report.

```jsx
<ReportCard title="Three harness loadouts on the same 500 tasks"
  suite="SWE-bench Verified · 500 tasks" date="2026-08-04" status="conflicted"
  entrants={[{name:'loadout-c',score:71.1,display:'71.1%'},{name:'loadout-a',score:62.4,display:'62.4%'},{name:'baseline',score:58.0,display:'58.0%'}]} />
```

If the run has conflicted or incomplete results, the card must say so in the status field.