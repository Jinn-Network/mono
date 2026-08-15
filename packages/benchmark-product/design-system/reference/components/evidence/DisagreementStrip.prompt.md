Publishes evaluator disagreement instead of hiding it.

```jsx
<DisagreementStrip taskId="astropy__astropy-12907" resolution="retained" evaluators={[
  {id:'ev/deterministic-tests',verdict:'met'},
  {id:'ev/rubric-b',verdict:'unmet',note:'Patch passes tests but changes public API shape.'},
]} />
```

Never label an evaluator "correct". The identities produced verdicts; the resolution policy decided what the report records.