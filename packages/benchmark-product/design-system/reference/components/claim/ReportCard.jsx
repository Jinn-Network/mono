import React from 'react';
export function ReportCard({title,suite,date,entrants=[],status='observed',footer,width=600,style}){
  const S={observed:['Observed by Colophon','var(--verdict-met)'],attested:['Self-reported execution','var(--verdict-attested)'],conflicted:['Contains conflicted results','var(--verdict-conflicted)'],incomplete:['Incomplete accounting','var(--verdict-incomplete)']}[status];
  const max=Math.max(...entrants.map(e=>e.score||0),1);
  return <article style={{width,background:'var(--surface-card)',border:'var(--border-hair) solid var(--rule-strong)',borderTop:'var(--border-slab) solid var(--rule-accent)',display:'flex',flexDirection:'column',...style}}>
    <div style={{padding:'var(--space-8) var(--space-8) var(--space-6)',display:'flex',flexDirection:'column',gap:'var(--space-4)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-4)',font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>
        <span style={{color:'var(--vermilion-500)',display:'inline-flex'}}><svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><rect x="12.5" y="1.5" width="7" height="7" transform="rotate(45 16 5)"/><rect x="2.5" y="19.5" width="7" height="7" transform="rotate(45 6 23)"/><rect x="22.5" y="19.5" width="7" height="7" transform="rotate(45 26 23)"/></svg></span>Colophon report
      </div>
      <h2 style={{font:'var(--type-title)',fontSize:'var(--text-2xl)',margin:0,letterSpacing:'var(--tracking-tight)'}}>{title}</h2>
      <div style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-secondary)'}}>{suite}{suite&&date?' · ':''}{date}</div>
    </div>
    <div style={{padding:'0 var(--space-8) var(--space-7)',display:'flex',flexDirection:'column',gap:'var(--space-5)'}}>
      {entrants.map((e,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:'var(--space-6)'}}>
        <span style={{flex:'none',width:'34%',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e.name}</span>
        <span style={{flex:1,height:'var(--bar-height)',background:'var(--surface-inset)',border:'var(--border-hair) solid var(--rule)',position:'relative'}}>
          <span style={{position:'absolute',inset:'0 auto 0 0',width:(100*(e.score||0)/max)+'%',background:i===0?'var(--vermilion-500)':'var(--ink-400)'}}/>
        </span>
        <span style={{flex:'none',font:'var(--type-data)',fontSize:'var(--text-sm)',color:'var(--text-primary)',minWidth:64,textAlign:'right'}}>{e.display||e.score}</span>
      </div>)}
    </div>
    <div style={{marginTop:'auto',padding:'var(--space-6) var(--space-8)',borderTop:'var(--border-hair) solid var(--rule)',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-6)',font:'var(--type-data)',fontSize:'var(--text-xs)'}}>
      <span style={{color:S[1]}}>{S[0]}</span>
      <span style={{color:'var(--text-faint)'}}>{footer||'Full method and accounting in the report.'}</span>
    </div>
  </article>;
}