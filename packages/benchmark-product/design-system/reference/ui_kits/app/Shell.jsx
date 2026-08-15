const { Tag, Button } = window.__C;
const NAV=[['Benchmarks','layers'],['Task sets','list-checks'],['Entrants','git-compare'],['Evaluators','scale'],['Runs','activity'],['Reports','file-text'],['Agents','terminal'],['Billing','receipt']];
function Sidebar({active,onSelect}){
  const { Mark, Icon } = window.__K;
  return <aside style={{width:216,flex:'none',borderRight:'var(--border-hair) solid var(--rule)',background:'var(--surface-inset)',display:'flex',flexDirection:'column',height:'100%'}}>
    <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)',padding:'var(--space-7) var(--space-7) var(--space-8)'}}>
      <Mark size={18}/><span style={{fontFamily:'var(--font-display)',fontSize:'var(--text-md)'}}>Colophon</span>
    </div>
    <nav style={{display:'flex',flexDirection:'column',gap:1,padding:'0 var(--space-5)'}}>
      {NAV.map(([label,icon])=><button key={label} type="button" onClick={()=>onSelect&&onSelect(label)} style={{display:'flex',alignItems:'center',gap:'var(--space-5)',padding:'6px 10px',border:0,borderRadius:'var(--radius-sm)',background:active===label?'var(--surface-card)':'transparent',boxShadow:active===label?'inset 0 0 0 1px var(--rule)':'none',color:active===label?'var(--text-primary)':'var(--text-secondary)',font:'var(--type-ui)',fontSize:'var(--text-sm)',cursor:'pointer',textAlign:'left'}}>
        <Icon name={icon} size={15}/>{label}</button>)}
    </nav>
    <div style={{marginTop:'auto',padding:'var(--space-7)',borderTop:'var(--border-hair) solid var(--rule)',display:'flex',flexDirection:'column',gap:'var(--space-5)'}}>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)'}}>
        <span style={{width:24,height:24,borderRadius:'var(--radius-xs)',background:'var(--indigo-600)',color:'var(--ink-50)',display:'grid',placeItems:'center',font:'var(--type-data)',fontSize:'var(--text-2xs)'}}>bh</span>
        <div style={{display:'flex',flexDirection:'column',minWidth:0}}>
          <span style={{font:'var(--type-ui)',fontSize:'var(--text-xs)'}}>bench-agent</span>
          <span style={{font:'var(--type-data)',fontSize:'var(--text-2xs)',color:'var(--text-muted)'}}>delegated · spend capped</span>
        </div>
      </div>
    </div>
  </aside>;
}
function Topbar({title,crumb,actions}){
  const { Icon } = window.__K;
  return <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-7)',padding:'var(--space-6) var(--space-9)',borderBottom:'var(--border-hair) solid var(--rule)',background:'var(--surface-page)'}}>
    <div style={{display:'flex',flexDirection:'column',gap:2,minWidth:0}}>
      <span style={{font:'var(--type-data)',fontSize:'var(--text-2xs)',color:'var(--text-muted)'}}>{crumb}</span>
      <h1 style={{font:'var(--type-section)',fontSize:'var(--text-xl)',margin:0}}>{title}</h1>
    </div>
    <div style={{display:'flex',alignItems:'center',gap:'var(--space-5)'}}>{actions}</div>
  </header>;
}
function StepRail({steps,current}){
  return <ol style={{display:'flex',listStyle:'none',margin:0,padding:0,borderBottom:'var(--border-hair) solid var(--rule)',background:'var(--surface-page)'}}>
    {steps.map((s,i)=>{const state=i<current?'done':i===current?'now':'todo';
      return <li key={s} style={{flex:1,padding:'var(--space-5) var(--space-7)',borderTop:'var(--border-slab) solid '+(state==='now'?'var(--vermilion-500)':state==='done'?'var(--ink-900)':'var(--rule)'),display:'flex',gap:'var(--space-5)',alignItems:'baseline'}}>
        <span style={{font:'var(--type-data)',fontSize:'var(--text-2xs)',color:'var(--text-faint)'}}>{String(i+1).padStart(2,'0')}</span>
        <span style={{font:'var(--type-ui)',fontSize:'var(--text-sm)',color:state==='todo'?'var(--text-faint)':'var(--text-primary)',fontWeight:state==='now'?600:400}}>{s}</span>
      </li>;})}
  </ol>;
}
Object.assign(window.__K,{Sidebar,Topbar,StepRail});