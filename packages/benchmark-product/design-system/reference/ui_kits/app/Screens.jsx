const { Button, IconButton, Input, Select, Checkbox, Switch, Tag, Card, Callout, Footnote, VerdictChip, AssuranceMeter, CompletenessBar, DisagreementStrip, MethodLock, ClaimBadge, CiteBlock, ReportCard, Imprint } = window.__C;

/* --- 1. configuration comparison table --- */
function ConfigureScreen({entrants,onAdd,onNext}){
  const { Icon } = window.__K;
  const rows=[['Model','model'],['Harness','harness'],['Tool policy','tools'],['Context budget','context'],['Attempts','attempts'],['Runner','runner']];
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-8)'}}>
    <Card eyebrow="Step 02" title="Entrant configurations" actions={<Button size="sm" variant="secondary" onClick={onAdd}>Add entrant</Button>} padding="none">
      <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',font:'var(--type-ui)',fontSize:'var(--text-sm)'}}>
        <thead><tr><th style={{width:150,textAlign:'left',padding:'var(--space-6) var(--space-8)',font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)',borderBottom:'var(--border-heavy) solid var(--rule-heavy)'}}>Field</th>
          {entrants.map((e,i)=><th key={e.id} style={{textAlign:'left',padding:'var(--space-6) var(--space-8)',borderBottom:'var(--border-heavy) solid var(--rule-heavy)',borderLeft:'var(--border-hair) solid var(--rule)'}}>
            <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)'}}>
              <span style={{width:3,height:18,background:i===0?'var(--vermilion-500)':'var(--ink-300)'}}/>
              <span style={{fontFamily:'var(--font-mono)',fontSize:'var(--text-sm)'}}>{e.id}</span>
              {i===0&&<Tag tone="outline">reference</Tag>}
            </div></th>)}
        </tr></thead>
        <tbody>{rows.map(([label,key])=><tr key={key} style={{borderBottom:'var(--border-hair) solid var(--rule)'}}>
          <td style={{padding:'var(--space-5) var(--space-8)',font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>{label}</td>
          {entrants.map(e=>{const base=entrants[0][key];const diff=e[key]!==base;
            return <td key={e.id} style={{padding:'var(--space-5) var(--space-8)',borderLeft:'var(--border-hair) solid var(--rule)',fontFamily:'var(--font-mono)',fontSize:'var(--text-xs)',color:diff?'var(--text-primary)':'var(--text-muted)',background:diff?'var(--surface-accent)':'transparent'}}>{e[key]}</td>;})}
        </tr>)}</tbody>
      </table></div>
    </Card>
    <Footnote marker="†">Highlighted cells differ from the reference entrant. Only these differences can explain a gap in the result.</Footnote>
    <div style={{display:'flex',justifyContent:'flex-end',gap:'var(--space-5)'}}><Button variant="ghost">Save draft</Button><Button variant="primary" onClick={onNext}>Continue to assurance</Button></div>
  </div>;
}

/* --- 2. evaluation assurance selector --- */
function AssuranceScreen({value,onChange,onNext}){
  return <div style={{display:'grid',gridTemplateColumns:'1fr 340px',gap:'var(--space-9)',alignItems:'start'}}>
    <div style={{display:'flex',flexDirection:'column',gap:'var(--space-8)'}}>
      <Card eyebrow="Step 03" title="What counts as success?" padding="md">
        <div style={{display:'flex',flexDirection:'column',gap:'var(--space-6)'}}>
          <Checkbox defaultChecked label="Repository test suite passes" description="Deterministic. Decided by code, not judgement."/>
          <Checkbox defaultChecked label="Patch resolves the stated issue" description="Judged by an evaluator against the issue text."/>
          <Checkbox label="No public API change" description="Adds a second requirement; tasks can be met on one and unmet on the other."/>
        </div>
      </Card>
      <Card eyebrow="Step 03" title="How does a delivery become a verdict?" padding="md"
        footnote="A higher step means more independence between solver and evaluator. It does not mean the verdict is more likely to be correct.">
        <div style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
          <AssuranceMeter value={value} onChange={onChange}/>
          <Checkbox defaultChecked label="Retain disagreement" description="Split verdicts are published as conflicted instead of resolved by majority."/>
        </div>
      </Card>
      <div style={{display:'flex',justifyContent:'flex-end',gap:'var(--space-5)'}}><Button variant="ghost">Back</Button><Button variant="primary" onClick={onNext}>Preview & quote</Button></div>
    </div>
    <Card eyebrow="Effect" title="On the published report" padding="sm" tone="sunken">
      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-6)'}}>
        <p style={{font:'var(--type-body)',fontSize:'var(--text-sm)',margin:0,color:'var(--text-secondary)'}}>Readers will see this assurance statement above the result:</p>
        <MethodLock state="draft" compact/>
        <div style={{display:'flex',gap:'var(--space-4)',flexWrap:'wrap'}}><VerdictChip size="sm" verdict="met"/><VerdictChip size="sm" verdict="unmet"/><VerdictChip size="sm" verdict="conflicted"/></div>
      </div>
    </Card>
  </div>;
}

