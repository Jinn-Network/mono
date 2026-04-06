<!-- 704ac0af-49c5-485f-b95e-d8adc904fd3a a7399640-eb0f-41e8-9157-fed900a8b18c -->
# Plan: Implement Worker Telemetry

I will implement a telemetry system for the Jinn worker to capture and persist operational data for each job run. This will provide better observability into the worker's lifecycle, augmenting the existing agent-level telemetry.

### 1. Introduce a Telemetry Service

I will create a new file `worker/worker_telemetry.ts` to house a `WorkerTelemetryService` class. This class will manage the collection of telemetry events for a single job run. It will provide methods to record events and retrieve the full log.

### 2. Instrument the Worker Lifecycle

I will modify `worker/mech_worker.ts` to use this new service. A new instance of `WorkerTelemetryService` will be created for each request being processed. I will then add logging calls at critical stages of the worker's execution, including:

-   Start and end of request processing.
-   Request claim process.
-   Recognition phase for situational learning.
-   Agent execution start and finish.
-   `SITUATION` artifact creation and encoding.
-   Final result delivery to the blockchain.

### 3. Persist Telemetry as an IPFS Artifact

At the conclusion of a job, I will add logic to `worker/mech_worker.ts` to:

1.  Retrieve the collected telemetry from the `WorkerTelemetryService`.
2.  Create a new artifact with `type: 'WORKER_TELEMETRY'`.
3.  Upload the telemetry log as a JSON file to IPFS.
4.  Include this new artifact in the final delivery payload that is submitted on-chain.

This ensures the worker telemetry is permanently stored and indexed by Ponder, making it accessible for debugging and analysis alongside other job-related artifacts.

### 4. Frontend Integration

I will update the frontend explorer to display the new `WORKER_TELEMETRY` artifact. I'll modify the request detail page in `frontend/explorer` to fetch and render the telemetry log, providing a simple, chronological view of the worker's operations for a given job.

### To-dos

- [ ] Create `WorkerTelemetryService` in `worker/worker_telemetry.ts`.
- [ ] Integrate `WorkerTelemetryService` into `worker/mech_worker.ts` and add logging at key checkpoints.
- [ ] Implement IPFS upload for worker telemetry and add it to the delivery payload.
- [ ] Update the frontend explorer to display worker telemetry.