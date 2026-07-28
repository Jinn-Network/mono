// @jinn-network/task-execution-supervisor — public surface.
// Task A2: the `AttemptIdentity`/`SpawnRequest` contract types (custody-owned, design §14 item
// 1; backend plan Finding (e)). The shim (A4) and the journal/attempt-record/reconciler/
// cancellation/deadline internals (A5) land next.
export type { AttemptIdentity, SpawnRequest } from "./attempt-identity.js";
