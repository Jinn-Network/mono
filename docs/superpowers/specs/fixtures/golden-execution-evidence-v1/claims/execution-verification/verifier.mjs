export function verifyExecution({ trace, allowedTools, controlledComponents, packagedParts }) {
  const sequencePass =
    trace.length > 1 &&
    trace.every((event, index) => event.sequence === index + 1) &&
    trace[0].type === 'execution.started' &&
    trace.at(-1).type === 'execution.completed';

  const observedTools = trace
    .filter((event) => event.type === 'tool.called')
    .map((event) => event.tool);
  const toolsPass = observedTools.every((tool) => allowedTools.includes(tool));
  const componentsPass = controlledComponents.every((part) => packagedParts.includes(part));

  return {
    sequencePass,
    toolsPass,
    componentsPass,
    verdict: sequencePass && toolsPass && componentsPass ? 'verified' : 'rejected',
  };
}
