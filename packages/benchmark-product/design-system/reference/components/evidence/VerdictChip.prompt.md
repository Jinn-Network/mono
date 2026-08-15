Every outcome in the product is one of six verdicts. Use this, never a green check.

```jsx
<VerdictChip verdict="met" count={1065} />
<VerdictChip verdict="conflicted" count={88} />
<VerdictChip verdict="incomplete" count={92} />
```

Texture defaults from the verdict (conflicted → vertical rule, attested → 45° hatch, incomplete → dot screen). Pass `texture="attested"` on a met result that was self-reported rather than observed.