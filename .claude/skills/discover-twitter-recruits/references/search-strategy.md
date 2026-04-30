# Search strategy — bird CLI invocations and search vocabularies

Companion to the `discover-twitter-recruits` skill. Concrete commands, the vocabularies that have worked, and the named anti-patterns to avoid. Read once at session start.

## §1. Anti-patterns — what catches the wrong audience

These query shapes have been tried and produced shill / consultant / bot results, not recruits. Avoid by default.

| Query shape | Failure mode |
|---|---|
| `bird search "decentralized AI agents min_faves:30"` | Catches token-pumpers and crypto-AI launch accounts. High like-counts in this vocabulary correlate with shill audiences, not builder audiences. |
| `bird search "agent economy"` | Generic vocabulary appropriated by token launches. ~90% of results are promotional content with $TICKER preludes. |
| `bird search "agentic future architecture"` | Catches enterprise consultants writing CIO-register thinkpieces. |
| `bird search "agent ownership / value capture"` | Catches VC analysts and "AI x crypto" thread-writers. |
| `bird search "<thesis quote verbatim>"` | Catches accounts whose entire output is rephrased landing-page copy. |

The common failure mode in all five: thesis vocabulary is now broadly ambient. Searching for it surfaces the people *talking about* the space, not the people *building in* it.

## §2. Working vocabularies

Builder-shaped queries that have produced real recruits in past sessions.

### §2.1 — Builder vocabulary (functional shape)

```
bird search "agent registry -filter:replies lang:en"
bird search "agent observability -filter:replies lang:en"
bird search "agent benchmarking -filter:replies lang:en"
bird search "evaluation framework agent -filter:replies lang:en"
bird search "eval signal agent -filter:replies lang:en"
bird search "ground truth agent -filter:replies lang:en"
```

Why it works: these terms are insider vocabulary of the people building verification, evaluation, and registry tooling. Token-pumpers don't use "eval signal" because there isn't a token to attach to it.

### §2.2 — Audience-name vocabulary (project-specific)

```
bird search "olas pearl -filter:replies lang:en"
bird search "olas mech operator -filter:replies lang:en"
bird search "trader quickstart -filter:replies lang:en"
bird search "bittensor subnet operator -filter:replies lang:en"
bird search "numinous prediction -filter:replies lang:en"
bird search "polymarket bot -filter:replies lang:en"
bird search "prediction subnet -filter:replies lang:en"
bird search "autoharness OR \"agent eval harness\" -filter:replies lang:en"
```

Project names self-select for the orbit. "Pearl" matches OLAS operators; "Numinous" matches forecasting subnet users; "Tau2" or "HAL" matches agent-benchmark builders.

### §2.3 — Cross-reference queries (replies and mentions)

```
bird search "@autonolas activity -filter:replies lang:en"
bird search "to:autonolas <topic>"
bird search "@numinous_ai -filter:replies lang:en"
bird search "@opentensor subnet"
bird search "@a16zcrypto agent"
```

These surface the *audience* of trusted accounts, which is denser in real builders than open search by topic.

## §3. Profile-check commands

Once a candidate is surfaced, run all three before recommending:

```
bird user-tweets <handle> -n 10 --plain
bird about <handle> --plain
bird read <url-of-the-on-thesis-post> --plain
```

What to look for:

- `user-tweets` — confirm a *posting pattern*. Real builder: weeks of work-in-progress posts, replies to others' substance, occasional thread of methodology. Bot/shill: identical-shape posts every day at similar times, no replies, hashtag stacks.
- `about` — geographic and account-creation signals. Look for incoherence (UK builder posting Solana shill register, recent account, etc.).
- `read` — engagement count on the surfaced post. Likes, replies, quote-tweets. A post with 0 engagement from an account with 10k followers is a bot signal; a post with 1 like from an account with 200 followers is a real-builder signal (high signal-per-follower).

## §4. Bot and shill detection patterns

Reject any account matching these. Detection is *before* recommendation, not after — preventing the `@gingersamurai` regression (recommended on the basis of one perfect ERC-8004 critique, later identified as an OpenClaw agent via 🦞 sign-off and one-shot-zinger pattern).

| Pattern | Confidence |
|---|---|
| `🦞` sign-off in posts | HARD — OpenClaw agent. |
| One-shot zinger pattern (every post a contrarian fragment, no replies anywhere in feed) | HIGH — bot or LLM-driven account. |
| Hashtag stacks (`#AgenticAI #AI #ML #Web3 #Crypto`) | HIGH — automated or low-effort posting. |
| Marketing register: "we are so early", "this is a game changer", "the future is...", "bullish doesn't even cover it" | HIGH — promotional account, not builder. |
| Token-ticker preludes (`$XYZ`, `CA: 0x...`) | HARD — shill. |
| Identical post structure across many accounts on the same topic | HARD — shill ring. |
| Reply count to others' substantive posts: zero | HIGH — bot. Real builders engage. |
| Disconnect between bio claim and posting pattern (claims to ship X, posts only takes about X) | MEDIUM — likely analyst, not builder. |

## §5. The two-pass approach

Most discovery sessions benefit from two passes:

**Pass 1 — wide.** Three to five queries from §2 to surface a long candidate list. Don't filter heavily yet; just collect.

**Pass 2 — deep.** Run the §3 profile-checks against each candidate. Reject everyone failing §4. Re-rank survivors by audience-profile fit.

Don't conflate the passes. The first pass needs breadth; the second pass needs strictness. A combined "broad-and-strict" search misses real candidates by over-filtering on shallow signal.

## §6. When the search is wrong-shaped

Stop a discovery session early if:

- Three consecutive queries return >70% out-of-scope results.
- The queries are returning the same accounts repeatedly (search saturation — the audience has been mapped already; further work is in `discovery-log.md`).
- The user's stated topic does not map to any §2.1, §2.2, or §2.3 vocabulary. Ask once which audience they are aiming at, or surface that no recruitable audience exists for the topic.

The skill's value is *what it doesn't recommend* as much as what it does. Returning three real candidates with the audit trail beats returning eight padded ones.
