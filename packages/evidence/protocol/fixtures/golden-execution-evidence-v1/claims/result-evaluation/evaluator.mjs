export function evaluateResult(report) {
  const passed =
    report.result.exitCode === 0 &&
    report.result.testsPassed === 4 &&
    report.result.testsFailed === 0 &&
    report.taskCriteriaObserved.includes('repeated-separators') &&
    report.taskCriteriaObserved.includes('surrounding-punctuation') &&
    report.taskCriteriaObserved.includes('punctuation-only-input');

  return passed ? 'pass' : 'fail';
}
