const { Tag, MethodLock } = window.__C;
function ReportHeader({onNav}){
  const { Mark, Icon } = window.__K;
  return <header style={{borderBottom:'var(--border-hair) solid var(--rule)',background:'var(--surface-page)',position:'sticky',top:0,zIndex:5}}>
    <div style={{maxWidth:'var(--report-max)',margin:'0 auto',padding:'var(--space-6) var(--gutter)',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-6)'}}>
      <a href="#" style={{display:'flex',alignItems:'center',gap:'var(--space-5)',textDecoration:'none'}}>
        <Mark size={20}/><span style={{fontFamily:'var(--font-display)',fontSize:'var(--text-lg)',color:'var(--text-primary)',letterSpacing:'var(--tracking-snug)'}}>Colophon</span>
      </a>
      <nav style={{display:'flex',alignItems:'center',gap:'var(--space-7)',font:'var(--type-ui)',fontSize:'var(--text-sm)'}}>
        {['Method','Accounting','Evidence','Cite'].map(s=><a key={s} href={'#'+s.toLowerCase()} onClick={e=>{e.preventDefault();onNav&&onNav(s);}} style={{color:'var(--text-secondary)',textDecoration:'none'}}>{s}</a>)}
        <Tag tone="ink">Published</Tag>
      </nav>
    </div>
  </header>;
}
function ReportMasthead({report}){
  return <div style={{display:'flex',flexDirection:'column',gap:'var(--space-7)',paddingTop:'var(--space-12)'}}>
    <div style={{display:'flex',gap:'var(--space-6)',flexWrap:'wrap',font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>
      <span>Colophon report</span><span>·</span><span>{report.suite}</span><span>·</span><span>{report.date}</span><span>·</span><span>{report.id}</span>
    </div>
    <h1 style={{font:'var(--type-hero)',fontSize:'var(--text-4xl)',letterSpacing:'var(--tracking-tight)',margin:0,maxWidth:'18ch'}}>{report.title}</h1>
    <p style={{font:'var(--type-body)',fontSize:'var(--text-lg)',color:'var(--text-secondary)',maxWidth:'var(--measure)',margin:0}}>{report.standfirst}</p>
    <div style={{display:'flex',gap:'var(--space-6)',flexWrap:'wrap',alignItems:'center'}}>
      <span style={{font:'var(--type-data)',fontSize:'var(--text-xs)',color:'var(--text-muted)'}}>Sponsored by <a href="#">{report.sponsor}</a></span>
    </div>
    <MethodLock state="locked" digest={report.digest} timestamp={report.lockedAt} detailHref="#method"/>
  </div>;
}
Object.assign(window.__K,{ReportHeader,ReportMasthead});
