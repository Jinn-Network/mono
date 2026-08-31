# Unparseable judge-response fixtures

Exact judge-response bytes replayed by
`src/run/unparseable-judge-join.integration.test.ts`. `live-prose-then-fence.txt` is the response
shape recorded on the official LoCoMo judge run at cell 535 of 4,320 (attempt
`218889b0-9913-47f8-a0b3-fe09e054909e`): prose followed by a fenced JSON verdict, which the v2
fence grammar correctly refuses, and which — before the sealed abstain EvaluationSpec landed — was
refused at delivery by the harness's verdict-consistency check and permanently lost the cell. These
files are bytes, not text: they carry no trailing newline, and any edit changes their digest and can
silently change whether a shape parses. Keep them byte-exact.
