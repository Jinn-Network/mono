/* 1490 — jinn-agent local distillation · consent + control + run · interactive consoles + static renders (vanilla JS) */
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
  const promptSigil = sky('◇')+' '+b(fg('jinn-agent'))+dim('  ·  distil  ·  first run');
  const rule = dim('─'.repeat(70));

  // ---------- shared data ----------
  // Eligible captures — local task traces this harness ran (same flavour as the 1312 ledger).
  const CAPTURES = [
    ['fix flaky retry in http client', '2h ago',  '18 turns'],
    ['add retry budget to client',     '1d ago',  '11 turns'],
    ['harden json schema validation',  '1d ago',  '23 turns'],
    ['wire up structured logging',     '2d ago',  '14 turns'],
    ['patch panic on empty payload',   '3d ago',  '9 turns'],
    ['null-deref in markdown parser',  '4d ago',  '16 turns'],
  ];
  // Skills distilled — name + source-capture provenance.
  const SKILLS = [
    {name:'retry-backoff-patterns',   prov:'fix flaky retry · retry budget'},
    {name:'json-schema-hardening',    prov:'json schema hardening'},
    {name:'structured-logging-setup', prov:'structured logging'},
    {name:'nil-guard-defensive',      prov:'empty-payload panic · md null-deref'},
  ];

  // skills box — per-skill install state (word, not glyph) + name, then provenance line
  function skillsBox(IW, installed){
    const lines=[];
    SKILLS.forEach((s,i)=>{
      const on = installed.has(i);
      const stateTxt = (on?'installed':'not installed').padEnd(14);
      const stateCls = on?'green':'dim';
      lines.push(boxLine(IW,[[stateTxt,stateCls],[s.name,'skyh']]));
      lines.push(boxLine(IW,[[' '.repeat(14),''],['from  ','dim'],[s.prov,'dim']]));
      if(i<SKILLS.length-1) lines.push(boxLine(IW,[['','']]));
    });
    return lines.join('\n');
  }

  // =========================================================================
  // 1a — CONSENT + WHERE IT RUNS  (state machine, mirrors 1312's pattern)
  // =========================================================================
  const C = {};

  C.unset = {
    stage:'idle',
    keys:[['L','local'],['F','defer'],['O','off'],['P','preview']],
    render:()=>[
      promptSigil, '',
      fg('  Distil your recent tasks into skills?'),
      '',
      dim('  A frontier-class model reads the tasks you\u2019ve run here, once, and'),
      dim('  pulls out reusable skills — later tasks then reuse them on a small,'),
      dim('  cheap model. Pay the heavy pass once; reuse the skills for free.'),
      '',
      sky('  READS')+'    '+fg('6 captures')+dim(' this run — the tasks you\u2019ve run here so far,'),
      '           '+dim('more as you work. Nothing else; ')+kbd('P')+dim(' shows the exact set.'),
      '',
      sky('  COSTS')+'    '+dim('one pass — heavy compute, ')+fg('not money')+dim('. ~')+fg('9 min')+dim(' with your'),
      '           '+dim('distiller, ')+fg('llama-4-405b')+dim(' (local). Pick another with ')+sky('--distiller')+dim('.'),
      '',
      sky('  LEAVES')+'   '+fg('nothing')+dim(' — read, distilled, and written here; nothing is'),
      '           '+dim('published to the network. A hosted ')+sky('--distiller')+dim(' would send'),
      '           '+dim('captures out; jinn-agent names it and asks first.'),
      '',
      rule,
      '  '+kbd('[L]')+fg(' Local')+dim('  distil now')+'      '+kbd('[F]')+dim(' Defer  hold, run nothing')+'      '+kbd('[O]')+dim(' Off'),
      '  '+kbd('[P]')+fg(' Preview')+dim(' the exact captures and distiller'),
      '',
      dim('  distil: ')+amber('unset')+dim('   ·   default is defer — nothing runs, nothing is spent'),
    ].join('\n'),
    on:{ l:'confirmLocal', f:'recordedDefer', o:'recordedOff', p:'preview', enter:'recordedDefer' }
  };

  C.preview = {
    stage:'idle',
    keys:[['L','run local'],['B','back']],
    render:()=>{
      const IW=54;
      const caps = CAPTURES.map(([task,when,size])=>
        boxLine(IW,[[when.padEnd(9),'dim'],[task.padEnd(32),'fg'],[size,'dim']]));
      const box=[
        boxTop(IW,'captures · read locally, never sent'),
        ...caps,
        boxMid(IW,'distiller · your choice'),
        boxLine(IW,[['llama-4-405b  ','fg'],['local · frontier-class · ','dim'],['default','green']]),
        boxLine(IW,[['gpt-5.4       ','dim'],['hosted · frontier · ','dim'],['sends captures out','amber']]),
        boxLine(IW,[['set  ','dim'],['jinn-agent distil --distiller <model>','sky']]),
        boxMid(IW,'estimate · llama-4-405b'),
        boxLine(IW,[['~9 min · one pass','fg'],['  ·  no money, nothing sent','dim']]),
        boxBot(IW),
      ].join('\n');
      return [
        promptSigil, '',
        gold('  PREVIEW — NOTHING RUNS FROM THIS SCREEN'),
        dim('  The exact captures distillation would read, the distiller it'),
        dim('  would use (yours to change), and the estimate — everything it touches.'),
        '',
        box,
        '',
        dim('  With the local default, none of this leaves the machine.'),
        '',
        '  '+kbd('[L]')+fg(' Run local now')+'     '+kbd('[B]')+dim(' Back'),
      ].join('\n');
    },
    on:{ l:'confirmLocal', b:'unset' }
  };

  C.confirmLocal = {
    stage:'confirming',
    keys:[['Y','yes'],['N','no']],
    render:()=>[
      promptSigil, '',
      gold('  CONFIRM'),
      '',
      fg('  Run distillation now?'),
      '',
      dim('  One frontier pass with ')+fg('llama-4-405b')+dim(' over ')+fg('6 captures')+dim(', here on'),
      dim('  this machine. About ')+fg('~9 min')+dim(' of heavy compute — no money, nothing'),
      dim('  sent. Stop any time; whatever finished is kept.'),
      '',
      '  '+kbd('[Y]')+fg(' Yes, run now')+'     '+kbd('[N]')+dim(' No, go back'),
      '',
      dim('  distil: ')+amber('unset')+dim('  →  action: ')+gold('confirming'),
    ].join('\n'),
    on:{ y:'recordedLocal', n:'unset', escape:'unset' }
  };

  C.recordedLocal = {
    stage:'recorded',
    keys:[['R','replay']],
    render:()=>[
      promptSigil, '',
      green('  recorded')+dim(' — distil mode is ')+green('LOCAL'),
      '',
      dim('  Distillation runs on this machine with a frontier-class model. The'),
      dim('  first run is shown below — section 1b.'),
      '',
      dim('  Change any time  ·  ')+sky('jinn-agent distil --where defer')+dim('  |  ')+sky('--where off'),
      '',
      rule,
      '  '+kbd('[R]')+dim(' Replay'),
    ].join('\n'),
    on:{ r:'unset' }
  };

  C.recordedDefer = {
    stage:'recorded',
    keys:[['R','replay']],
    render:()=>[
      promptSigil, '',
      sky('  recorded')+dim(' — distil mode is ')+fg('DEFERRED'),
      '',
      dim('  Your 6 captures are held on this machine. Nothing runs, nothing is'),
      dim('  spent, and nothing is published to the Jinn network.'),
      '',
      dim('  Later, the bonded network will be able to distil a contributed'),
      dim('  signal for you — you\u2019ll be asked before anything leaves. Not yet.'),
      '',
      dim('  Run locally instead  ·  ')+sky('jinn-agent distil --where local'),
      '',
      rule,
      '  '+kbd('[R]')+dim(' Replay'),
    ].join('\n'),
    on:{ r:'unset' }
  };

  C.recordedOff = {
    stage:'recorded',
    keys:[['R','replay']],
    render:()=>[
      promptSigil, '',
      sky('  recorded')+dim(' — distil is ')+fg('OFF'),
      '',
      dim('  Distillation is disabled and no captures are reserved for it. Nothing'),
      dim('  the harness already keeps is deleted — this only turns distilling off.'),
      '',
      dim('  Turn it on any time  ·  ')+sky('jinn-agent distil --where local')+dim('  |  ')+sky('--where defer'),
      '',
      rule,
      '  '+kbd('[R]')+dim(' Replay'),
    ].join('\n'),
    on:{ r:'unset' }
  };

  // =========================================================================
  // 1b — THE RUN  (jinn-agent distil · progress → skills → install)
  // =========================================================================
  const R = {};

  R.running = {
    stage:'distilling',
    keys:[['Enter','finish run'],['C','stop']],
    render:()=>[
      dim('  $ ')+fg('jinn-agent distil'),
      '',
      dim('  distil: ')+green('local')+dim('  ·  distiller ')+fg('llama-4-405b')+dim('  ·  6 captures'),
      '',
      sky('  distilling…')+dim('  4 of 6  ·  ~3 min left'),
      '',
      '  '+green('distilled'.padEnd(10))+'  '+dim('fix flaky retry in http client'),
      '  '+green('distilled'.padEnd(10))+'  '+dim('add retry budget to client'),
      '  '+green('distilled'.padEnd(10))+'  '+dim('harden json schema validation'),
      '  '+green('distilled'.padEnd(10))+'  '+dim('wire up structured logging'),
      '  '+gold('distilling'.padEnd(10))+'  '+fg('patch panic on empty payload')+sky('  …'),
      '  '+dim('queued'.padEnd(10))+'  '+dim('null-deref in markdown parser'),
      '',
      dim('  Runs on this machine. Nothing is sent; nothing is published.'),
      '',
      rule,
      '  '+kbd('[Enter]')+dim(' (walkthrough: finish the run)')+'      '+kbd('[C]')+dim(' Stop — keep partial'),
    ].join('\n'),
    on:{ enter:'complete', c:'stopped' }
  };

  R.complete = {
    stage:'skills',
    keys:[['A','install all'],['1','install one'],['S','skip']],
    render:()=>{
      const IW=62;
      return [
        dim('  $ ')+fg('jinn-agent distil'),
        '',
        green('  distilled')+dim('  ·  6 captures → ')+fg('4 skills')+dim('  ·  8m 51s  ·  nothing left this machine'),
        '',
        boxTop(IW,'skills · distilled locally · not installed'),
        skillsBox(IW, new Set()),
        boxBot(IW),
        '',
        dim('  Each skill lists the captures it came from  ·  ')+sky('/jinn skills show <name>'),
        dim('  Skills stay local until you install them.'),
        '',
        rule,
        '  '+kbd('[A]')+fg(' Install all 4')+'     '+kbd('[1]')+fg(' Install just the first')+'     '+kbd('[S]')+dim(' Skip'),
      ].join('\n');
    },
    on:{ a:'installedAll', '1':'installedOne', s:'skippedInstall' }
  };

  R.installedOne = {
    stage:'installed',
    keys:[['A','install the rest'],['R','replay']],
    render:()=>{
      const IW=62;
      return [
        dim('  $ ')+fg('/jinn skills install retry-backoff-patterns'),
        '',
        green('  installed')+dim('  ·  retry-backoff-patterns  ·  3 still available'),
        '',
        boxTop(IW,'skills · 1 installed · 3 available'),
        skillsBox(IW, new Set([0])),
        boxBot(IW),
        '',
        dim('  Install the rest any time  ·  ')+sky('/jinn skills install --all'),
        '',
        rule,
        '  '+kbd('[A]')+fg(' Install the rest')+'     '+kbd('[R]')+dim(' Replay'),
      ].join('\n');
    },
    on:{ a:'installedAll', r:'running' }
  };

  R.installedAll = {
    stage:'installed',
    keys:[['R','replay']],
    render:()=>{
      const IW=62;
      return [
        dim('  $ ')+fg('/jinn skills install --all'),
        '',
        green('  installed')+dim('  ·  4 skills  ·  ready for the next run'),
        '',
        boxTop(IW,'skills · installed · ready'),
        skillsBox(IW, new Set([0,1,2,3])),
        boxBot(IW),
        '',
        dim('  Next runs use these on a small model  ·  ')+fg('qwen3-coder-30b')+dim('  ·  no frontier pass.'),
        dim('  Manage  ·  ')+sky('/jinn skills')+dim('   ·   ')+sky('/jinn skills remove <name>'),
        '',
        rule,
        '  '+kbd('[R]')+dim(' Replay the run'),
      ].join('\n');
    },
    on:{ r:'running' }
  };

  R.skippedInstall = {
    stage:'skills',
    keys:[['A','install all'],['R','replay']],
    render:()=>[
      dim('  $ ')+fg('jinn-agent distil'),
      '',
      sky('  4 skills distilled')+dim('  ·  none installed'),
      '',
      dim('  They\u2019re kept locally. Install when you want them:'),
      '  '+sky('/jinn skills install --all')+dim('    or    ')+sky('/jinn skills install <name>'),
      dim('  List them  ·  ')+sky('/jinn skills'),
      '',
      rule,
      '  '+kbd('[A]')+fg(' Install all now')+'     '+kbd('[R]')+dim(' Replay'),
    ].join('\n'),
    on:{ a:'installedAll', r:'running' }
  };

  R.stopped = {
    stage:'distilling',
    keys:[['R','replay']],
    render:()=>[
      dim('  $ ')+fg('jinn-agent distil'),
      '',
      amber('  stopped')+dim('  ·  4 of 6 captures distilled  ·  partial kept'),
      '',
      dim('  The 4 completed skills are written locally; the last 2 captures'),
      dim('  weren\u2019t distilled. Nothing was lost — pick up where it stopped:'),
      '  '+sky('jinn-agent distil --resume'),
      '',
      rule,
      '  '+kbd('[R]')+dim(' Replay from the start'),
    ].join('\n'),
    on:{ r:'running' }
  };

  // =========================================================================
  // GENERIC CONSOLE DRIVER
  // =========================================================================
  function wireConsole(opts){
    const termEl = document.getElementById(opts.term);
    const keyhintsEl = document.getElementById(opts.keys);
    const lifeEl = opts.life ? document.getElementById(opts.life) : null;
    const jumpEl = opts.jump ? document.getElementById(opts.jump) : null;
    const S = opts.states;
    let cur = opts.start;

    function draw(){
      const st = S[cur];
      termEl.innerHTML = st.render();
      keyhintsEl.innerHTML = st.keys.map(([k,label])=>
        `<button class="keyhint" data-key="${k.toLowerCase()}"><span class="k">${k}</span>${label}</button>`).join('');
      keyhintsEl.querySelectorAll('.keyhint').forEach(btn=>{
        btn.addEventListener('click', ()=>{ fire(btn.dataset.key); termEl.focus(); });
      });
      if(lifeEl) lifeEl.querySelectorAll('.stage').forEach(s=> s.classList.toggle('on', s.dataset.s===st.stage));
      if(jumpEl) jumpEl.querySelectorAll('button').forEach(b2=> b2.dataset.on = (b2.dataset.state===cur)?'true':'false');
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
      if(/^[a-z0-9?]$/.test(lk)) fire(lk);
    });
    if(jumpEl && opts.jumps){
      opts.jumps.forEach(([state,label])=>{
        const btn=document.createElement('button');
        btn.textContent=label; btn.dataset.state=state;
        btn.addEventListener('click', ()=>{ cur=state; draw(); termEl.focus(); });
        jumpEl.appendChild(btn);
      });
    }
    draw();
  }

  wireConsole({
    term:'consent', keys:'c-keys', life:'c-life', jump:'c-jump', states:C, start:'unset',
    jumps:[
      ['unset','consent'],['preview','preview'],['confirmLocal','confirm · local'],
      ['recordedLocal','recorded · local'],['recordedDefer','recorded · defer'],['recordedOff','recorded · off'],
    ],
  });
  wireConsole({
    term:'run', keys:'r-keys', life:'r-life', jump:'r-jump', states:R, start:'running',
    jumps:[
      ['running','distilling'],['complete','skills'],['installedAll','install · all'],
      ['installedOne','install · one'],['skippedInstall','skipped'],['stopped','stopped'],
    ],
  });

  // =========================================================================
  // STATIC RENDERS
  // =========================================================================

  // 1c — persistent mode set non-interactively (scriptable)
  document.getElementById('mode-flags').innerHTML = [
    dim('$ ')+fg('jinn-agent distil --where local'),
    '  '+green('distil: mode set to local')+dim('. Runs here with a frontier-class model.'),
    '',
    dim('$ ')+fg('jinn-agent distil --where defer'),
    '  '+sky('distil: mode set to deferred')+dim('. Captures held locally; nothing runs or publishes.'),
    '',
    dim('$ ')+fg('jinn-agent distil --where off'),
    '  '+dim('distil: mode set to off. Captures are not reserved for distillation.'),
  ].join('\n');

  // 1c — the deferred path: what `distil` does while mode = defer
  document.getElementById('defer-run').innerHTML = [
    dim('$ ')+fg('jinn-agent distil'),
    '',
    sky('  distil: deferred')+dim(' — 6 captures held locally, nothing runs.'),
    '',
    dim('  They stay on this machine and are not published. When the bonded'),
    dim('  network can distil a contributed signal, you\u2019ll be asked before'),
    dim('  anything leaves this machine.  ')+dim('(not available yet — rung 3)'),
    '',
    dim('  Run locally now  ·  ')+sky('jinn-agent distil --where local'),
  ].join('\n');

  // 1d — empty state
  document.getElementById('empty-state').innerHTML = [
    dim('$ ')+fg('jinn-agent distil'),
    '',
    fg('  No eligible captures.'),
    '',
    dim('  Distillation reads captures — the tasks you\u2019ve run with the harness.'),
    dim('  There aren\u2019t any yet — run a task first:'),
    '',
    '  '+dim('$ ')+fg('jinn-agent ')+skyh('"fix the flaky retry test in http/client.py"'),
    '',
    dim('  Then run ')+sky('jinn-agent distil')+dim(' again — it\u2019ll have something to work from.'),
  ].join('\n');

  // 1d — error / failure state
  document.getElementById('error-state').innerHTML = [
    dim('$ ')+fg('jinn-agent distil'),
    '',
    dim('  distilling… 3 of 6'),
    red('  distil failed — the distiller stopped responding'),
    '',
    dim('  3 captures were distilled and their skills kept. ')+fg('llama-4-405b')+dim(' stopped'),
    dim('  on capture 4; the last 3 didn\u2019t run. Nothing was sent or lost.'),
    '',
    '  '+dim('resume the rest   ')+sky('jinn-agent distil --resume'),
    '  '+dim('see what\u2019s done   ')+sky('/jinn skills'),
  ].join('\n');

  // 1e — the payoff: a distilled skill used on the cheap open-weight model, later
  document.getElementById('later-run').innerHTML = [
    dim('  …'),
    dim('  read    http/client.py'),
    '  '+sky('◇ skill')+'  '+fg('using ')+skyh('retry-backoff-patterns')+dim('  ·  distilled from 2 local captures  ·  on ')+fg('qwen3-coder-30b'),
    dim('  edit    http/client.py · +14 −6'),
    dim('  bash    pytest -k retry — 4 passed'),
    dim('  …'),
  ].join('\n');
})();
