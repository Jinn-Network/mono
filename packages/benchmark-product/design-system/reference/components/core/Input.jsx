import React from 'react';
export function Input({label,hint,value,defaultValue,placeholder,mono=false,invalid=false,disabled=false,prefix,suffix,onChange,id,style,...rest}){
  const ref=React.useId();const eid=id||ref;
  return <label htmlFor={eid} style={{display:'flex',flexDirection:'column',gap:'var(--space-3)',...style}}>
    {label&&<span style={{font:'var(--type-label)',letterSpacing:'var(--tracking-caps)',textTransform:'uppercase',color:'var(--text-muted)'}}>{label}</span>}
    <span style={{display:'flex',alignItems:'center',gap:'var(--space-4)',background:'var(--surface-card)',border:'var(--border-hair) solid '+(invalid?'var(--vermilion-500)':'var(--rule-strong)'),borderRadius:'var(--radius-sm)',padding:'0 10px',opacity:disabled?.5:1}}>
      {prefix&&<span style={{font:'var(--type-data)',color:'var(--text-faint)'}}>{prefix}</span>}
      <input id={eid} value={value} defaultValue={defaultValue} placeholder={placeholder} disabled={disabled} onChange={onChange} style={{flex:1,minWidth:0,border:0,outline:'none',background:'transparent',padding:'8px 0',color:'var(--text-primary)',fontFamily:mono?'var(--font-mono)':'var(--font-ui)',fontSize:mono?'var(--text-sm)':'var(--text-base)'}} {...rest}/>
      {suffix&&<span style={{font:'var(--type-data)',color:'var(--text-faint)'}}>{suffix}</span>}
    </span>
    {hint&&<span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:invalid?'var(--vermilion-600)':'var(--text-muted)'}}>{hint}</span>}
  </label>;
}