/* --- 3. live run --- */
function LiveScreen({onFinish}){
  const { Icon } = window.__K;
  const [n,setN]=React.useState(1104);
  React.useEffect(()=>{const t=setInterval(()=>setN(v=>Math.min(v+7,1408)),1000);return ()=>clearInterval(t);},[]);
  const met=Math.round(n*0.68),unmet=Math.round(n*0.26),conf=n-met-unmet,pending=1500-n;
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-8)'}}>
    <MethodLock state="locked" digest="sha256:9f3c1d7a…a71b" timestamp="2026-08-02T14:20:11Z" detailHref="#"/>
    <Card eyebrow="Live" title="Execution in progress" padding="md"
      actions={<div style={{display:'flex',gap:'var(--space-4)'}}><Button size="sm" variant="secondary">Pause</Button><Button size="sm" variant="danger">Cancel run</Button></div>}
      footnote="Cancelling does not remove expected executions from the accounting. They are published as incomplete.">
      <div style={{display:'flex',flexDirection:'column',gap:'var(--space-8)'}}>
        <CompletenessBar size="lg" total={1500} label={n.toLocaleString()+' of 1,500 expected executions returned'} segments={[{verdict:'met',count:met},{verdict:'unmet',count:unmet},{verdict:'conflicted',count:conf},{verdict:'incomplete',count:pending,label:'pending'}]}/>
        <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'var(--space-8)'}}>
          {[['Operators','7 active'],['Runtime','31h 04m'],['Spend','$1,612.80 / $2,400 cap'],['Started','2026-08-03 09:12Z']].map(([k,v])=>
            <div key={k} style={{display:'flex',flexDirection:'column',gap:2}}>
              <span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>{k}</span>
              <span style={{font:'var(--type-data)',color:'var(--text-primary)'}}>{v}</span></div>)}
        </div>
      </div>
    </Card>
    <Card eyebrow="Agent activity" title="bench-agent" padding="none" tone="sunken">
      <ul style={{listStyle:'none',margin:0,padding:0,font:'var(--type-data)',fontSize:'var(--text-xs)'}}>
        {[['09:12:04','launch_run','hb-2026-08 · 1,500 executions queued'],['09:12:04','lock_method','sha256:9f3c1d7a…a71b'],['11:48:22','inspect_result','conflicted count crossed 50 · notified sponsor'],['14:02:10','request_quote','additional 200 executions · $312.00 · awaiting approval']].map((r,i)=>
          <li key={i} style={{display:'grid',gridTemplateColumns:'80px 150px 1fr',gap:'var(--space-6)',padding:'var(--space-5) var(--space-8)',borderTop:i?'var(--border-hair) solid var(--rule)':'none'}}>
            <span style={{color:'var(--text-faint)'}}>{r[0]}</span><span style={{color:'var(--vermilion-600)'}}>{r[1]}</span><span style={{color:'var(--text-secondary)'}}>{r[2]}</span></li>)}
      </ul>
    </Card>
    <div style={{display:'flex',justifyContent:'flex-end'}}><Button variant="primary" onClick={onFinish}>Open draft report</Button></div>
  </div>;
}

/* --- 4. publish --- */
function PublishScreen({onPublish,published}){
  return <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:'var(--space-9)',alignItems:'start'}}>
    <div style={{display:'flex',flexDirection:'column',gap:'var(--space-8)'}}>
      <Card eyebrow="Step 05" title="Publish this report" padding="md"
        footnote="Publishing makes the method, the accounting, the evidence bundle and the failures readable by anyone with the link.">
        <div style={{display:'flex',flexDirection:'column',gap:'var(--space-7)'}}>
          <Input label="Report URL" mono prefix="colophon.press/r/" defaultValue="hb-2026-08"/>
          <Input label="Headline" defaultValue="Three harness loadouts on the same 500 tasks"/>
          <Checkbox defaultChecked label="Publish evidence bundle" description="Transcripts, evaluator prompts and per-task verdicts."/>
          <Checkbox defaultChecked label="Allow clone and rerun" description="Readers can reproduce the benchmark under the same locked method."/>
        </div>
      </Card>
      <Callout kind="caution" title="Before you publish">88 tasks are conflicted and 92 executions never returned. Both are shown on the report and on every badge generated from it. Headlines cannot be scoped narrower than the accounting.</Callout>
      <div style={{display:'flex',justifyContent:'flex-end',gap:'var(--space-5)'}}><Button variant="secondary">Preview as reader</Button><Button variant="accent" onClick={onPublish}>{published?'Published':'Publish report'}</Button></div>
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:'var(--space-6)'}}>
      <ReportCard width={360} title="Three harness loadouts on the same 500 tasks" suite="SWE-bench Verified · 500 tasks" date="2026-08-04" status="conflicted"
        entrants={[{name:'loadout-c',score:71.1,display:'71.1%'},{name:'loadout-a',score:62.4,display:'62.4%'},{name:'baseline',score:58.0,display:'58.0%'}]}/>
      <div style={{display:'flex',gap:'var(--space-4)',flexWrap:'wrap'}}><ClaimBadge value="71.1% · 500 tasks" status={published?'observed':'draft'}/><ClaimBadge value="88 conflicted" status="conflicted"/></div>
      <CiteBlock tabs={[{id:'md',label:'Markdown',value:'[![colophon 71.1% · 500 tasks](https://colophon.press/b/hb-2026-08.svg)](https://colophon.press/r/hb-2026-08)'},{id:'cli',label:'CLI',value:'colophon publish hb-2026-08'}]}/>
    </div>
  </div>;
}
Object.assign(window.__K,{ConfigureScreen,AssuranceScreen,LiveScreen,PublishScreen});