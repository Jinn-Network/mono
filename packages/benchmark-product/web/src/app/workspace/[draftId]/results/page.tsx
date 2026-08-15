import "server-only";

import Link from "next/link";
import type { RunResultsCell, RunResultsDocument, RunResultsReport } from "@colophon-claims/core";
import { ActionForm } from "@/components/action-form";
import { LifecycleRail } from "@/components/lifecycle-rail";
import { VerificationForm } from "@/components/verification-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { PRODUCT_BRANDING } from "@/lib/branding";
import { GUI_SERVER_ACTIONS } from "@/lib/server/gui-action-registry";
import { loadResultsView } from "@/lib/server/view-models";

const ATTRITION_FIELDS = ["expected", "judged", "unjudged", "unscorable", "expired", "invalidated", "excluded", "replacements"] as const;
const AXES = ["harness", "model", "loadout", "isolation"] as const;

type AttritionField = (typeof ATTRITION_FIELDS)[number];

interface PresentedClaimArm {
  readonly armId: string;
  readonly pinning: unknown;
}

interface PresentedClaimHeadline {
  readonly n: number;
  readonly passRate: string;
  readonly wilsonInterval: { readonly low: string; readonly high: string };
}

interface PresentedComparisonInterval {
  readonly alpha: string;
  readonly low: string;
  readonly high: string;
}

/** paired-delta@1's claim-package `comparison` block (P4b Task 7), sibling to
 * `PresentedClaimHeadline`. Only the fields this page actually presents — see
 * `core/src/report/claim.ts`'s `ComparisonSchema` for the full sealed shape. */
interface PresentedComparison {
  readonly pairs: number;
  readonly delta: string | null;
  readonly interval: PresentedComparisonInterval | null;
  readonly reasons: readonly string[];
}

interface PresentedComparisonParameters {
  readonly baseline: string;
  readonly candidate: string;
  readonly alpha: string;
}

function formatFact(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatFact).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Readonly<Record<string, unknown>>)
      .map(([key, nested]) => `${key}: ${formatFact(nested)}`)
      .join("; ");
  }
  return "not present";
}

function Digest({ children }: { readonly children: string }) {
  return <span className="break-all font-mono text-xs">{children}</span>;
}

function HiddenDraft({ draftId }: { readonly draftId: string }) {
  return <input type="hidden" name="draftId" value={draftId} />;
}

function Completeness({ results }: { readonly results: RunResultsDocument }) {
  return <section aria-labelledby="matrix-summary-heading" className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <h2 id="matrix-summary-heading" className="sr-only">Matrix summary</h2>
    {[
      ["Run outcome", results.runOutcome],
      ["Expected", results.completeness.expected],
      ["Judged", results.completeness.judged],
      ["Floor", results.completeness.floor],
    ].map(([label, value]) => <Card key={label}><CardHeader><h3 className="font-semibold">{label}</h3></CardHeader><CardContent><p className="text-2xl font-semibold">{value}</p></CardContent></Card>)}
  </section>;
}

