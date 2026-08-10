window.__REPORT={
  id:'r/hb-2026-08', suite:'SWE-bench Verified · 500 tasks', date:'2026-08-04',
  title:'Three harness loadouts on the same 500 tasks',
  standfirst:'A tool-policy change raises the met rate by 8.7 points and roughly doubles cost. 88 tasks drew a split verdict and are published as conflicted.',
  sponsor:'openharness/loadout',
  digest:'sha256:9f3c1d7a…a71b', lockedAt:'2026-08-02T14:20:11Z',
  resultStandfirst:'Ranked by met tasks over expected executions. Conflicted and unreturned executions stay in the denominator.',
  entrants:[
    {id:'loadout-c',stack:'claude-x · harness 2.4 · full tools',note:'Adds retrieval and a repo-wide test step.',met:356,expected:500,score:71.1,conflicted:34,incomplete:22,cost:'$1,042.60'},
    {id:'loadout-a',stack:'claude-x · harness 2.4 · base tools',note:'Current released default.',met:312,expected:500,score:62.4,conflicted:29,incomplete:31,cost:'$611.20'},
    {id:'baseline',stack:'claude-x · harness 2.1 · base tools',note:'Prior release, unchanged.',met:290,expected:500,score:58.0,conflicted:25,incomplete:39,cost:'$530.30'}
  ],
  accounting:[{verdict:'met',count:958},{verdict:'unmet',count:362},{verdict:'conflicted',count:88},{verdict:'incomplete',count:92}],
  disagreements:[
    {taskId:'astropy__astropy-12907',resolution:'retained',evaluators:[{id:'ev/deterministic-tests',verdict:'met'},{id:'ev/rubric-b',verdict:'unmet',note:'Passes tests but changes public API shape.'},{id:'ev/rubric-c',verdict:'met'}]},
    {taskId:'django__django-16139',resolution:'majority',evaluators:[{id:'ev/deterministic-tests',verdict:'met'},{id:'ev/rubric-b',verdict:'met'},{id:'ev/rubric-c',verdict:'unmet',note:'Fix is scoped narrower than the issue.'}]}
  ],
  cite:[
    {id:'md',label:'Markdown',value:'[![colophon 71.1% · 500 tasks](https://colophon.press/b/hb-2026-08.svg)](https://colophon.press/r/hb-2026-08)'},
    {id:'html',label:'HTML embed',value:'<iframe src="https://colophon.press/r/hb-2026-08/embed" width="600" height="340" title="Colophon report"></iframe>'},
    {id:'cli',label:'CLI',value:'colophon clone hb-2026-08\ncolophon rerun hb-2026-08 --entrant loadout-c'},
    {id:'json',label:'Claim JSON',value:'GET https://colophon.press/r/hb-2026-08/claim.json\n\n{\n  "claim": "71.1% met on SWE-bench Verified (500 tasks)",\n  "method_digest": "sha256:9f3c1d7a…a71b",\n  "method_locked_at": "2026-08-02T14:20:11Z",\n  "expected_executions": 1500,\n  "returned": 1408,\n  "conflicted": 88,\n  "execution": "network-observed",\n  "report": "https://colophon.press/r/hb-2026-08"\n}'},
    {id:'bib',label:'BibTeX',value:'@misc{colophon_hb2026_08,\n  title  = {Three harness loadouts on the same 500 tasks},\n  author = {openharness/loadout},\n  year   = {2026},\n  note   = {Colophon report r/hb-2026-08},\n  url    = {https://colophon.press/r/hb-2026-08}\n}'}
  ],
  imprint:[
    {label:'Method',value:'sha256:9f3c1d7a…a71b · locked 2026-08-02T14:20:11Z'},
    {label:'Execution',value:'Network operators · observed by Colophon · 7 operators'},
    {label:'Evaluators',value:'ev/deterministic-tests, ev/rubric-b, ev/rubric-c (3 identities, majority; splits retained)'},
    {label:'Accounting',value:'1,500 expected · 1,408 returned · 88 conflicted · 92 not returned'},
    {label:'Recompute',value:'colophon rerun hb-2026-08'},
    {label:'Report version',value:'2 · amended 2026-08-05 to correct a cost total'}
  ]
};