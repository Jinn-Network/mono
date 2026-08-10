import React from 'react';
export function CiteBlock({tabs=[],active,onSelect,value,style}){
  const [local,setLocal]=React.useState(tabs[0]&&tabs[0].id);
  const cur=active||local;
  const item=tabs.find(t=>t.id===cur)||tabs[0];
  const body=value!=null?value:item&&item.value;
  return <div style={{border:'var(--border-hair) solid var(--rule)',borderRadius:'var(--radius-sm)',background:'var(--surface-inset)',overflow:'hidden',...style}}>
    <div style={{display:'flex',alignItems:'center',gap:'var(--space-2)',padding:'var(--space-3) var(--space-4)',borderBottom:'var(--border-hair) solid var(--rule)',background:'var(--surface-card)'}}>
      {tabs.map(t=><button key={t.id} type="button" onClick={()=>{setLocal(t.id);onSelect&&onSelect(t.id);}} style={{border:0,background:t.id===cur?'var(--surface-inset)':'transparent',color:t.id===cur?'var(--text-primary)':'var(--text-muted)',font:'var(--type-data)',fontSize:'var(--text-xs)',padding:'4px 9px',borderRadius:'var(--radius-xs)',cursor:'pointer'}}>{t.label}</button>)}
      <button type="button" onClick={()=>navigator.clipboard&&navigator.clipboard.writeText(String(body))} style={{marginLeft:'auto',border:'var(--border-hair) solid var(--rule-strong)',background:'var(--surface-card)',color:'var(--text-secondary)',font:'var(--type-data)',fontSize:'var(--text-2xs)',padding:'3px 8px',borderRadius:'var(--radius-xs)',cursor:'pointer'}}>Copy</button>
    </div>
    <pre style={{margin:0,padding:'var(--space-6) var(--space-6)',font:'var(--type-code)',color:'var(--text-secondary)',whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{body}</pre>
  </div>;
}