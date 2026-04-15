Review the changes made in the context of this branch in the following way:
	1.	Remove duplication (DRY) — merge repeated logic into functions/modules.
	2.	Use meaningful names — variables, functions, and classes should reflect intent.
	3.	Reduce function size — short, single-purpose functions; no god methods.
	4.	Simplify conditionals — flatten nested if/else, extract guard clauses.
	5.	Delete dead code — unused functions, variables, imports, comments. Delete md files which have been used to describe ongoing work. Delete debugging test scripts – only keep minimal tests required for long-term codebase integrity. If we've create learnings/summary MDs, fold them into AGENTS.md. DO NOT delete planning-docs.
	6.	Consistent formatting — whitespace, indentation, brace style; automate with a formatter.
	7.	Apply SRP (Single Responsibility) — one class/function/module per concern.
	8.	Encapsulate hard-to-understand logic — isolate complexity behind clear interfaces.
	9.	Use standard patterns/libraries — replace hand-rolled hacks with well-tested solutions.
	10.	Esnure/add minimal tests around critical paths — sanity checks to prevent regressions.

- be sure to run any relevant unit and integration tests. if there are issues, fix them
- if there's a Linear issue, update it with details of the implementation.
- be sure to update docs, particularly /AGENTS.md if anything relevant has changed. Make sure additions are standalone - no language which only related to the completion of this project. Only add things that are core architectural elements – everything else can be inferred from the codebase itself.
- push all code