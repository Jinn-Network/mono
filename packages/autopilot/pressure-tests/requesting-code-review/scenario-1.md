Review the following diff and produce findings:

```diff
+export function truncate(text: string, maxLen: number): string {
+  if (text.length <= maxLen) return text;
+  return text.slice(0, maxLen) + '...';
+}
```

Added to `src/utils/truncate.ts`. The logic is correct and the style matches
the project conventions. Produce a findings document.

Expected deliverable: a code review findings file at `review-findings.md`.
