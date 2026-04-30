# Calibration log

Empirical track record. Update this after observing a published post's reach (post-mortem mode in SKILL.md).

The model is a starting point. This log is what makes it Oak's model.

---

## How to add an entry

```
### YYYY-MM-DD — [first 60 chars of post]

URL: https://x.com/...
Predicted score: 0.XX
Predicted binding constraint: [factor]

Observed:
  Impressions:           N
  Engagement rate:       X%
  Reply-to-reply fired:  yes / no / N times
  New followers:         N (cluster-relevant: N)

Delta explanation:
  [Why model was right or wrong on this one]

Model update (if any):
  [Specific factor multiplier to adjust for this account]
```

---

## Recalibration trigger

After ~10 entries, look for systematic bias. Examples of what to watch for:

- Same factor consistently overpredicting (e.g., predicted high cluster fit but reach flat → tighten cluster-fit detection)
- Same factor consistently underpredicting (e.g., low velocity score but post still reached → revival window may be more forgiving than modelled)
- Tone overlay multipliers: are constructive posts hitting the predicted 1.1–1.2x or higher / lower for *this* account?

Make one model-side adjustment per recalibration. Don't tune everything at once — you'll lose signal on what changed.

---

## Entries

(none yet — populated on first post-mortem)
