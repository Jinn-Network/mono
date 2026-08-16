# `@jinn-network/benchmarking-native-capture`

Coordinates native benchmark capture without becoming a benchmark runtime. A
runtime adapter inventories and atomizes immutable snapshots; the coordinator
durably seals intent, launches a fixed executable/argv/environment through an
injected idempotent launcher, builds one Execution Evidence record per native
unit, and closes an Execution Batch Capture.

The package never creates Submission, Attempt, or Delivery records. Those may
be linked later as optional commissioning provenance.
