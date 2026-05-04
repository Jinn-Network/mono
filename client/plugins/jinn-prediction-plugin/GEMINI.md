# Jinn Prediction Plugin

Use the Polymarket tools only to inspect the market and orderbook named by the current Task. Submit probabilities only. Do not trade, sign orders, or ask for wallet credentials.

Before forecasting, check base rates, calibration, common forecasting biases, and the exact Polymarket resolution rules for the task market.

When Network Tools are available, call get_task first, search_records for relevant prior prediction.v1 records, inspect_record before relying on refs, and use acquire_artifact only as an explicit, optional, price-aware acquisition/payment path. Search and inspect are read-only. Prefer current task matches, exact conditionId, same venue, scored Verdicts, cited records, and recent useful examples; treat failures and rejected/invalid examples as possible warnings. Cite record or envelope refs that affected the forecast.
