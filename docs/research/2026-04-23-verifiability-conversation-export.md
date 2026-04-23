The distinction is now spelled out in the doc so the next reader (or you, in three weeks) doesn't have to rederive it. The one-sentence version worth remembering:

TEE attestation proves which code ran, not what the code produced. That's why it works for non-deterministic agents where zk doesn't.

 ---- but couldn't we apply zk to the same build criteria as tee? 

Good question and it gets at something real. The short answer: no, because zk and TEE are doing structurally different things despite superficially sounding similar. Let me walk through why.

TEE is an identity claim. zk is an execution claim. That's the core of it.

A TEE attestation quote says: "Hardware watched code with measurement M run in real-time on the CPU. Here's my hardware-signed attestation that this happened." The hardware doesn't re-execute anything, doesn't simulate, doesn't need to understand what the code does. It just watches and signs.
A zk proof says: "I know a valid execution trace of program P such that hash(P) = M and the trace produces output O." There is no zk primitive for "watch this code run and sign off on it." The proof is a re-execution of the code inside a proof-system-friendly VM, with every instruction, memory access, and branch witnessed.
Once you see this split, the question becomes: can zk prove "code M ran" without proving an execution trace? And the answer is no — "proving code ran" in zk always decomposes into "proving an execution trace of code matches some output," because that's what the proof primitive is. There's no shortcut where zk just identifies which code ran. That's what hardware attestation is for, and zk doesn't have an equivalent.

Why this matters for non-deterministic agents.

You can technically prove execution of non-deterministic programs in a zkVM — SP1, RISC Zero, etc. all support this. The trick: non-deterministic inputs (network calls, randomness, time, LLM responses) get treated as witness data that the prover supplies. The zkVM proves "the execution is consistent with these witnessed inputs."

But here's what that actually gives you for an agent:

Prover: "Here's my proof that program P ran and produced trajectory T,
         assuming Anthropic returned response R at step 1, market
         state S at step 2, and LLM response R' at step 3."
Verifier: "Okay, but where did R, S, R' come from?"
Prover: "I put them in as witnesses."
Verifier: "...so you chose them."
Prover: "...yes."
The zk proof is a conditional statement: "if those were the real non-deterministic inputs, then execution would produce T." But the prover picks the inputs. Nothing stops them from feeding in fabricated Anthropic responses, because the zkVM has no way to call Anthropic — the network is outside the proof.

So zk doesn't solve authenticity for non-deterministic external inputs. It shifts the problem to "how do we know the witnesses are real?" — which is exactly the same TLS-transcript / attestation / provider-signature question TEE faces. zk doesn't give you any better tool for this.

TEE is different because execution is native and real-time, not re-simulated.

When the enclave makes a TLS call to api.anthropic.com, the call hits a real Anthropic server, gets a real response, and the TLS keys are inside the enclave so the parent host can't tamper with the bytes. The attestation quote commits to the measured code — and because the code ran natively with real network I/O, the response bytes are whatever Anthropic really sent. No witness-selection, no prover-chosen inputs, no simulation gap.

In zkVM world the equivalent call doesn't exist. The zkVM can't make live network requests; it's a pure computation machine. Any network I/O has to be pre-recorded into witness data by the prover before proving begins. The "proof of execution" then runs over that recorded tape.

So zk can't replicate TEE's role even if we wanted it to. It's not a performance issue; it's a structural one. There's no zk mechanism that gives you "real-time attestation of native execution with live external I/O." That's what TEEs uniquely provide, and it's precisely what open-ended agent execution needs.

Where zk does work. It's not useless — it works beautifully for pure deterministic kernels where the "live external I/O" problem doesn't exist. The evaluator kernel is the textbook case: inputs are fixed (manifest hash, venue snapshot, spec), computation is pure, no network calls during scoring, output is verdict+score. zkVM simulates it faithfully because there's nothing to witness and no non-determinism to smuggle in. This is why the doc keeps zk as a V3+ insurance layer for the evaluator — deterministic kernel, tractable proof.

Performance as the secondary nail in the coffin. Even if the structural problem somehow went away, the zkVM overhead for an LLM agent would be enormous. Realistic zkVM proving is ~10,000× slower than native for general computation. An agent that takes 5 minutes of real execution would be ~35 days of proving, versus 20-40% overhead for TEE. You could pay for TEE infra and ship; you couldn't pay for that zk bill and have a business.

