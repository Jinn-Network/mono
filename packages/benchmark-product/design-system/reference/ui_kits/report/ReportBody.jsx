const { SectionHead, Card, Callout, Footnote, Imprint, AssuranceMeter, CompletenessBar, DisagreementStrip, CiteBlock, ReportCard, ClaimBadge, Switch, Button } = window.__C;
const { ResultTable } = window.__K;
function ReportBody({report}){
  const [showIncomplete,setShowIncomplete]=React.useState(true);
  return <main style={{maxWidth:'var(--report-max)',margin:'0 auto',padding:'0 var(--gutter) var(--space-14)',display:'flex',flexDirection:'column',gap:'var(--space-12)'}}>
    <section id="result" style={{display:'flex',flexDirection:'column',gap:'var(--space-7)',paddingTop:'var(--space-11)'}}>
      <SectionHead number="01" title="Result" standfirst={report.resultStandfirst}
        actions={<Switch label="Show incomplete" checked={showIncomplete} onChange={setShowIncomplete}/>}/>
      <ResultTable entrants={report.entrants} showIncomplete={showIncomplete}/>
      <Footnote marker="1" href="#evidence">Score is met tasks divided by <em>expected</em> executions, not by executions that returned. The two denominators differ by 92 tasks.</Footnote>
    </section>

    <section id="method" style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
      <SectionHead number="02" title="Method" standfirst="Fixed on 2026-08-02, before any official execution. The digest below covers the task set, the entrant definitions, the evaluation policy and the run budget."/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-8)'}}>
        <Card eyebrow="Task set" title="SWE-bench Verified" padding="sm" footnote="Frozen at commit 4f19c2c.">
          <dl style={{margin:0,display:'grid',gridTemplateColumns:'auto 1fr',gap:'var(--space-4) var(--space-7)',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-secondary)'}}>
            <dt>Tasks</dt><dd style={{margin:0}}>500</dd><dt>Entrants</dt><dd style={{margin:0}}>3</dd><dt>Expected</dt><dd style={{margin:0}}>1,500 executions</dd><dt>Attempts</dt><dd style={{margin:0}}>1 per task</dd>
          </dl>
        </Card>
        <Card eyebrow="Execution" title="Network operators" padding="sm" footnote="Observed by Colophon. No entrant ran its own evaluation.">
          <dl style={{margin:0,display:'grid',gridTemplateColumns:'auto 1fr',gap:'var(--space-4) var(--space-7)',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-secondary)'}}>
            <dt>Window</dt><dd style={{margin:0}}>2026-08-03 → 08-04</dd><dt>Operators</dt><dd style={{margin:0}}>7</dd><dt>Runtime</dt><dd style={{margin:0}}>41h 12m aggregate</dd><dt>Cost</dt><dd style={{margin:0}}>$2,184.10</dd>
          </dl>
        </Card>
      </div>
      <Callout kind="method" title="Guarantee boundary">Colophon observed these executions and recorded their outputs. That establishes what was run and what came back. It does not establish that the evaluators reached correct verdicts, or that this suite predicts performance on other work.</Callout>
    </section>

    <section id="accounting" style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
      <SectionHead number="03" title="Assurance and accounting" standfirst="What counted as success, how deliveries became verdicts, and what happened to every execution the method expected."/>
      <div style={{display:'grid',gridTemplateColumns:'320px 1fr',gap:'var(--space-9)',alignItems:'start'}}>
        <AssuranceMeter value="majority" readOnly caption="Three evaluator identities. Chosen before the method was locked."/>
        <CompletenessBar size="lg" total={1500} label="1,500 expected executions" segments={report.accounting}/>
      </div>
      <Callout kind="limitation" title="What this does not show">These results cover one task suite on two days. They do not establish that any configuration is better in general, and they do not measure cost-adjusted quality.</Callout>
    </section>

    <section id="evidence" style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
      <SectionHead number="04" title="Disagreement" standfirst="88 tasks drew a split verdict. Colophon records the split rather than resolving it silently."/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'var(--space-6)'}}>
        {report.disagreements.map((d,i)=><DisagreementStrip key={i} {...d}/>)}
      </div>
      <Footnote marker="2" href="#">All 88 splits, with full transcripts and evaluator prompts, are in the evidence bundle.</Footnote>
    </section>

    <section id="cite" style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
      <SectionHead number="05" title="Cite, embed, clone or rerun" standfirst="Every compact asset below resolves to this report."/>
      <div style={{display:'flex',gap:'var(--space-5)',flexWrap:'wrap'}}>
        <ClaimBadge value="71.1% · 500 tasks" status="observed"/><ClaimBadge value="88 conflicted" status="conflicted"/><ClaimBadge value="92 not returned" status="incomplete"/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:'var(--space-8)',alignItems:'start'}}>
        <CiteBlock tabs={report.cite}/>
        <div style={{display:'flex',flexDirection:'column',gap:'var(--space-5)'}}>
          <ReportCard width={340} title={report.title} suite={report.suite} date={report.date} status="conflicted" entrants={report.entrants.map(e=>({name:e.id,score:e.score,display:e.score.toFixed(1)+'%'}))}/>
          <div style={{display:'flex',gap:'var(--space-4)'}}><Button variant="secondary" size="sm">Clone benchmark</Button><Button variant="secondary" size="sm">Challenge result</Button></div>
        </div>
      </div>
    </section>

    <Imprint rows={report.imprint}/>
  </main>;
}
Object.assign(window.__K,{ReportBody});
