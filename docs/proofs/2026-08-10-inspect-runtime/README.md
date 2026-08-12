# Inspect runtime adapter proof — 2026-08-10

This directory retains evidence from a manual, credential-free Benchmark Product run through the real Inspect `0.3.255` runtime. It is independent of the automated test assertions: the built product CLI created, previewed, quoted, locked, launched, collected, reported, verified, and published the run.

A separate opt-in external-provider check is recorded in [luna-smoke.md](luna-smoke.md). That smoke used Luna through Inspect directly and deliberately does not claim that the Benchmark Product forwards provider credentials.

## What this proves

- A real Inspect task executed through the Benchmark Product runtime adapter without translation into a Jinn-native solver or scorer.
- Two benchmark arms with two repetitions produced four expected Jinn Matrix cells. All four were accounted for and judged.
- Inspect produced four genuine native `.eval` logs. Inspect's official `read_eval_log()` API accepted every log and read eight samples in total.
- Inspect View `0.3.255` generated a viewer bundle from the retained logs.
- The published Jinn bundle verified after its originating workspace path had been removed.
- Altering one byte of a native `.eval` artifact caused portable verification to fail with a digest mismatch.
- A scan of decoded Inspect logs and every other retained file found no home-directory path, username, credential path, token-shaped value, environment secret, or private key.

The retained [portable bundle](bundle/) is the exact detached bundle that passed those checks. Its `bundle.json` SHA-256 is `d5851073580eecd5c05e1fcdd3887aa88dad61c51335a55fc5195629fe8d7365`.

## Run shape

- Runtime: Inspect AI `0.3.255` on Python `3.11.0`
- Product host: Node.js `22.23.1`
- Task: `packages/benchmark-product/core/test/fixtures/inspect-project/hermetic_eval.py@hermetic_eval`
- Model provider: Inspect's credential-free `mockllm/model`
- Scorer: the task's Inspect `match()` scorer
- Arms: `control`, `candidate`
- Repetitions per arm: `2`
- Expected and judged cells: `4`
- Native logs: `4`
- Samples read by Inspect: `8`
- Report outcome: complete; both arms have `n = 2`
- Assurance disclosure: self-run, same-execution Inspect scoring; no independent evaluator is claimed

See [provenance.json](provenance.json) for record identities, native artifact digests, source-state fingerprints, and the complete check summary.

## Re-verify the retained evidence

Build the Benchmark Product core, then run the portable verifier from the repository root:

```sh
node packages/benchmark-product/core/dist/cli/bin.js bundle verify \
  --bundle docs/proofs/2026-08-10-inspect-runtime/bundle \
  --json
```

With Inspect AI `0.3.255` installed, validate the native logs through the official reader:

```sh
python - <<'PY'
from pathlib import Path
from inspect_ai.log import read_eval_log

root = Path("docs/proofs/2026-08-10-inspect-runtime/bundle/native/inspect")
for path in sorted(root.glob("*.eval")):
    log = read_eval_log(path)
    assert log.status == "success", (path, log.status)
    print(path.name, log.status, len(log.samples or []))
PY
```

Generate a disposable official viewer bundle:

```sh
inspect view bundle \
  --log-dir docs/proofs/2026-08-10-inspect-runtime/bundle/native/inspect \
  --output-dir /tmp/jinn-inspect-proof-view
```

The generated viewer was not retained because it is a derived 9.9 MB presentation of the four retained logs.

## Proof boundary

This run deliberately used no network, external model, API key, or ChatGPT/Codex subscription. It proves the Inspect runtime and Jinn evidence path, not the deferred subscription-authentication boundary or the behavior of a real external model. Because this is a self-run venue, it also does not prove operator independence or defend against a malicious operator rewriting evidence before publication.

The native logs are retained here intentionally: they contain only the repository's public hermetic fixture and mock responses, passed the recorded secret scan, and were explicitly included in the public bundle for this proof.
