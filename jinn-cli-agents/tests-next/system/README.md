# tests-next System Scenarios

System scenarios compose the env controller, Tenderly runner, and process harness to spin up the real worker stack once per suite and run multiple job manifests. Existing examples:

- `worker-basic-execution.system.test.ts` – dispatches a job, runs the worker once, and verifies on-chain delivery.

Add additional scenario files here as we migrate the legacy marketplace/worker/service tests.
