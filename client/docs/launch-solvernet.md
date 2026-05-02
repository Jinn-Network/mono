# Launch a SolverNet

Launchers define and fund SolverNets. For v1, Task creation is launcher-owned
and deterministic; open creators are out of scope.

Use the SDK to describe and validate the SolverNet:

```ts
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import {
  PREDICTION_V1_SOLVER_NET_CONTRACT,
  validateTask,
} from '@jinn-network/sdk/solvernets/prediction-v1';

const contract = getSolverNetContract('prediction.v1') ?? PREDICTION_V1_SOLVER_NET_CONTRACT;
const valid = validateTask(contract.solverType, candidateTask);
if (!valid.ok) throw new Error(valid.error.message);
```

The SDK should only build, validate, describe, and prepare. The client runtime
still owns live behavior:

- polling venue data
- applying posting caps over time
- acquiring local post locks
- posting Tasks on-chain
- claiming attempts
- submitting Solutions and Verdicts
- storing corpus envelopes

For Prediction v1, the launcher selects the `prediction.v1` SolverNet contract,
funds the launch through the configured runtime path, and runs client creator
mode to materialize eligible Polymarket Tasks.
