import React from 'react';
const LEVELS=[{id:'deterministic',label:'Deterministic tests',note:'Pass/fail decided by code, not judgement.'},{id:'single',label:'Single evaluator',note:'One evaluator identity scores every delivery.'},{id:'separated',label:'Solver-separated evaluator',note:'The evaluator identity is not the solver identity.'},{id:'majority',label:'Multiple evaluators · majority',note:'Three identities; the majority verdict stands.'},{id:'unanimous',label:'Multiple evaluators · unanimous',note:'All identities must agree, or the task is conflicted.'}];
export function AssuranceMeter({value='separated',levels=LEVELS,onChange,readOnly=false,caption,style}){
  const idx=levels.findIndex(l=>l.id===value);
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-5)',...style}}>
    <div style={{display:'flex',gap:'var(--space-2)'}}>
      {levels.map((l,i)=><button key={l.id} type="button" disabled={readOnly} onClick={()=>onChange&&onChange(l.id)} aria-pressed={i===idx} title={l.label} style={{flex:1,height:'var(--bar-height-lg)',border:'var(--border-hair) solid '+(i<=idx?'var(--indigo-600)':'var(--rule-strong)'),background:i<=idx?'var(--indigo-600)':'var(--surface-inset)',borderRadius:'var(--bar-radius)',padding:0,cursor:readOnly?'default':'pointer',transition:'var(--transition-ui)'}}/>)}
    </div>
    <div style={{display:'flex',flexDirection:'column',gap:2}}>
      <span style={{font:'var(--type-ui)',fontSize:'var(--text-sm)',fontWeight:'var(--weight-semibold)'}}>{levels[idx]?.label}</span>
      <span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{caption||levels[idx]?.note}</span>
    </div>
  </div>;
}