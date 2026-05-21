Write an implementation plan for a rate-limiter middleware for a Hono HTTP server.
The spec requires token-bucket semantics with a configurable capacity and refill rate,
but leaves the storage backend open: an in-process Map or a Redis client are both
reasonable. Pick one, justify the choice from project conventions, and write the plan.
Do not ask which to use.

Expected deliverable: an implementation plan at `docs/superpowers/plans/`.
