import React from 'react';
export function DisagreementStrip({evaluators=[],resolution='retained',taskId,style}){
  const R={retained:['Retained as conflicted','var(--verdict-conflicted)'],majority:['Resolved by majority','var(--verdict-attested)'],unanimous:['Unanimous','var(--verdict-met)'],unresolved:['Unresolved','var(--verdict-unverifiable)']}[resolution];
  return <div style={{border:'var(--border-hair) solid var(--rule)',borderRadius:'var(--radius-sm)',background:'var(--surface-card)',...style}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-6)',padding:'var(--space-5) var(--space-6)',borderBottom:'var(--border-hair) solid var(--rule)'}}>
      {taskId&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{taskId}</span>}
      <span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:R[1]}}>{R[0]}</span>
    </div>
    <ul style={{listStyle:'none',margin:0,padding:0}}>
      {evaluators.map((e,i)=><li key={i} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-6)',padding:'var(--space-5) var(--space-6)',borderTop:i?'var(--border-hair) solid var(--rule)':'none'}}>
        <span style={{display:'flex',flexDirection:'column',gap:1,minWidth:0}}>
          <span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-primary)'}}>{e.id}</span>
          {e.note&&<span style={{font:'var(--type-ui)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{e.note}</span>}
        </span>
        <span style={{flex:'none',font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:e.verdict==='met'?'var(--verdict-met)':e.verdict==='unmet'?'var(--verdict-unmet)':'var(--verdict-unverifiable)'}}>{e.verdict}</span>
      </li>)}
    </ul>
  </div>;
}