function Attrition({ results }: { readonly results: RunResultsDocument }) {
  return <Card className="min-w-0"><CardHeader><h2 className="text-xl font-semibold">Completeness and attrition</h2></CardHeader><CardContent className="min-w-0 space-y-5">
    {results.attrition.asymmetryFlags.length > 0 ? <div role="status" className="rounded-md border border-destructive p-3">
      <h3 className="font-semibold">Asymmetry and validity warnings</h3>
      <ul className="list-disc pl-5">{results.attrition.asymmetryFlags.map((flag: string) => <li key={flag}>{flag}</li>)}</ul>
    </div> : <p>No attrition asymmetry warning was recorded.</p>}
    <div tabIndex={0} aria-label="Scrollable results table" className="max-w-full overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <caption className="pb-2 text-left font-semibold">Attrition by arm</caption>
        <thead><tr><th scope="col">Arm</th>{ATTRITION_FIELDS.map((field) => <th scope="col" key={field} className="px-2">{field}</th>)}</tr></thead>
        <tbody>{Object.entries(results.attrition.perArm).map(([armId, counts]) => <tr key={armId} className="border-t"><th scope="row" className="py-2 pr-2">{armId}</th>{ATTRITION_FIELDS.map((field) => <td key={field} className="px-2">{(counts as Readonly<Record<AttritionField, number>>)[field]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </CardContent></Card>;
}

function Verdicts({ cell }: { readonly cell: RunResultsCell }) {
  if (cell.verdicts.length === 0) return <>None</>;
  return <ul className="min-w-48 space-y-2">{cell.verdicts.map((verdict) => <li key={verdict.sha256}>
    <span className="font-semibold">{verdict.verdict}</span> by {verdict.evaluator}<br />
    <Digest>{verdict.sha256}</Digest><br />
    <span className="font-medium">{cell.validVerdicts.includes(verdict.sha256) ? "Valid verdict reference" : "Rejected verdict reference"}</span><br />
    <span>{Object.entries(verdict.measurements).map(([key, value]) => `${key}: ${String(value)}`).join("; ") || "No measurements"}</span>
  </li>)}</ul>;
}

function Cells({ results }: { readonly results: RunResultsDocument }) {
  const dissent = new Set(results.dissentCells);
  return <Card className="min-w-0"><CardHeader><h2 className="text-xl font-semibold">Cells and frozen outcomes</h2></CardHeader><CardContent className="min-w-0">
    <div tabIndex={0} aria-label="Scrollable sealed cells table" className="max-w-full overflow-x-auto">
      <table className="w-full min-w-[80rem] text-left align-top text-sm">
        <caption className="pb-2 text-left font-semibold">All sealed Matrix cells</caption>
        <thead><tr><th scope="col">Cell</th><th scope="col">Arm / replicate</th><th scope="col">Outcome</th><th scope="col">Verdicts and dissent</th><th scope="col">Cost / latency</th><th scope="col">Axis verification</th><th scope="col">Failure / blame</th></tr></thead>
        <tbody>{results.cells.map((cell) => <tr key={cell.cellKey} className="border-t">
          <th scope="row" className="max-w-64 py-3 pr-4"><span className="break-all">{cell.cellKey}</span><br /><Digest>{cell.taskSha256}</Digest></th>
          <td className="pr-4">{cell.armId} / {cell.replicate}<br />{cell.integrityTier}</td>
          <td className="pr-4 font-semibold">{cell.outcome}</td>
          <td className="pr-4"><Verdicts cell={cell} />{dissent.has(cell.cellKey) ? <p className="mt-2 font-semibold text-destructive">Dissent: stored verdicts disagree.</p> : null}</td>
          <td className="pr-4">{cell.cost ? `${cell.cost.value} ${cell.cost.unit} (${cell.cost.source})` : "Not reported"}<br />{cell.latencyMs !== undefined ? `${cell.latencyMs} ms` : "Latency absent"}</td>
          <td className="pr-4"><dl>{AXES.map((axis) => <div key={axis}><dt className="inline font-medium">{axis}: </dt><dd className="inline">{cell.verification[axis]}</dd></div>)}</dl>{cell.verification.checksFailed.length > 0 ? <ul className="mt-2 list-disc pl-5">{cell.verification.checksFailed.map((check) => <li key={check}>{check}</li>)}</ul> : null}</td>
          <td>{cell.failure ? <><strong>{cell.failure.kind}</strong>{cell.failure.blame ? `; ${cell.failure.blame}` : ""}{cell.failure.detail ? `; ${cell.failure.detail}` : ""}</> : "None"}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </CardContent></Card>;
}

function Venue({ results }: { readonly results: RunResultsDocument }) {
  return <Card><CardHeader><h2 className="text-xl font-semibold">Venue honesty and axis visibility</h2></CardHeader><CardContent className="space-y-4">
    <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-medium">Venue</dt><dd>{results.venueHonesty.venue}</dd></div><div><dt className="font-medium">Pre-registration scope</dt><dd>{results.venueHonesty.preRegistration}</dd></div>{AXES.map((axis) => <div key={axis}><dt className="font-medium">{axis} unverifiable</dt><dd>{results.venueHonesty.unverifiableAxisCounts[axis]}</dd></div>)}</dl>
    <h3 className="font-semibold">Local venue limits</h3><ul className="list-disc pl-5">{results.venueHonesty.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul>
  </CardContent></Card>;
}

function comparisonParameters(value: unknown): PresentedComparisonParameters | undefined {
  const parameters = recordOf(value);
  if (
    typeof parameters?.["baseline"] !== "string"
    || typeof parameters["candidate"] !== "string"
    || typeof parameters["alpha"] !== "string"
  ) return undefined;
  const alpha = Number(parameters["alpha"]);
  if (!Number.isFinite(alpha)) return undefined;
  return {
    baseline: parameters["baseline"],
    candidate: parameters["candidate"],
    alpha: alpha.toFixed(4),
  };
}

/** Operator-approved paired-delta copy: explicitly names candidate-minus-baseline direction and
 * presents the estimate, interval state, exact alpha, and paired Task count together. */
function ComparisonBlock({
  comparison,
  parameters,
}: {
  readonly comparison: PresentedComparison;
  readonly parameters: PresentedComparisonParameters;
}) {
  const estimate = comparison.delta ?? "unavailable";
  const interval = comparison.interval === null
    ? "withheld"
    : `${comparison.interval.low} to ${comparison.interval.high}`;
  return <div tabIndex={0} aria-label="Paired comparison facts" className="min-w-0 max-w-full space-y-3 overflow-x-auto">
    <h3 className="font-semibold">Paired comparison</h3>
    <p className="font-medium">Candidate minus baseline estimate ({parameters.candidate} minus {parameters.baseline}): {estimate}. Interval: {interval}. Alpha: {parameters.alpha}. Paired task count: {comparison.pairs}.</p>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="font-medium">Paired task count</dt><dd>{comparison.pairs}</dd></div><div><dt className="font-medium">Candidate minus baseline estimate</dt><dd>{formatFact(comparison.delta)}</dd></div></dl>
    {comparison.interval === null
      ? <div><h4 className="font-medium">Interval withheld</h4>{comparison.reasons.length === 0 ? <p>No withheld reasons recorded.</p> : <ul className="list-disc pl-5">{comparison.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>
      : <dl className="grid min-w-0 gap-3 sm:grid-cols-3"><div><dt className="font-medium">Interval low</dt><dd>{comparison.interval.low}</dd></div><div><dt className="font-medium">Interval high</dt><dd>{comparison.interval.high}</dd></div><div><dt className="font-medium">Alpha</dt><dd>{parameters.alpha}</dd></div></dl>}
  </div>;
}

function Claim({ report }: { readonly report: RunResultsReport }) {
  const claim = report.claimPackage;
  const pairedParameters = claim.comparison === undefined
    ? undefined
    : comparisonParameters(claim.method.parameters);
  return <section aria-labelledby="claim-heading" className="min-w-0 space-y-6">
    <Card className="min-w-0 overflow-hidden"><CardHeader><h2 id="claim-heading" className="text-xl font-semibold">Claim package</h2></CardHeader><CardContent className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="font-medium">Schema</dt><dd>{claim.claimSchema}</dd></div><div><dt className="font-medium">Draft</dt><dd>{claim.scope.draftId}</dd></div><div><dt className="font-medium">Scope</dt><dd>{claim.scope.taskCount} tasks, {claim.scope.arms.length} arms, {claim.scope.replicates} replicates, {claim.scope.venue}</dd></div><div><dt className="font-medium">Assurance preset</dt><dd>{claim.assurance.preset}</dd></div></dl>
      <p>{claim.assurance.disclosure}</p>
      <div tabIndex={0} aria-label="Claim scope arms and pinning table" className="min-w-0 max-w-full overflow-x-auto"><table className="w-max min-w-full text-left text-sm"><caption className="pb-2 text-left font-semibold">Claim scope arms and pinning</caption><thead><tr><th scope="col">Arm</th><th scope="col">Stored pinning</th></tr></thead><tbody>{claim.scope.arms.map((arm: PresentedClaimArm) => <tr key={arm.armId} className="border-t"><th scope="row" className="py-2 pr-4">{arm.armId}</th><td>{formatFact(arm.pinning)}</td></tr>)}</tbody></table></div>
      <div tabIndex={0} aria-label="Claim record links table" className="min-w-0 max-w-full overflow-x-auto"><table className="w-max min-w-full text-left text-sm"><caption className="pb-2 text-left font-semibold">Claim record links</caption><tbody>{Object.entries(claim.records).map(([name, digest]) => <tr key={name} className="border-t"><th scope="row" className="py-2 pr-4">{name}</th><td><Digest>{String(digest)}</Digest></td></tr>)}</tbody></table></div>
      {claim.headline ? <div tabIndex={0} aria-label="Headline results by arm table" className="min-w-0 max-w-full overflow-x-auto"><table className="w-max min-w-full text-left text-sm"><caption className="pb-2 text-left font-semibold">Headline results by arm</caption><thead><tr><th scope="col">Arm</th><th scope="col">Judged n</th><th scope="col">Pass rate</th><th scope="col">Wilson interval</th></tr></thead><tbody>{Object.entries(claim.headline).map(([arm, headlineValue]) => { const headline = headlineValue as PresentedClaimHeadline; return <tr key={arm} className="border-t"><th scope="row" className="py-2 pr-4">{arm}</th><td>{headline.n}</td><td>{headline.passRate}</td><td>{headline.wilsonInterval.low} to {headline.wilsonInterval.high}</td></tr>; })}</tbody></table></div> : claim.comparison && pairedParameters ? <ComparisonBlock comparison={claim.comparison} parameters={pairedParameters} /> : claim.comparison ? <p role="alert">Paired comparison parameters cannot be presented. Run verification.</p> : null}
      <div><h3 className="font-semibold">Stored claim completeness</h3><p>{formatFact(claim.completeness)}</p></div>
      <div><h3 className="font-semibold">Stored claim attrition</h3><p>{formatFact(claim.attrition)}</p></div>
      <dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-medium">Conflicted cells</dt><dd>{claim.conflicted.count}: {claim.conflicted.cellKeys.join(", ") || "none"}</dd></div><div><dt className="font-medium">Integrity tiers</dt><dd>{formatFact(claim.disclosures.integrityTierCounts)}</dd></div><div><dt className="font-medium">Pinning unverifiable counts</dt><dd>{formatFact(claim.disclosures.pinningUnverifiableCounts)}</dd></div><div><dt className="font-medium">Assurance primitives</dt><dd>{formatFact(claim.assurance.resolved)}</dd></div></dl>
      <div className="min-w-0"><h3 className="font-semibold">Stored claim per-subject disclosures</h3>{claim.disclosures.perSubject.length === 0 ? <p>None</p> : <ol className="min-w-0 list-decimal pl-5 [overflow-wrap:anywhere]">{claim.disclosures.perSubject.map((disclosure: unknown, index: number) => <li className="min-w-0 break-words" key={index}>{formatFact(disclosure)}</li>)}</ol>}</div>
      <div><h3 className="font-semibold">Stored claim venue honesty</h3><p>{formatFact(claim.venueHonesty)}</p></div>
      {claim.rehearsal ? <div><h3 className="font-semibold">Disclosed rehearsal</h3><p>Preview count: {claim.rehearsal.previewCount}</p><ul className="list-disc pl-5">{claim.rehearsal.timestamps.map((at: string) => <li key={at}>{at}</li>)}</ul></div> : <p>No preview rehearsal is recorded in this claim.</p>}
      <div><h3 className="font-semibold">Limitations</h3><ul className="list-disc pl-5">{claim.limitations.map((limit: string) => <li key={limit}>{limit}</li>)}</ul></div>
    </CardContent></Card>
  </section>;
}

interface StoredReportArm {
  readonly armId: string;
  readonly n: number;
  readonly passRate: string;
  readonly low: string;
  readonly high: string;
}

interface StoredReportSubject {
  readonly subjectSha256: string;
  readonly arms: readonly StoredReportArm[];
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** Presentation-only extraction of the sealed wilson@1 result shape. It copies stored facts;
 * it does not calculate a score, interval, or conflict. Unknown shapes fail visibly. */
function storedReportSubjects(value: unknown): readonly StoredReportSubject[] | undefined {
  const perSubject = recordOf(value)?.["perSubject"];
  if (!Array.isArray(perSubject)) return undefined;
  const subjects: StoredReportSubject[] = [];
  for (const entry of perSubject) {
    const subject = recordOf(entry);
    const results = recordOf(subject?.["results"]);
    const arms = recordOf(results?.["arms"]);
    const conflicted = recordOf(results?.["conflicted"]);
    const cellKeys = conflicted?.["cellKeys"];
    if (
      typeof subject?.["subjectSha256"] !== "string"
      || arms === undefined
      || typeof conflicted?.["count"] !== "number"
      || !Array.isArray(cellKeys)
      || !cellKeys.every((cellKey) => typeof cellKey === "string")
    ) return undefined;
    const presentedArms: StoredReportArm[] = [];
    for (const [armId, armValue] of Object.entries(arms)) {
      const arm = recordOf(armValue);
      const interval = recordOf(arm?.["wilsonInterval"]);
      if (
        typeof arm?.["n"] !== "number"
        || typeof arm["passRate"] !== "string"
        || typeof interval?.["low"] !== "string"
        || typeof interval["high"] !== "string"
      ) return undefined;
      presentedArms.push({ armId, n: arm["n"], passRate: arm["passRate"], low: interval["low"], high: interval["high"] });
    }
    subjects.push({
      subjectSha256: subject["subjectSha256"],
      arms: presentedArms,
      conflicted: { count: conflicted["count"], cellKeys: cellKeys as readonly string[] },
    });
  }
  return subjects;
}

function StoredReportResults({ report }: { readonly report: RunResultsReport }) {
  const subjects = storedReportSubjects(report.record.results);
  return <div className="min-w-0 space-y-4">
    <h3 className="font-semibold">Stored Report results</h3>
    {subjects === undefined ? <p role="alert">Stored Report results cannot be presented as the shipped wilson@1 shape. Run verification.</p> : subjects.map((subject) => <section key={subject.subjectSha256} aria-label={`Report subject ${subject.subjectSha256}`} className="min-w-0 space-y-3">
      <p><span className="font-medium">Report subject: </span><Digest>{subject.subjectSha256}</Digest></p>
      <div tabIndex={0} aria-label="Stored report headline by arm table" className="min-w-0 max-w-full overflow-x-auto"><table className="w-max min-w-full text-left text-sm"><caption className="pb-2 text-left font-semibold">Stored Report headline by arm</caption><thead><tr><th scope="col">Arm</th><th scope="col">Judged n</th><th scope="col">Pass rate</th><th scope="col">Wilson interval</th></tr></thead><tbody>{subject.arms.map((arm) => <tr key={arm.armId} className="border-t"><th scope="row" className="py-2 pr-4">{arm.armId}</th><td>{arm.n}</td><td>{arm.passRate}</td><td>{arm.low} to {arm.high}</td></tr>)}</tbody></table></div>
      <div className="min-w-0 [overflow-wrap:anywhere]"><h4 className="font-semibold">Stored Report conflicted cells</h4><p>{subject.conflicted.count}: {subject.conflicted.cellKeys.join(", ") || "none"}</p></div>
    </section>)}
  </div>;
}

function Report({ report }: { readonly report: RunResultsReport }) {
  return <section aria-labelledby="report-heading" className="min-w-0 space-y-6">
    <Card className="min-w-0 overflow-hidden"><CardHeader><h2 id="report-heading" className="text-xl font-semibold">Sealed report</h2></CardHeader><CardContent className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="font-medium">Report digest</dt><dd><Digest>{report.reportSha256}</Digest></dd></div><div><dt className="font-medium">Envelope digest</dt><dd><Digest>{report.reportEnvelopeSha256}</Digest></dd></div><div><dt className="font-medium">Method</dt><dd>{report.record.method.id} version {report.record.method.version}</dd></div><div><dt className="font-medium">Method parameters</dt><dd>{formatFact(report.record.method.parameters)}</dd></div><div><dt className="font-medium">Preregistered</dt><dd>{report.record.preregistered === true ? "Yes" : "No"}</dd></div><div><dt className="font-medium">Report disclosures</dt><dd>{report.record.disclosures.perSubject.length} subject disclosure block(s)</dd></div></dl>
      <StoredReportResults report={report} />
      <div className="min-w-0"><h3 className="font-semibold">Stored report per-subject disclosures</h3><ol className="min-w-0 list-decimal pl-5 [overflow-wrap:anywhere]">{report.record.disclosures.perSubject.map((disclosure: unknown, index: number) => <li className="min-w-0 break-words" key={index}>{formatFact(disclosure)}</li>)}</ol></div>
      <div role="status" className="rounded-md border p-3"><p className="font-semibold">Signature / verification status: {report.verification.status}</p><p>{report.verification.detail}</p></div>
      <div><h3 className="font-semibold">Report limitations</h3><ul className="list-disc pl-5">{(report.record.limitations ?? []).map((limit: string) => <li key={limit}>{limit}</li>)}</ul></div>
    </CardContent></Card>
    <Claim report={report} />
  </section>;
}

export default async function ResultsPage({ params }: { readonly params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  const view = loadResultsView(draftId);
  const results = view.ok && view.results.ok ? view.results.result : undefined;
  const draftState = view.ok && view.draft.ok ? view.draft.result.draft.state : undefined;

  return <main id="main-content" tabIndex={-1} className="mx-auto flex min-w-0 max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 outline-none">
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="colophon-eyebrow text-muted-foreground">Draft <span className="font-mono normal-case tracking-normal">{draftId}</span></p><h1 className="mt-2 text-5xl">Results and report</h1><p className="colophon-body mt-2 max-w-[56ch] text-muted-foreground">Sealed accounting, stored report facts, retained disagreement, and portable verification.</p></div><nav aria-label="Draft navigation" className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href={`/workspace/${draftId}/run`}>Run monitor</Link></Button><Button asChild variant="outline"><Link href={`/workspace/${draftId}`}>Draft</Link></Button></nav></header>
    <LifecycleRail state={draftState} />
    {!view.ok ? <p role="alert">{view.detail}</p> : !view.results.ok ? <Card><CardHeader><h2 className="font-semibold">Results unavailable</h2></CardHeader><CardContent role="alert"><p className="font-semibold">{view.results.error.code}</p><p>{view.results.error.detail}</p></CardContent></Card> : results !== undefined ? <>
      <Card className="min-w-0"><CardHeader><h2 className="text-xl font-semibold">Sealed Matrix</h2></CardHeader><CardContent className="min-w-0"><dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="font-medium">Matrix digest</dt><dd><Digest>{results.matrixSha256}</Digest></dd></div><div><dt className="font-medium">Close boundary</dt><dd>{results.closeBoundary.at}</dd></div></dl></CardContent></Card>
      <Completeness results={results} />
      <Attrition results={results} />
      <Cells results={results} />
      <Venue results={results} />
      {results.publication ? <Card className="min-w-0"><CardHeader><h2 className="text-xl font-semibold">Published public bundle</h2></CardHeader><CardContent className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div><dt className="font-medium">Bundle identity</dt><dd><Digest>{results.publication.identity}</Digest></dd></div><div><dt className="font-medium">Workspace-relative path</dt><dd className="break-all font-mono text-xs">{results.publication.relativePath}</dd></div><div><dt className="font-medium">Published at</dt><dd>{results.publication.publishedAt}</dd></div></dl>
        <div><h3 className="font-semibold">Portable verification checks</h3><ul className="list-disc pl-5">{results.publication.checks.map((check: string) => <li key={check}>{check}</li>)}</ul></div>
      </CardContent></Card> : null}
      <Card className="min-w-0"><CardHeader><h2 className="text-xl font-semibold">Result and report actions</h2></CardHeader><CardContent className="grid min-w-0 gap-6 md:grid-cols-2 [&>*]:min-w-0">
        <ActionForm action={GUI_SERVER_ACTIONS["run.results"]} submitLabel="Refresh sealed results" successMessage="Sealed results refreshed from the core operation."><HiddenDraft draftId={draftId} /></ActionForm>
        <ActionForm action={GUI_SERVER_ACTIONS["run.report"]} submitLabel="Seal report" successMessage="Report and claim package sealed. Reloaded facts are shown on this route." gated disabled={draftState !== "closed"}><HiddenDraft draftId={draftId} /></ActionForm>
        <ActionForm action={GUI_SERVER_ACTIONS["run.publish"]} submitLabel={draftState === "published-bundle" ? "Verify published bundle" : "Publish public bundle"} successMessage="The fixed draft-owned public bundle passed portable verification." gated disabled={draftState !== "reported" && draftState !== "published-bundle"}><HiddenDraft draftId={draftId} /><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="includeNativeArtifacts" disabled={draftState !== "reported"} /><span>Include complete native runtime logs and transcripts in this non-confidential public bundle.</span></label></ActionForm>
      </CardContent></Card>
      {results.report ? <Report report={results.report} /> : <Card><CardHeader><h2 className="text-xl font-semibold">Report not sealed</h2></CardHeader><CardContent><p>A gated report can be sealed once the draft is closed.</p></CardContent></Card>}
      <section aria-labelledby="verification-heading">
        <Card className="min-w-0"><CardHeader><h2 id="verification-heading" className="text-xl font-semibold">Independent verification</h2></CardHeader><CardContent className="min-w-0 space-y-5"><p>{PRODUCT_BRANDING.attribution}</p>{results.report ? <><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="font-medium">Exact reader command</dt><dd className="break-all font-mono text-xs">{results.report.claimPackage.verification.command}</dd></div><div><dt className="font-medium">Compatible reader command</dt><dd className="break-all font-mono text-xs">{results.report.claimPackage.verification.compatibleCommand}</dd></div><div><dt className="font-medium">Workspace verification command</dt><dd className="break-all font-mono text-xs">{PRODUCT_BRANDING.commandName} verify --workspace &lt;workspace-dir&gt; --draft {draftId} --json</dd></div><div><dt className="font-medium">Trust root</dt><dd>{results.report.claimPackage.verification.trustRoot}</dd></div></dl><div><h3 className="font-semibold">Declared checks</h3><ul className="list-disc pl-5">{results.report.claimPackage.verification.checks.map((check) => <li key={check}>{check}</li>)}</ul></div></> : null}<VerificationForm action={GUI_SERVER_ACTIONS["run.verify"]} draftId={draftId} /></CardContent></Card>
      </section>
    </> : null}
  </main>;
}