One-line summary:

TEE: "Hardware watched real code run on real hardware with real I/O and signed what it saw." zk: "I re-simulated the code in a pure computation VM and can prove the trace, but anything outside the VM has to be witnessed-in by me."

For agents that actually hit Anthropic and Hyperliquid, you want the first. There is no zk equivalent of "watch and sign."

I don't think this needs a doc edit — the doc already asserts the conclusion (TEE for open-ended runtimes, zk for deterministic kernels) and you were pushing on why. Happy to add a short appendix if you want the reasoning captured in the note itself for future readers, but I'd rather not bloat the main argument with it unless you think it's worth having.

----what are your thoughs on the zk component of this then ? 2026-03-23-jinn-implementation-spec-proposal.md

Reading this carefully — the ZK component in Oak's spec has one genuinely good idea, one good economic pattern, and one conceptual gap that's doing more work than it should. Let me break them apart.

The good idea: zkTLS for external interactions
§7.2 Phase 2+ step 3: "For external interactions (API calls, state reads), zkTLS attests that the data came from a real server interaction."

This is real and correctly scoped. zkTLS (Reclaim, DECO, TLSNotary, Pluto) proves "these bytes came over a TLS session from api.anthropic.com" without trusting the operator. It's the right tool for authenticating the edges of an execution — the I/O points where the agent touches the outside world. Nothing I've been arguing about TEE changes this; zkTLS and TEE compose well.

I'd actually push this one harder than Oak does. zkTLS over Anthropic/OpenAI/Hyperliquid calls is the closest thing to a solution for the LLM-call seam the verifiability doc keeps flagging. It belongs in the architecture regardless of whether the broader frame is optimistic or TEE-attested.

The good pattern: optimistic with challenge bonds
§7.2 Phase 0–1: submit without proofs, anyone can challenge, challenger bonds, operator must produce a proof of the disputed checkpoints under challenge.

