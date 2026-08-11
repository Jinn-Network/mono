import React from 'react';
export function Select({label,hint,options=[],value,defaultValue,disabled=false,onChange,id,style}){
  const rid=React.useId();const eid=id||rid;
  return <label htmlFor={eid} style={{display:'flex',flexDirection:'column',gap:'var(--space-3)',...style}}>
    {label&&<span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>{label}</span>}
    <select id={eid} value={value} defaultValue={defaultValue} disabled={disabled} onChange={onChange} style={{appearance:'none',width:'100%',background:'var(--surface-card)',border:'var(--border-hair) solid var(--rule-strong)',borderRadius:'var(--radius-sm)',padding:'8px 28px 8px 10px',font:'var(--type-ui)',fontSize:'var(--text-sm)',color:'var(--text-primary)',opacity:disabled?.5:1,backgroundImage:'linear-gradient(45deg,transparent 50%,var(--ink-500) 50%),linear-gradient(135deg,var(--ink-500) 50%,transparent 50%)',backgroundPosition:'calc(100% - 15px) 52%,calc(100% - 10px) 52%',backgroundSize:'5px 5px,5px 5px',backgroundRepeat:'no-repeat'}}>
      {options.map(o=>{const v=typeof o==='string'?o:o.value;const l=typeof o==='string'?o:o.label;return <option key={v} value={v}>{l}</option>;})}
    </select>
    {hint&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>{hint}</span>}
  </label>;
}