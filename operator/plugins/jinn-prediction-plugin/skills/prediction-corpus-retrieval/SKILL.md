# Prediction Corpus Retrieval

Use this skill when forecasting a `prediction.v1` Task with Network Tools available. The Prediction plugin supplies Polymarket market/orderbook tools; Network Tools supplies generic Jinn task, record, and artifact tools.

## Workflow

1. Call `get_task` first and anchor every lookup to the current Task. Extract the `solverType`, venue, question text, `conditionId`, `marketId`, token ids, expected resolution time, and consensus snapshot.
2. Call `polymarket_get_market` and `polymarket_get_orderbook` for the task's own market identifiers. Use them to verify the current market state, liquidity, spread, rules, and consensus probability.
3. Use `search_records` to look for prior Jinn corpus records relevant to the current Task. Prefer queries that include `prediction.v1`, the exact `conditionId`, the Polymarket venue, the market/question text, and resolution or category terms from the task.
4. Use `inspect_record` on the most promising record, envelope, or projection refs before relying on them. Search and inspect are read-only; they do not acquire artifacts and they do not create a payment.
5. Consider `acquire_artifact` only when the inspected record shows that full artifact contents are necessary for the forecast. Treat acquisition as explicit, optional, and price-aware. `acquire_artifact` is the only acquisition/payment path; search and inspect never buy or fetch full paid artifacts. Check the quoted price first, avoid paid acquisition unless the expected forecast value justifies it, and record why it was worth acquiring.
6. Forecast normally using task facts, Polymarket data, base rates, calibration, and the useful corpus evidence. Do not copy a prior probability blindly.

## Ranking Guidance

Prefer records that match the current task directly:

- exact `conditionId` match
- same venue/source, especially Polymarket
- same or very similar market/question text
- scored Verdicts with known outcomes and Brier results
- Solutions that cite their evidence clearly
- recent examples with comparable resolution windows, liquidity, spread, or market category

Also inspect failures, rejections, invalid Verdicts, and underperforming forecasts when they are task-relevant. They can warn about ambiguous rules, stale consensus snapshots, thin liquidity, bad search terms, or reasoning patterns that should not be repeated.

## Output Expectations

When corpus evidence affects the forecast, cite the relevant record, envelope, projection, or artifact refs in the reasoning. Separate current Polymarket evidence from prior Jinn corpus evidence, and state whether each prior record raised confidence, lowered confidence, or served as a warning.

Write `.execute/prediction-corpus-retrieval.json` when retrieval is attempted. Keep it as transparent run evidence, not hidden policy. Include the search intents or queries tried, records considered, refs inspected, records cited or used, acquired artifacts with price/payment metadata, forecast probability, consensus snapshot reference, and a short self-assessment of whether retrieval affected the forecast. Search and inspect remain read-only; only `acquire_artifact` should appear for explicit artifact acquisition.

When a later Debrief can connect the run to a Verdict, write `.debrief/learner-feedback.json` with the same retrieval/tool/skill usage plus Verdict or Brier feedback. Do not implement local optimization, ELO, hill-climbing, or strategy mutation inside this skill; the artifact is for future learners and builder-specific improvement systems.

Do not treat any plugin as protocol authority. Task schemas, Solution schemas, Verdict schemas, evaluation, and aggregation semantics come from the SolverNet contract registry. Plugins provide runtime tools and skills only.
