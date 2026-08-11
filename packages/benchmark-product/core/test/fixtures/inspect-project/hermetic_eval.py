from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import scorer, match
from inspect_ai.solver import generate


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
