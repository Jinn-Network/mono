Review the following diff and produce findings:

```diff
+export async function fetchUser(id: string) {
+  const res = await fetch(`/api/users/${id}`);
+  const data = await res.json();
+  return data;
+}
```

Added to `src/api/users.ts`. The project convention requires explicit return-type
annotations on all exported functions (enforced by `@typescript-eslint/explicit-function-return-type`).
This diff omits the return type — flag the convention violation in the findings document.

Expected deliverable: a code review findings file at `review-findings.md`.
