import React from 'react';
export function MethodLock({state='locked',digest,timestamp,detailHref,compact=false,style}){
  const S={draft:['Method open','Changes still affect the official result.','var(--verdict-unverifiable)'],locked:['Method locked before execution','No change after this point is reflected in the official result.','var(--verdict-attested)'],amended:['Method amended after lock','The amendment and its reason are recorded in full.','var(--verdict-conflicted)']}[state];
  return <div style={{display:'flex',gap:'var(--space-6)',alignItems:'flex-start',padding:compact?'var(--space-5) var(--space-6)':'var(--space-6) var(--space-7)',background:'var(--surface-inset)',borderTop:'var(--border-heavy) solid '+S[2],...style}}>
    <div style={{display:'flex',flexDirection:'column',gap:'var(--space-3)',minWidth:0,flex:1}}>
      <span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:S[2]}}>{S[0]}</span>
      {!compact&&<span style={{font:'var(--type-ui)',fontSize:'var(--text-sm)',color:'var(--text-secondary)'}}>{S[1]}</span>}
      {(digest||timestamp)&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)',wordBreak:'break-all'}}>{digest}{digest&&timestamp?' · ':''}{timestamp}</span>}
    </div>
    {detailHref&&<a href={detailHref} style={{flex:'none',font:'var(--type-data)',fontSize:'var(--text-xs)'}}>Method</a>}
  </div>;
}