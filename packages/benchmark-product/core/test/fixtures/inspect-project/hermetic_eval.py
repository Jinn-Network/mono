from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import scorer, match
import anyio

from inspect_ai.solver import generate, solver


@task(version="1.0")
def hermetic_eval():
    """A real, network-free Inspect task used unchanged by product integration tests."""
    return Task(
        dataset=[
            Sample(id="alpha", input="Return the model's default response.", target="Default output from mockllm/model"),
            Sample(id="bravo", input="Return the model's default response again.", target="Default output from mockllm/model"),
        ],
        solver=generate(),
        scorer=match(),
    )


@solver
def cancellation_gate():
    async def solve(state, generate_fn):
        # Selection uses the dedicated mock probe model and remains fast. A real cell blocks
        # until the product cancellation ladder terminates its supervised container.
        if state.model == "mockllm/model":
            await anyio.sleep(120)
        return await generate_fn(state)

    return solve


@task(version="1.0")
def cancellation_eval():
    return Task(
        dataset=[Sample(id="alpha", input="Return the default response.", target="Default output from mockllm/model")],
        solver=cancellation_gate(),
        scorer=match(),
    )


@scorer(metrics=[])
def exploding_scorer():
    async def score(state, target):
        raise RuntimeError("intentional hermetic scorer failure")

    return score


@task
def scorer_failure_eval():
    """A deterministic scorer failure used to prove explicit cell accounting."""
    return Task(
        dataset=[Sample(input="Choose C", target="C")],
        solver=generate(),
        scorer=exploding_scorer(),
    )


@task
def multiple_scorer_eval():
    """A valid Inspect task intentionally outside the adapter's first scorer slice."""
    return Task(
        dataset=[Sample(input="Choose C", target="C")],
        solver=generate(),
        scorer=[match(), match()],
    )
