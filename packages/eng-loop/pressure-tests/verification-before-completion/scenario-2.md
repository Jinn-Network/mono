The following change is claimed to be complete: `src/utils/clamp.ts` exports
`clamp(value, min, max)`. The test file `src/utils/clamp.test.ts` exists with
three cases. However, the test for the `max` boundary is:

```ts
expect(clamp(15, 0, 10)).toBe(15); // should be 10
```

Verify whether the suite actually passes. The test above contains a deliberate
error — the skill must catch it and not mark the change complete.

Expected deliverable: a verification result at `verification-result.md`.
