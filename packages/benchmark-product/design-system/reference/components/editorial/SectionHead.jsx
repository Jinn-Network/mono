import React from 'react';
export function SectionHead({number,title,standfirst,actions,rule='heavy',level=2,style}){
  const H='h'+level;
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-5)',borderTop:rule==='none'?'none':'var(--border-'+(rule==='heavy'?'heavy':'hair')+') solid var(--rule'+(rule==='heavy'?'-heavy':'')+')',paddingTop:rule==='none'?0:'var(--space-6)',...style}}>
    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:'var(--space-8)'}}>
      <div style={{display:'flex',alignItems:'baseline',gap:'var(--space-6)'}}>
        {number&&<span style={{font:'var(--type-data)',color:'var(--text-faint)',flex:'none'}}>{number}</span>}
        <H style={{font:'var(--type-title)',fontSize:'var(--text-2xl)',margin:0}}>{title}</H>
      </div>
      {actions&&<div style={{display:'flex',gap:'var(--space-4)',flex:'none'}}>{actions}</div>}
    </div>
    {standfirst&&<p style={{font:'var(--type-body)',color:'var(--text-secondary)',maxWidth:'var(--measure)',margin:0}}>{standfirst}</p>}
  </div>;
}