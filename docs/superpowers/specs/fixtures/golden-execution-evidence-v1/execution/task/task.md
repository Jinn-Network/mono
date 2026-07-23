# Implement deterministic slug normalization

Update `src/slug.ts` so `normalizeSlug`:

- lowercases ASCII text;
- replaces each sequence of non-alphanumeric characters with one hyphen;
- removes leading and trailing hyphens; and
- returns an empty string when no alphanumeric characters remain.

Add regression tests for repeated separators, surrounding punctuation, and punctuation-only input.
Do not add dependencies or change unrelated behavior.
