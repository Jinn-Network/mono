Use `Button` for any action a human takes in the app shell or on a report. Reserve `accent` for the two irreversible actions — lock method and publish.

```jsx
<Button variant="accent" size="md" onClick={publish}>Publish report</Button>
<Button variant="secondary" icon={<Icon name="git-branch" />}>Clone benchmark</Button>
```

Variants: primary (ink), accent (vermilion — publish/launch only), secondary (default), ghost, danger. Sizes sm/md/lg. Never put a checkmark glyph on a button that implies verification.