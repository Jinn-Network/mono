# .codespec Directory

This directory contains runtime state for the CodeSpec automation system.

## Files

- **ledger.jsonl** - Append-only violations database (JSONL format)
- **suppressions.yml** - Suppressed violations with justifications
- **owners.yml** - Default ownership assignments for violations
- **worktrees/** - Temporary git worktrees for autofix isolation

## Ledger Format

The ledger uses JSONL (JSON Lines) format where each line is a complete JSON object representing a violation or status update.

For the latest version of any violation, the ledger is read and deduplicated by fingerprint, keeping only the most recent entry (by `last_seen` timestamp).

## Worktrees

Git worktrees are created in `worktrees/` for autofix isolation. Each worktree:
- Has a unique branch name: `codespec/fix-{violation-id}`
- Allows multiple fixes to run in parallel safely
- Is deleted after PR is merged or fix is abandoned

## Maintenance

- Keep ledger.jsonl backed up (contains full violation history)
- Review suppressions.yml periodically (check expiry dates)
- Clean up abandoned worktrees: `git worktree prune`
