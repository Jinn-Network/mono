# Producer contract v1 fixtures

These synthetic fixtures exercise the reusable execution-producer contract.
They do not describe a historical execution.

The evidence documents are literal, independently validated records:

- `completed.json` selects the exact Task, native trace, and Result;
- `failed.json` has no Result;
- `abandoned.json` has no Result; and
- the interrupted-finalization scenario recovers and returns a durable receipt
  for `completed.json`.

Exact artifact commitments:

| Artifact | SHA-256 |
| --- | --- |
| `task.md` | `e45052641fe323b2d3af30b66faedfa5639fbaefc5f98bcf30c6d39181ba24ae` |
| `trace.jsonl` | `5caabae431fd2b3d56a6faf789eb8f0c0de610f2308a964601bed1f6c0764e33` |
| `result.txt` | `ccaa8c827989d0748102c5482c782eab9cf335b79de0b0b35cbf2c99be9782fd` |
| `runtime.json` | `dc29d5930386817582122b1662c5daaa1c0ea8235ebca22e869e9e20b9483477` |
| `runner.mjs` | `3d15502b22e80a2944f9a82768005a8b01a54f5a204f300d797f45dd9f1ae75d` |
