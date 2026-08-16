export const SEVERITIES = ['blocking', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
