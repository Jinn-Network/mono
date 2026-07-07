/* 1405 — jinn-agent first-run onboarding · interactive console + static renders (vanilla JS) */
(function(){
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const W = (cls,s) => `<span class="${cls}">${s}</span>`;
  const sky=s=>W('sky',s), skyh=s=>W('skyh',s), gold=s=>W('gold',s), dim=s=>W('dim',s),
        green=s=>W('green',s), amber=s=>W('amber',s), red=s=>W('red',s), b=s=>W('b',s),
        fg=s=>W('fg',s), kbd=s=>W('kbd',s);

  // ---------- boxed panel helpers (from 1312) ----------
  function boxTop(IW, title){
    if(!title) return sky('┌'+'─'.repeat(IW+2)+'┐');
    const t=' '+title+' ';
    return sky('┌─'+t+'─'.repeat(Math.max(0,IW+1-t.length))+'┐');
  }
  function boxMid(IW, title){
    if(!title) return sky('├'+'─'.repeat(IW+2)+'┤');
    const t=' '+title+' ';
    return sky('├─'+t+'─'.repeat(Math.max(0,IW+1-t.length))+'┤');
  }
  function boxBot(IW){ return sky('└'+'─'.repeat(IW+2)+'┘'); }
  function boxLine(IW, segs){
    const raw = segs.map(s=>s[0]).join('');
    const pad = ' '.repeat(Math.max(0, IW - raw.length));
    const html = segs.map(s=> s[1] ? W(s[1], esc(s[0])) : esc(s[0])).join('');
    return sky('│ ')+html+pad+sky(' │');
  }

  // ---------- shared chrome ----------
  const rule = dim('─'.repeat(70));

  // step rail: completed green · current gold · future dim · skipped amber
  const STEPS = ['consent','publish','rewards','signals'];
  function railFor(current, statuses={}){
    // statuses: {consent:'done'|'skipped'…}; current = index or -1
    const parts = STEPS.map((name,i)=>{
      const st = statuses[name];
      if(st==='done') return green(name);
      if(st==='skipped') return amber(name);
      if(i===current) return gold(name);
      return dim(name);
    });
    return parts.join(dim('  ·  '));
  }
  function stepHead(n, label, statuses){
    return [
      sky('◇')+' '+b(fg('jinn-agent'))+dim('  ·  first run  ·  ')+gold(`step ${n} of 4`)+dim('  ·  ')+fg(label),
      '  '+railFor(n-1, statuses),
      rule,
    ].join('\n');
  }

  // compact banner (derived from the 1319 splash — same sigil, tighter)
  const banner = [
    sky('        ╭───────────────╮'),
    sky('     ╭──╯       ╱╲        ╰──╮'),
    sky('    ╱         ╱    ╲          ╲'),
    sky('   │        ╱        ╲         │'),
    sky(' ──┼──────╱─────')+gold('•')+sky('──────╲────────┼──'),
    sky('   │     ╱              ╲      │'),
    sky('    ╲   ╱________________╲    ╱'),
    sky('     ╰──╮                ╭──╯'),
    sky('        ╰────────────────╯'),
    '',
    '           '+b(fg('j i n n')),
    '        '+gold('────────────────'),
    '  '+dim('an open agentic knowledge economy'),
    '        '+gold('jinn-agent v0.4.2')+dim(' · ')+sky('testnet'),
  ].join('\n');

  // =========================================================================
  // STATE MACHINE
  // =========================================================================
  const S = {};

  S.splash = {
    cap:'launch · first boot', keys:[['Enter','begin'],['S','skip setup']],
    render:()=>[
      banner, '',
      '     '+dim('──────────────  first run  ──────────────'), '',
      dim('  network        ')+sky('base-sepolia · testnet'),
      dim('  corpus         ')+green('connected · 1,284,902 envelopes'),
      dim('  node           ')+dim('not running'), '',
      dim('  Four short steps: consent, your first publish, rewards, and the'),
      dim('  in-session corpus signal. Each runs once and is remembered.'),
      '',
      '  '+kbd('[Enter]')+fg(' Begin')+'      '+kbd('[S]')+dim(' Skip setup — ask again next launch'),
    ].join('\n'),
    on:{ enter:'consent', s:'skippedAll' }
  };

  S.skippedAll = {
    cap:'setup skipped', keys:[['R','restart flow']],
    render:()=>[
      sky('◇')+' '+b(fg('jinn-agent'))+dim('  ·  first run'), '',
      dim('  Setup skipped. Nothing was decided — capture stays ')+fg('off')+dim(' until'),
      dim('  consent is granted. The steps return next launch, or any time:'),
      '',
      '  '+sky('jinn-agent onboarding'), '',
      '  '+kbd('[R]')+dim(' Replay from the start'),
    ].join('\n'),
    on:{ r:'splash' }
  };

  // ---- step 1 · consent (1312, reused verbatim) ----
  S.consent = {
    cap:'step 1 · consent (1312 verbatim)', keys:[['A','accept'],['D','decline'],['P','preview'],['S','skip']],
    render:()=>[
      stepHead(1,'contribute?',{}),
      '',
      fg('  Contribute to the open corpus?'),
      '',
      dim('  jinn-agent is an open coding harness. When it finishes a task it can'),
      dim('  publish a scrubbed trace of that task to a public corpus — the shared'),
      dim('  record that trains the harness everyone runs.'),
      '',
      sky('  WHY TURN IT ON'),
      '  '+dim('· ')+fg('Build the open harness')+dim(' — your tasks improve the agent no one company owns.'),
      '  '+dim('· ')+fg('Earn rewards')+dim(' — verified contributions earn ')+gold('OLAS')+dim('.'),
      '  '+dim('· ')+fg('Two-way')+dim(' — you read from the same corpus you feed.'),
      '',
      sky('  WHAT LEAVES THIS MACHINE'),
      '  '+dim('· Only traces of tasks ')+fg('this harness runs')+dim(' — never your machine, shell,'),
      '  '+dim('  files, or anything outside a task.'),
      '  '+dim('· Every trace is scrubbed of secrets and personal data ')+fg('here, first')+dim('.'),
      '  '+dim('  If scrubbing can\u2019t finish, nothing sends. It ')+fg('fails closed')+dim('.'),
      '  '+dim('· You can ')+fg('veto any task')+dim(', and ')+fg('preview')+dim(' the exact payload before the first send.'),
      '',
      dim('  Decline and jinn-agent still works fully — as a reader.'),
      '',
      rule,
      '  '+kbd('[A]')+fg(' Accept & contribute')+'      '+kbd('[P]')+fg(' Preview a real payload'),
      '  '+kbd('[D]')+dim(' Decline · read only')+'      '+kbd('[S]')+dim(' Skip — decide later'),
      '',
      dim('  consent: ')+amber('unset')+dim('   ·   capture is off until granted'),
    ].join('\n'),
    on:{ a:'consentConfirm', d:'consentOff', s:'firstTaskNoConsent', enter:'consentOff' }
  };

  S.consentConfirm = {
    cap:'step 1 · confirm', keys:[['Y','yes'],['N','no']],
    render:()=>[
      stepHead(1,'contribute?',{}),
      '',
      gold('  CONFIRM'),
      '',
      fg('  Turn on contribution?'),
      '',
      dim('  Every task this harness runs will be scrubbed and published to the'),
      dim('  public corpus. You can veto any task, and turn this off any time.'),
      '',
      '  '+kbd('[Y]')+fg(' Yes, turn on contribution')+'     '+kbd('[N]')+dim(' No, go back'),
    ].join('\n'),
    on:{ y:'consentOn', n:'consent', escape:'consent' }
  };

  S.consentOn = {
    cap:'step 1 · recorded — on', keys:[['Enter','continue']],
    render:()=>[
      stepHead(1,'contribute?',{}),
      '',
      green('  recorded')+dim(' — contribution is ')+green('ON'),
      '',
      dim('  Scrubbed task traces will publish to the public corpus. Nothing'),
      dim('  publishes until you preview once — press ')+kbd('P')+dim(' any time to see the'),
      dim('  next payload before it sends.'),
      '',
      dim('  Manage:  ')+sky('jinn-agent contribute --off')+dim('  |  ')+sky('veto <task>')+dim('  |  ')+sky('ledger'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Continue — step 2 · your first publish'),
    ].join('\n'),
    on:{ enter:'firstTask' }
  };

  S.consentOff = {
    cap:'step 1 · recorded — off', keys:[['Enter','continue']],
    render:()=>[
      stepHead(1,'contribute?',{}),
      '',
      sky('  recorded')+dim(' — contribution is ')+fg('OFF · reader only'),
      '',
      dim('  This harness will run tasks and read the corpus, and will publish'),
      dim('  nothing. No trace leaves this machine.'),
      '',
      dim('  Turn on any time:  ')+sky('jinn-agent contribute --on'),
      '',
      dim('  Steps 2 and 3 cover publishing and rewards — they apply only when'),
      dim('  contribution is on, so they\u2019re set aside. Step 4 still applies:'),
      dim('  reading the corpus is on for everyone.'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Continue — step 4 · corpus signals'),
    ].join('\n'),
    on:{ enter:'skillSignalOff' }
  };

  // ---- step 2 · first publish ----
  S.firstTask = {
    cap:'step 2 · waiting on first task', keys:[['Enter','run a task'],['S','skip']],
    render:()=>[
      stepHead(2,'your first publish',{consent:'done'}),
      '',
      fg('  Run your first task.'),
      '',
      dim('  This step completes on its own when your first task finishes and'),
      dim('  its trace publishes. Nothing to configure — just work:'),
      '',
      '  '+dim('$ ')+fg('jinn-agent ')+skyh('"fix the flaky retry test in http/client.py"'),
      '',
      dim('  Onboarding stays out of the way until then.'),
      '',
      rule,
      '  '+kbd('[Enter]')+dim(' (walkthrough: simulate the task finishing)')+'      '+kbd('[S]')+dim(' Skip'),
    ].join('\n'),
    on:{ enter:'published', s:'olas' }
  };

  S.published = {
    cap:'step 2 · captured + published', keys:[['Enter','continue'],['V','veto instead']],
    render:()=>{
      const IW=62;
      return [
        stepHead(2,'your first publish',{consent:'done'}),
        '',
        dim('  …task complete · 4 passed in 2.1s · suite green'),
        '',
        green('  contribution')+dim(' · captured — scrubbed ')+green('ok')+dim(' (12 secrets removed · 3 paths anonymised)'),
        '',
        boxTop(IW,'published — your first contribution'),
        boxLine(IW,[['task        ',''],['fix flaky retry in http client','fg']]),
        boxLine(IW,[['tier        ',''],['tests-passed','green']]),
        boxLine(IW,[['envelope    ',''],['bafkreid6qv\u2026shxv4','sky'],['  ·  ipfs','dim']]),
        boxLine(IW,[['anchor      ',''],['0x7a2f\u2026c019','sky'],['  ·  base-sepolia · erc-8004','dim']]),
        boxMid(IW),
        boxLine(IW,[['view it     ',''],['explorer.jinn.network/corpus/bafkreid6qv\u2026shxv4','gold']]),
        boxBot(IW),
        '',
        dim('  That page is public — anyone can read the trace, follow its content'),
        dim('  ref, and check its anchor. Your ledger: ')+sky('jinn-agent ledger'),
        '',
        rule,
        '  '+kbd('[Enter]')+fg(' Continue — step 3 · rewards')+'      '+kbd('[V]')+dim(' Veto — pull it back'),
      ].join('\n');
    },
    on:{ enter:'olas', v:'published' }
  };

  S.publishFailed = {
    cap:'step 2 · error — publish failed', keys:[['R','retry'],['V','veto'],['Enter','continue']],
    render:()=>[
      stepHead(2,'your first publish',{consent:'done'}),
      '',
      dim('  …task complete · 4 passed in 2.1s · suite green'),
      '',
      green('  contribution')+dim(' · captured — scrubbed ')+green('ok'),
      red('  publish failed — retained locally'),
      '',
      dim('  The envelope is assembled and kept on this machine. The anchor was'),
      dim('  not written. Nothing partial was sent.'),
      '',
      '  '+kbd('[R]')+fg(' Retry now')+'      '+kbd('[V]')+dim(' Veto — keep local')+'      '+kbd('[Enter]')+dim(' Continue — retries in background'),
      '',
      dim('  Step 2 stays open until a publish lands; onboarding won\u2019t repeat'),
      dim('  this screen — the retry runs quietly and confirms when it lands.'),
    ].join('\n'),
    on:{ r:'published', enter:'olas', v:'olas' }
  };

  // ---- step 3 · rewards ----
  S.olas = {
    cap:'step 3 · rewards — none yet', keys:[['Enter','continue'],['S','skip']],
    render:()=>[
      stepHead(3,'rewards',{consent:'done',publish:'done'}),
      '',
      fg('  OLAS earned: ')+dim('none yet.'),
      '',
      dim('  Publication alone does not pay. OLAS accrues when an evaluator'),
      dim('  scores one of your published traces under bond — verification'),
      dim('  triggers it, and it is not guaranteed.'),
      '',
      dim('  Your first trace is published at tier ')+green('tests-passed')+dim('. If an'),
      dim('  evaluator verifies it, the tier moves to ')+gold('evaluator-verified'),
      dim('  and the reward lands on your operator address.'),
      '',
      dim('  Check any time:  ')+sky('jinn-agent rewards'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Continue — step 4 · corpus signals')+'      '+kbd('[S]')+dim(' Skip'),
    ].join('\n'),
    on:{ enter:'skillSignal', s:'skillSignal' }
  };

  S.olasEarned = {
    cap:'step 3 · rewards — earned variant', keys:[['Enter','continue']],
    render:()=>[
      stepHead(3,'rewards',{consent:'done',publish:'done'}),
      '',
      fg('  OLAS earned: ')+gold('12.40 OLAS')+dim(' · 3 traces evaluator-verified.'),
      '',
      dim('  Paid on verification, not publication: an evaluator scored those'),
      dim('  traces under bond. Details and per-trace provenance:'),
      '',
      dim('  ')+sky('jinn-agent rewards')+dim('   ·   each entry links its evaluation and anchor tx.'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Continue — step 4 · corpus signals'),
    ].join('\n'),
    on:{ enter:'skillSignal' }
  };

  // ---- step 4 · corpus signals ----
  function skillSignalBody(statuses, exitKey){
    return [
      stepHead(4,'corpus signals',statuses),
      '',
      fg('  When a run draws on the corpus, you\u2019ll see it.'),
      '',
      dim('  Any time this harness uses a network skill or another operator\u2019s'),
      dim('  contribution inside your own run, one line marks it at the point'),
      dim('  of use — like this:'),
      '',
      '  '+sky('◇ corpus')+'  '+fg('using ')+skyh('retry-backoff-patterns')+dim('  ·  learned from 214 contributions  ·  ')+sky('env bafkr\u2026hx2c'),
      '',
      dim('  One line per use, in the scrying as it happens. Every line carries'),
      dim('  the envelope ref, so the claim is checkable — nothing uses the'),
      dim('  corpus invisibly.'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Finish'),
    ].join('\n');
  }
  S.skillSignal = {
    cap:'step 4 · corpus signals', keys:[['Enter','finish']],
    render:()=>skillSignalBody({consent:'done',publish:'done',rewards:'done'}),
    on:{ enter:'done' }
  };
  S.skillSignalOff = {
    cap:'step 4 · corpus signals (reader only)', keys:[['Enter','finish']],
    render:()=>skillSignalBody({consent:'done',publish:'skipped',rewards:'skipped'}),
    on:{ enter:'doneOff' }
  };

  // ---- done ----
  S.done = {
    cap:'complete', keys:[['R','replay']],
    render:()=>[
      sky('◇')+' '+b(fg('jinn-agent'))+dim('  ·  first run  ·  ')+green('complete'),
      '  '+railFor(-1,{consent:'done',publish:'done',rewards:'done',signals:'done'}),
      rule,
      '',
      dim('  Done. These steps are remembered on this machine and won\u2019t repeat.'),
      '',
      dim('  contribution   ')+green('on'),
      dim('  first publish  ')+sky('bafkreid6qv\u2026shxv4'),
      dim('  rewards        ')+dim('explained · none yet'),
      dim('  signals        ')+dim('shown'),
      '',
      dim('  Replay any time: ')+sky('jinn-agent onboarding --replay')+dim('  (never re-asks consent)'),
      '',
      '  '+kbd('[R]')+dim(' Replay the walkthrough'),
    ].join('\n'),
    on:{ r:'splash' }
  };
  S.doneOff = {
    cap:'complete — reader only', keys:[['R','replay']],
    render:()=>[
      sky('◇')+' '+b(fg('jinn-agent'))+dim('  ·  first run  ·  ')+green('complete'),
      '  '+railFor(-1,{consent:'done',publish:'skipped',rewards:'skipped',signals:'done'}),
      rule,
      '',
      dim('  Done. Contribution is ')+fg('off · reader only')+dim(' — no trace leaves this'),
      dim('  machine. If you turn it on later (')+sky('jinn-agent contribute --on')+dim('),'),
      dim('  the publish and rewards steps run then, once.'),
      '',
      '  '+kbd('[R]')+dim(' Replay the walkthrough'),
    ].join('\n'),
    on:{ r:'splash' }
  };

  // ---- variant: consent skipped, task runs anyway ----
  S.firstTaskNoConsent = {
    cap:'consent skipped · capture stays off', keys:[['Enter','continue']],
    render:()=>[
      stepHead(1,'contribute?',{consent:'skipped'}),
      '',
      amber('  skipped')+dim(' — consent stays ')+amber('unset')+dim('. Capture is off: no trace is'),
      dim('  recorded or sent while unset. The question returns next launch.'),
      '',
      dim('  Decide any time:  ')+sky('jinn-agent contribute'),
      '',
      rule,
      '  '+kbd('[Enter]')+fg(' Continue — step 4 · corpus signals'),
    ].join('\n'),
    on:{ enter:'skillSignalOff' }
  };

  // ---- returning operator ----
  S.returning = {
    cap:'returning operator · nothing repeats', keys:[['R','replay walkthrough']],
    render:()=>[
      banner, '',
      '     '+dim('──────────────  the ether  ──────────────'), '',
      dim('  network        ')+sky('base-sepolia · testnet'),
      dim('  corpus         ')+green('connected · 1,284,902 envelopes'),
      dim('  contribution   ')+green('on · 37 traces published'),
      dim('  node           ')+green('running · vessel-0x91be\u202644a2'), '',
      dim('  No first-run steps: consent is recorded and the ledger is not'),
      dim('  empty, so onboarding derives every step as done and renders'),
      dim('  nothing. This launch is identical to any other.'),
      '',
      '  '+kbd('[R]')+dim(' (walkthrough only) Replay from the start'),
    ].join('\n'),
    on:{ r:'splash' }
  };

  // ---------- driver ----------
  const termEl = document.getElementById('flow');
  const keyhintsEl = document.getElementById('keyhints');
  const capEl = document.getElementById('flowcap');
  const jumpEl = document.getElementById('statejump');
  let cur = 'splash';

  const JUMPS = [
    ['splash','launch'],['consent','1 · consent'],['consentOn','1 · on'],['consentOff','1 · off'],
    ['firstTask','2 · waiting'],['published','2 · published'],['publishFailed','2 · error'],
    ['olas','3 · none yet'],['olasEarned','3 · earned'],['skillSignal','4 · signals'],
    ['done','done'],['returning','returning op'],
  ];

  function draw(){
    const st = S[cur];
    termEl.innerHTML = st.render();
    capEl.textContent = st.cap;
    keyhintsEl.innerHTML = st.keys.map(([k,label])=>
      `<button class="keyhint" data-key="${k.toLowerCase()}"><span class="k">${k}</span>${label}</button>`).join('');
    keyhintsEl.querySelectorAll('.keyhint').forEach(btn=>{
      btn.addEventListener('click', ()=>{ fire(btn.dataset.key); termEl.focus(); });
    });
    jumpEl.querySelectorAll('button').forEach(b2=> b2.dataset.on = (b2.dataset.state===cur)?'true':'false');
  }
  function fire(key){
    const st = S[cur];
    const next = st.on[key==='enter'?'enter':key];
    if(next && S[next]){ cur = next; draw(); }
  }
  termEl.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){ e.preventDefault(); return fire('enter'); }
    if(e.key==='Escape'){ return fire('escape'); }
    const lk = e.key.toLowerCase();
    if(/^[a-z?]$/.test(lk)) fire(lk);
  });
  JUMPS.forEach(([state,label])=>{
    const btn=document.createElement('button');
    btn.textContent=label; btn.dataset.state=state;
    btn.addEventListener('click', ()=>{ cur=state; draw(); termEl.focus(); });
    jumpEl.appendChild(btn);
  });
  draw();

  // =========================================================================
  // STATIC — chrome anatomy render (step 2 published, annotated by caption)
  // =========================================================================
  document.getElementById('chrome-anatomy').innerHTML = S.published.render();

  // in-session signal strip (as it appears mid-run, outside onboarding)
  document.getElementById('signal-strip').innerHTML = [
    dim('  \u2026'),
    dim('  edit    http/client.py · +14 −6'),
    '  '+sky('◇ corpus')+'  '+fg('using ')+skyh('retry-backoff-patterns')+dim('  ·  learned from 214 contributions  ·  ')+sky('env bafkr\u2026hx2c'),
    dim('  bash    pytest -k retry — 4 passed'),
    dim('  \u2026'),
  ].join('\n');
})();
