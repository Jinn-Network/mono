export async function runAttempt({ task, repository, model, tools, trace }) {
  trace.record({ type: 'execution.started', task, repository });
  const response = await model.complete({ task, repository, tools: tools.names() });
  const result = await tools.applyPatch(response.patch);
  const tests = await tools.runTests(['test/slug.test.ts']);
  trace.record({ type: 'execution.completed', result, tests });
  return { result, tests };
}
