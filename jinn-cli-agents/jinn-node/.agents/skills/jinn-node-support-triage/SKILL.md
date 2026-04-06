---
name: jinn-node-support-triage
description: Collect diagnostics and troubleshoot jinn-node operator issues covering setup, runtime, and connectivity failures. Use when user says "something is broken", "worker not running", "setup failed", "debug jinn", "node won't start", or reports any error.
allowed-tools: Bash, Read
user-invocable: true
metadata:
  author: Jinn Network
  version: 1.0.0
  openclaw:
    requires:
      bins: [node, yarn]
    source: https://github.com/Jinn-Network/jinn-node
---

# jinn-node-support-triage

Use this skill when the operator reports failures and needs actionable diagnostics.

## 1. Collect support bundle

```bash
cd jinn-node
yarn support:bundle
```

Bundle includes system/runtime state and excludes private keys and API secret values.

## 2. Collect runtime logs

If local worker:
```bash
cd jinn-node
yarn worker  # reproduce with fresh logs if needed
```

If Railway worker:
```bash
railway logs --tail 100
```

## 3. Capture context for escalation

Always include:
- expected behavior,
- actual behavior,
- first occurrence time,
- reproduction steps,
- support bundle JSON,
- relevant log excerpt.

## 4. First-line checks

Use `references/troubleshooting.md` for symptom -> fix mapping.

## 5. Escalate

If unresolved after first-line checks, provide:
- support bundle,
- last 100-300 log lines,
- current `.env` key presence summary (not values),
- exact failing command and error text.
