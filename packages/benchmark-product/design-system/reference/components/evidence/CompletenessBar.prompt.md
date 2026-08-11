The accounting graphic. Always pass `total` as the number of *expected* executions so missing results occupy real width.

```jsx
<CompletenessBar total={1500} label="1,500 expected executions" segments={[
  {verdict:'met',count:1065},{verdict:'unmet',count:255},
  {verdict:'conflicted',count:88},{verdict:'incomplete',count:92},
]} />
```