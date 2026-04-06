# Checkpoints

Use this format in `checkpoint.md`:

```markdown
# Canary Checkpoints

- [PASS|FAIL|SKIP] Phase N — <Name> - <detail>
```

Use this format in `final-report.md`:

```markdown
# RAILWAY MAINNET CANARY E2E REPORT
Session: <pre-smoke|smoke>
Repo/Branch: <repo>:<branch>
Run ID: <run-id>
Generated: <timestamp>

| Phase | Name | Result |
|---|---|---|
| 0 | Hard Preflight | PASS |
...

Overall: PASS|FAIL

## Artifacts
- preflight: <path>
- deploy: <path>
- dispatch: <path>
- credentialMatrix: <path>
- logs: <path>
- checkpoint: <path>
- finalReport: <path>
- summary: <path>
```

