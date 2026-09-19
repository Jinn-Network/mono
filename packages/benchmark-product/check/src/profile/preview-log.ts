export function previewDisclosureSummaryLine(summary: { readonly previewCount: number; readonly timestamps: readonly string[] }): string {
  return `${summary.previewCount} disposable preview rehearsal(s) of this benchmark ran before lock (at ${summary.timestamps.join(", ")}); preview results are rehearsal only and never entered official results.`;
}
