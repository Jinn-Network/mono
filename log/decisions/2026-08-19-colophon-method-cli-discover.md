# DR-2026-08-19 — Colophon method catalog discoverability

- **Date:** 2026-08-19
- **Status:** **Accepted 2026-08-19.** Ratified by operator instruction to
  implement the method-catalog discoverability train (issue
  [#2840](https://github.com/Jinn-Network/mono/issues/2840)).
- **Owning docs:** Colophon self-serve; the benchmark-product GTM plan (copy);
  Inspect runtime adapter notes; the web app spec; this file amends
  [DR-2026-08-18-f](./2026-08-18-colophon-method-cli.md).
- **Amends (at ratification):**
  [DR-2026-08-18-f](./2026-08-18-colophon-method-cli.md) Decision 3 (coverage
  flags) and Decision 9 (GUI catalog unavailable);
  [`docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md`](../../docs/superpowers/plans/2026-08-10-benchmark-product-gtm-plan.md)
  §8.3;
  [`spec/2026-08-13-colophon-self-serve.md`](../../spec/2026-08-13-colophon-self-serve.md)
  §5.5;
  [`packages/benchmark-product/INSPECT-RUNTIME.md`](../../packages/benchmark-product/INSPECT-RUNTIME.md);
  [`packages/benchmark-product/web/BENCHMARK-PRODUCT-WEB-SPEC.md`](../../packages/benchmark-product/web/BENCHMARK-PRODUCT-WEB-SPEC.md)
  §3.2.
- **Does not amend:** `GROWTH.md`.
- **Does not rename:** sealed `SUITE_COVERAGE`; `inspect`; `lock`; `export`.
- **Does not add:** a one-shot `colophon run` verb; unified `-d/-a/-m` host
  flags; folding `import swebench` into `method`.

## Context

DR-2026-08-18-f made one `method` operand the bind grammar. Operators still
could not list the catalog, read per-suite `--host` keys, pick an arbitrary
count, mix flags with the operand, or bind a named suite from the GUI. Field
CLIs expose discovery and a dry-run; Colophon's dry-run is already `doctor`
then `quote`. Inventing `run` would hide lock-before-paid.

## Decisions

1. **`colophon method` with zero operands lists the catalog.** Human table of
   id / protocol / framework / derived export. `--json` is
   `{ ok: true, result: { catalog: [...] } }`. List is CLI-only (no facade
   operation, parity stays 40). No `--workspace` / `--principal` / `--draft`.

2. **Verb-specific help.** `--help` or `help <verb>` on a known verb prints
   that verb's help, not the 40-verb USAGE. `method --help` names the five
   catalog ids, each row's `hostKeys`, `--slice` / `--ids` / `--n` / `--host`,
   doctor → quote → lock → launch as the dry-run-then-paid path, and that
   `import swebench` is homemade instance rows while `method swe-bench-verified`
   is the official protocol.

3. **Failed ref names known ids.** `"x" is not a suite and not a file; known
   catalog ids: …`.

4. **`--host` stays the pin file.** Suites do not share one honest
   `-d/-a/-m` grammar. Catalog rows publish `hostKeys`. `--host` remains
   required for a catalog id.

5. **`--n <positive integer>` is first N from the host registry.** Inventory
   comes from `host.registryMetadataPath`, code-point sorted like
   `namedSliceTaskNames`. Sealed coverage uses `coverageFromSelectedNames`
   (`--n 1` → `one_task`, `--n 10` → `ten_task`, N = dataset size → `full`,
   else `custom`). Mutually exclusive with `--slice` and `--ids`. N larger
   than the inventory refuses. `--n` is catalog-id only. Sealed enum names
   are unchanged.

6. **GNU-style flag mix is global.** Positionals and flags may interleave;
   `--` terminates flags. Boolean flags (`help`, `json`,
   `include-native-artifacts`, `ack-provider-network-costs`) never consume
   the next positional. Flags-last remains legal.

7. **No `colophon run`.** Doctor + quote is the dry-run. Guided self-serve
   remains `colophon open` / Use my work.

8. **GUI catalog bind is available.** The draft page ships two `method.bind`
   forms: catalog (suite id, host JSON, slice/n/ids) and Inspect document.
   Submitting both refuses. Same machine-path trust as the Inspect textarea.
   Derived export stays unavailable.

9. **`import swebench` stays.** Homemade rows vs official Verified are
   labeled, not collapsed.