The economic shape is right and well-precedented (Morph, Arbitrum Bold, Optimism's fault proofs all share the structure). Happy path free, unhappy path forces the expensive verification. For Jinn specifically, the fact that the evaluation layer already catches "didn't actually do the work" means the challenge mechanism only has to catch "faked the evidence," which is a narrower slice.

The gap here is what the gap is in every optimistic-challenge system: the challenge mechanism is only as strong as what the proof-under-challenge actually proves. And this is where the spec gets thin.

The conceptual gap: what is the zkVM proving?
§7.2 Phase 2+ step 4: "A zkVM guest program (SP1, RISC Zero, or future alternatives) proves claims about the checkpoint data and commits a hash."

"Claims about the checkpoint data" is doing a lot of work in that sentence, and I think if you pin down what specifically, you find that the zkVM doesn't actually give you what the prose reads like it gives you.

Read the architecture carefully:

"Agent runs freely — any model, any harness, any strategy. Execution is unconstrained."
"The harness captures checkpoints at meaningful operations."
zkTLS for external interactions.
"A zkVM guest program proves claims about the checkpoint data and commits a hash."
Step 1 says the agent runs outside any zk-friendly environment. Step 2 says a harness records what happened. Step 4 says a zkVM proves things about what the harness recorded. But the zkVM can only prove properties of the recorded data — not that the agent really produced it. The agent ran outside the proof system; the proof system has no way to reach back and verify the harness wasn't lying.

Concretely, what could the zkVM prove about checkpoint data?

Well-formedness of the schema — trivially provable, toothless as integrity (you can always produce well-formed fabricated data)
LSH hash of the evidence — provable, but same objection; fabricated evidence hashes just fine
Aggregation across zkTLS transcripts — useful, but this is really zkTLS doing the work, not the zkVM
Consistency between checkpoints and some external oracle — possible but limited in scope
That the execution trace is a valid execution of the agent program — this would be meaningful, but requires running the agent inside the zkVM, which contradicts step 1
The spec reads like it's aiming for the last one ("proves the execution") but the architecture (agent runs freely) only supports the first few (proves properties of what the harness recorded). That gap is structural, not fixable with a better zkVM.

This is the same issue from our earlier conversation: zk proofs of non-deterministic execution with unrestricted I/O treat all the non-deterministic bits as witness data chosen by the prover. An operator who fabricates a plausible checkpoint sequence can feed those fabrications in as witnesses and get a valid zk proof that says "if these witnessed inputs really happened, then this computation is consistent" — without the proof ever establishing that the witnessed inputs really happened.

What this means for the challenge mechanism
If the zkVM proof under challenge is "prove well-formedness of the checkpoint schema," the challenge is toothless — operators who fabricate evidence produce well-formed fabrications.

If it's "prove the agent really executed this trajectory," the architecture doesn't support that proof.

If it's "prove the external I/O claimed in the checkpoints really happened" (via zkTLS), the challenge is real but limited — it catches fabricated API calls but not fabricated reasoning between them. For live-money intents like portfolio.v0 this might be enough (venue-observable trades are anchored to chain/venue state). For training-data intents where the reasoning is the product, it isn't.

What's missing: authentication of the middle
The architecture zkTLS-authenticates the edges and (potentially) proves properties of recorded checkpoints, but leaves the agent's reasoning between tool calls completely unauthenticated. The operator says "at step 5, my agent thought X and decided to Y." There's no mechanism in Oak's spec that stops them from fabricating that thought.

This is exactly the gap the verifiability doc has been arguing TEE fills. TEE attestation binds the execution to the measured code — which means the harness, the agent, and the reasoning between I/O points are all inside the trusted boundary. zk of checkpoints alone cannot get there, because the reasoning happens outside the proof.

Reconciling the two frames
I'd push for a revised Phase 2+ that swaps the roles. Keep the phasing intact:

Phase 0–1 (as specified): optimistic evidence + zkTLS for external I/O. Cheap, narrow guarantees, correctly scoped. This is exactly right for a small-N operator community.
Phase 2+ (the swap): TEE-attested execution as the trajectory-integrity primitive, with zkTLS still authenticating external I/O inside the enclave. The trajectory-authentication job belongs to hardware attestation, not zkVM. zk stays in the system for:
zkTLS at the edges (authenticates external I/O into the trajectory)
Optional evaluator-kernel proofs as a V3 insurance layer (the doc's position)
On-chain verification of zkTLS / evaluator proofs (~250k gas claim transfers cleanly to this, as verification cost is the same regardless of what's proven)
What gets kept from Oak's spec:

The phased-integrity principle (optimistic → stronger over time)
The challenge-with-bonds economic model
zkTLS as an explicit component
The "agent runs freely, any harness, any model" commitment (preserved by the envelope/implementation split the doc now describes)
What gets corrected:

"zkVM proves claims about checkpoint data" → "TEE attests the harness measurement and produces the trajectory; zkTLS authenticates external I/O"
The implicit claim that zk alone can authenticate agent execution
The cost framing (250k gas is verification, not proving; TEE's economics are much better for proving and similar for verification)
Two concrete items the spec should clarify
"Claims about the checkpoint data" needs to be spelled out. Right now it's a phrase that can mean anything from "well-formed" (trivial) to "the execution really happened" (impossible). The design decision is which of those the challenge mechanism actually forces. Without pinning this down, Phase 2+ is under-specified.

Challenger bond design for agent execution specifically. Challenge mechanisms work when the challenge target is concrete and provable-or-disprovable. "Prove your checkpoints are real" isn't that — there's no ground truth for reasoning steps. "Prove your claimed Anthropic API calls are real" is concrete (zkTLS). "Prove your claimed venue trades are real" is concrete (chain state). The spec should be explicit about which pieces of evidence are challengeable and what the proof obligation is for each.

Net: the spec's ZK section is more ambitious than the underlying mechanism supports for agent trajectories, but the scaffolding (phased integrity, optimistic-with-challenge, zkTLS) is sound. I'd keep the scaffolding and swap the integrity primitive from zkVM-of-checkpoints to TEE-attestation-of-execution. That lines up with what the verifiability doc has been arguing and with the envelope/diversity thesis we landed on in the last couple of turns.

Want me to draft the concrete edits that would reconcile Oak's spec with the TEE frame, or would you rather keep this as analysis for now and have the conversation with Oak first?
