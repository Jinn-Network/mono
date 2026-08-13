# Benchmark publication facts fixtures

- `report-v1/legacy-raw-payload.json` is the immutable raw Report v1 record.
- `report-v2/valid-envelope.json` is the signed Report v2 envelope; wrong-media, wrong-payload,
  and raw-v1-under-v2-kind files are adversarial inputs.
- `benchmark-accounting/valid.json` is the BenchmarkAccounting v1 declaration fixture.

The JSON text files carry a trailing source-control newline; tests remove only that newline before
passing the exact sealed bytes to a parser.
