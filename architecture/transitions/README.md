# Architecture transitions

This directory is the machine-readable handoff from Phase C compatibility work to Phase D
deletion. `transition-manifest.schema.json` is the closed authority for each manifest entry.

C0 owns the schema and dependency-free validator. C9 adds
`phase-d-native-operator.v1.json`, including every surviving legacy entry point, its exact
consumer inventory, observable zero-use condition and executable deletion test. A manifest may
describe a transition; it never authorizes a default-mode flip by itself.
