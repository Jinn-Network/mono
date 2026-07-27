# Fixture execution verification policy

An execution is verified when:

1. its native trace has an unbroken sequence beginning with `execution.started` and ending with
   `execution.completed`;
2. every observed tool appears in the captured tool policy; and
3. every producer-controlled runtime component named by the Runtime Specification is packaged
   and content-bound by the sealed Execution Evidence metadata.

This policy does not assess whether the Result satisfies the Task.
