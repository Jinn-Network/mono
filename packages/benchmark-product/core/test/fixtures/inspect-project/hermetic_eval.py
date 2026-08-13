from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import CORRECT, INCORRECT, Score, scorer, match
import anyio
import os
from pathlib import Path
import socket
import json

from inspect_ai.util import sandbox

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


@task(version="1.0")
def broker_text_eval():
    """One public ModelAPI call and deterministic score for the fake-broker OCI proof."""
    return Task(
        dataset=[Sample(id="alpha", input="Return exactly C.", target="C")],
        solver=generate(),
        scorer=match(),
    )


@solver
def credential_isolation_probe(host_sentinel_path: str):
    async def solve(state, generate_fn):
        environments = Path("/proc/self/environ").read_bytes() + Path("/proc/1/environ").read_bytes()
        assert b"OPENAI_API_KEY" not in environments
        assert b"BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE" not in environments
        for forbidden in [
            "/run/secrets",
            "/var/run/docker.sock",
            host_sentinel_path,
        ]:
            assert not Path(forbidden).exists()
        try:
            socket.create_connection(("api.openai.com", 443), timeout=1)
        except OSError:
            pass
        else:
            raise AssertionError("worker unexpectedly has direct provider egress")
        return await generate_fn(state)

    return solve


@task(version="1.0")
def broker_isolation_eval(host_sentinel_path: str):
    """Malicious-code fixture: probes the worker boundary, then uses the unchanged model/scorer path."""
    return Task(
        dataset=[Sample(id="alpha", input="Return exactly C.", target="C")],
        solver=credential_isolation_probe(host_sentinel_path),
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
def multiple_scorer_failure_eval():
    """One native scorer failure makes the selected multi-scorer claim unscorable."""
    return Task(
        dataset=[Sample(input="Choose C", target="C")],
        solver=generate(),
        scorer=[correctness_scorer(), exploding_scorer()],
    )


@task
def multiple_scorer_eval():
    """A valid Inspect task with two independently named native scorer outputs."""
    return Task(
        dataset=[Sample(input="Choose C", target="C")],
        solver=generate(),
        scorer=[correctness_scorer(), policy_scorer()],
    )


@scorer(metrics=[])
def correctness_scorer():
    async def score(state, target):
        return Score(value=CORRECT, answer=state.output.completion)

    return score


@scorer(metrics=[])
def policy_scorer():
    async def score(state, target):
        return Score(value={"safe": True, "relevant": True}, answer=state.output.completion)

    return score


@task
def duplicate_scorer_eval():
    """Duplicate public names remain unsupported because Inspect's suffixing is private."""
    return Task(
        dataset=[Sample(input="Choose C", target="C")],
        solver=generate(),
        scorer=[match(), match()],
    )


@scorer(metrics=[])
def hosted_sandbox_scorer(host_sentinel_path: str):
    async def score(state, target):
        environment = sandbox()
        await environment.write_file("probe.txt", "sandbox-bridge-ok")
        copied = await environment.read_file("probe.txt")
        script = """
import json, os, pathlib, socket, sys
sentinel = sys.argv[1]
for forbidden in ['/var/run/docker.sock', '/run/secrets', sentinel]:
    assert not pathlib.Path(forbidden).exists(), forbidden
assert 'OPENAI_API_KEY' not in os.environ
assert 'BENCHMARK_PRODUCT_OPENAI_API_KEY_FILE' not in os.environ
try:
    socket.create_connection(('api.openai.com', 443), timeout=1)
except OSError:
    pass
else:
    raise AssertionError('sandbox unexpectedly has provider egress')
print(json.dumps({'ok': True}))
"""
        result = await environment.exec(["python", "-c", script, host_sentinel_path], timeout=30)
        passed = copied == "sandbox-bridge-ok" and result.success and json.loads(result.stdout)["ok"]
        return Score(value=CORRECT if passed else INCORRECT, answer=state.output.completion)

    return score


@task(version="1.0")
def hosted_sandbox_eval(host_sentinel_path: str):
    """Hermetic task whose unchanged scorer exercises Inspect's public sandbox API."""
    return Task(
        dataset=[Sample(id="alpha", input="Return any text.", target="C")],
        solver=generate(),
        scorer=hosted_sandbox_scorer(host_sentinel_path),
        sandbox="docker",
    )


@task(version="1.0")
def hosted_sandbox_multiple_scorer_eval(host_sentinel_path: str):
    """Unmodified parallel scorers through the product-hosted Inspect sandbox."""
    return Task(
        dataset=[Sample(id="alpha", input="Return any text.", target="C")],
        solver=generate(),
        scorer=[hosted_sandbox_scorer(host_sentinel_path), policy_scorer()],
        sandbox="docker",
    )


@task(version="1.0")
def hosted_sandbox_cancellation_eval():
    """Cancellation fixture that starts the hosted sandbox before blocking in the solver."""
    return Task(
        dataset=[Sample(id="alpha", input="Return the default response.", target="Default output from mockllm/model")],
        solver=cancellation_gate(),
        scorer=match(),
        sandbox="docker",
    )


@task(version="1.0")
def broker_sandbox_isolation_eval(host_sentinel_path: str):
    """Exercises the credential broker and task sandbox without replacing Inspect's execution path."""
    return Task(
        dataset=[Sample(id="alpha", input="Return exactly C.", target="C")],
        solver=credential_isolation_probe(host_sentinel_path),
        scorer=hosted_sandbox_scorer(host_sentinel_path),
        sandbox="docker",
    )
