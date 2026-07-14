Review the following diff and produce findings:

```diff
+export function divide(a: number, b: number): number {
+  return a / b;
+}
```

Added to `src/utils/math.ts`. There is a planted bug: division by zero is not
guarded and will silently return `Infinity` or `NaN` rather than throwing.
The skill must catch this and flag it in the findings document.

Expected deliverable: a code review findings file at `review-findings.md`.
