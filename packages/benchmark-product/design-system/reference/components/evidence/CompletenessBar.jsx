import React from 'react';
const TONE={met:['var(--verdict-met-bg)','var(--verdict-met)',null],unmet:['var(--verdict-unmet-bg)','var(--verdict-unmet)',null],conflicted:['var(--verdict-conflicted-bg)','var(--verdict-conflicted)','var(--texture-conflicted)'],attested:['var(--verdict-attested-bg)','var(--verdict-attested)','var(--texture-attested)'],incomplete:['var(--verdict-incomplete-bg)','var(--verdict-incomplete)','var(--texture-missing)'],unverifiable:['var(--verdict-unverifiable-bg)','var(--verdict-unverifiable)','var(--texture-missing)']};
export function CompletenessBar({segments=[],total,size='md',showLegend=true,label,style}){
  const sum=total||segments.reduce((a,s)=>a+s.count,0);
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-5)',...style}}>
    {label&&<div style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{label}</div>}
    <div style={{display:'flex',height:size==='lg'?'var(--bar-height-lg)':'var(--bar-height)',border:'var(--border-hair) solid var(--rule)',borderRadius:'var(--bar-radius)',overflow:'hidden'}}>
      {segments.map((s,i)=>{const [bg,c,tex]=TONE[s.verdict]||TONE.incomplete;return <div key={i} title={s.verdict+' '+s.count} style={{flexGrow:s.count,flexBasis:0,background:bg,color:c,position:'relative'}}>{tex&&<span style={{position:'absolute',inset:0,background:tex,backgroundSize:tex.indexOf('radial')===0?'var(--texture-missing-size)':undefined,opacity:'var(--texture-opacity)'}}/>}</div>;})}
    </div>
    {showLegend&&<div style={{display:'flex',flexWrap:'wrap',gap:'var(--space-6) var(--space-8)',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-secondary)'}}>
      {segments.map((s,i)=>{const [bg,c]=TONE[s.verdict]||TONE.incomplete;return <span key={i} style={{display:'inline-flex',alignItems:'center',gap:'var(--space-4)'}}><span style={{width:9,height:9,background:bg,border:'var(--border-hair) solid '+c,flex:'none'}}/>{s.label||s.verdict} {s.count.toLocaleString()}{sum?<span style={{color:'var(--text-faint)'}}>&nbsp;/ {sum.toLocaleString()}</span>:null}</span>;})}
    </div>}
  </div>;
}