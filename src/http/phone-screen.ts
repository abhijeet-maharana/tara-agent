import { esc } from './dashboard.js';
import { TOKENS } from './look.js';

/**
 * `/phone`: the desk phone's glance screen (docs/jarvis-phone.md, Phase 2). One page with three views:
 *
 *   Home   needs you, approvals waiting, running now, next up, Claude usage, clock
 *   Run    one running session's live steps (tap a run on Home); back to Home when idle
 *   Night  large dim clock and the urgent count, in quiet hours after a minute untouched
 *
 * Everything arrives over `/phone/events` (state, run, alert; see phone-events.ts); the Run view reads
 * `/phone/run/<id>`. It must fit 914 × 411 CSS px (landscape, how the phone sits) and 411 × 914
 * without scrolling: lists are capped and lines ellipsised, never scrolled. The shell's bridge
 * (`window.taraPhone`) wakes the screen, vibrates and speaks; in a plain browser the page still works.
 * 🖥 in the bar opens RustDesk on the phone to see the host's screen (Phase 3, decided 2026-11-17: no
 * live Chrome view of our own; see the plan).
 */
/** A value as a JS literal inside `<script>`: `<` escaped, so no text can close the script tag. */
const inScript = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export function phoneScreen(opts: { agentName: string; timeZone: string; build: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#090d16">
<title>${esc(opts.agentName)}</title>
<style>${TOKENS}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:var(--font)}
body{display:flex;flex-direction:column;overflow:hidden;user-select:none;-webkit-tap-highlight-color:transparent;
padding:max(10px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));gap:10px}
button{font:inherit;color:inherit}
.bar{display:flex;align-items:center;gap:10px;height:30px;flex:none;font-size:15px;color:var(--text-dim)}
.bar b{color:var(--text-heading);font-weight:650;font-size:16px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--amber);flex:none}.dot.on{background:var(--green)}.dot.off{background:var(--red)}
.bar .sp{flex:1}.chip{font-variant-numeric:tabular-nums;white-space:nowrap}.chip.warn{color:var(--amber)}.chip.bad{color:var(--red)}
.gear{background:none;border:0;color:var(--text-dim);font-size:20px;padding:0 4px;line-height:1}
#barClock{font-variant-numeric:tabular-nums;color:var(--text-heading)}
.page{flex:1;min-height:0;display:flex;gap:12px}.page[hidden]{display:none}
.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dim{color:var(--text-dim)}
.c2{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}

/* Home */
#home{flex-direction:row}
.time{width:236px;flex:none;display:flex;flex-direction:column;min-height:0}
.clock{font-size:76px;font-weight:200;line-height:.95;color:var(--text-heading);font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.date{font-size:17px;color:var(--text-dim);margin-top:6px}
.next{margin-top:auto;display:flex;flex-direction:column;gap:5px;min-height:0;overflow:hidden}
.next h2,.tile h2{margin:0;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.nx{display:flex;gap:8px;font-size:15px;min-width:0}.nx time{font-variant-numeric:tabular-nums;color:var(--text-heading);flex:none;min-width:48px}
.usage{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);margin-top:10px}
.usage i{flex:1;height:6px;border-radius:3px;background:var(--border);overflow:hidden}.usage i b{display:block;height:100%;background:var(--green)}
.usage.warn i b{background:var(--amber)}.usage.bad i b{background:var(--red)}
.tiles{flex:1;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tile{--state:var(--border-light);position:relative;background:var(--card-bg);border:1px solid var(--border);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.tile::before{content:'';position:absolute;top:0;left:14px;right:14px;height:3px;border-radius:0 0 3px 3px;background:var(--state)}
.tile .big{font-size:58px;font-weight:300;line-height:1;margin:6px 0 4px;color:var(--text-heading);font-variant-numeric:tabular-nums}
.tile .note{font-size:15px;color:var(--text-dim)}
.tile ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:hidden}
.tile li{min-width:0;display:flex;gap:7px;align-items:baseline}.tile li>div{min-width:0;flex:1}
.tile li .t{font-size:15px;color:var(--text)}.tile li .s{font-size:12.5px;color:var(--text-dim);margin-top:1px}
.tile li .k{width:8px;height:8px;border-radius:50%;flex:none;background:var(--amber);transform:translateY(-1px)}.tile li .k.urgent{background:var(--red)}.tile li .k.run{background:var(--accent)}
.tile.red{--state:var(--red)}.tile.amber{--state:var(--amber)}.tile.blue{--state:var(--accent)}.tile.green{--state:var(--green)}
.tile .big{color:var(--state)}.tile:not(.red):not(.amber):not(.blue):not(.green) .big{color:var(--text-heading)}
#runL li{cursor:pointer;border-radius:8px}#runL li:active{background:var(--card-hover)}
.clockn{font-variant-numeric:tabular-nums}

/* Run */
#run{flex-direction:column;gap:8px}
.rhead{display:flex;align-items:center;gap:12px;flex:none}
.back{background:var(--panel);border:1px solid var(--border-light);border-radius:12px;min-width:52px;height:46px;font-size:24px}
.rhead .w{flex:1;min-width:0}.rtitle{font-size:21px;font-weight:600;color:var(--text-heading)}.rsub{font-size:14px;color:var(--text-dim);margin-top:2px}
.rclock{font-size:32px;font-weight:300;font-variant-numeric:tabular-nums;color:var(--accent)}.rclock.ok{color:var(--green)}.rclock.bad{color:var(--red)}
.rbody{flex:1;min-height:0;display:flex;gap:12px}
.steps{list-style:none;margin:0;padding:10px 12px;flex:1.4;min-width:0;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;overflow:hidden;background:var(--card-bg);border:1px solid var(--border);border-radius:14px;-webkit-mask-image:linear-gradient(to bottom,transparent,#000 48px);mask-image:linear-gradient(to bottom,transparent,#000 48px)}
.steps li{display:flex;gap:9px;font-size:16px;align-items:baseline;min-width:0;flex:none}.steps li.d1{padding-left:22px;font-size:14px}
.steps li i{font-style:normal;width:14px;flex:none;text-align:center}.steps li.ok i{color:var(--green)}.steps li.error i{color:var(--red)}.steps li.running i{color:var(--accent)}
.steps li span{min-width:0}.steps li.ok span{color:var(--text-dim)}
.rtext{flex:1;min-width:0;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:10px 12px;font-size:15px;line-height:1.45;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.rtext:empty{display:none}

/* Night */
#night{flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}
body.night{background:#000}body.night .bar{visibility:hidden}
.nclock{font-size:min(30vh,24vw);font-weight:200;line-height:1;color:#475569;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.ndate{font-size:18px;color:#334155}.nurgent{font-size:22px;color:#be123c}.nheld{font-size:16px;color:#475569}

/* Alerts and toasts */
.alert{position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:28px 36px;background:#22060d;border:4px solid var(--red)}
.alert[hidden]{display:none}.alert.summary{background:#1f1504;border-color:var(--amber)}
.akind{font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--red)}.alert.summary .akind{color:var(--amber)}
.atext{font-size:clamp(24px,min(7vw,9vh),44px);font-weight:600;color:#fff;line-height:1.2;overflow:hidden;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical}
.asub{font-size:15px;color:#fecdd3}
.toast{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9;max-width:min(680px,92vw);padding:10px 18px;border-radius:12px;background:var(--panel);border:1px solid var(--border-light);font-size:16px;color:var(--text-heading);box-shadow:0 8px 30px rgba(0,0,0,.5)}
.toast[hidden]{display:none}
.offline{position:fixed;right:14px;bottom:12px;font-size:13px;color:var(--amber)}

/* Portrait (411 × 914): time on top, tiles stacked with the count beside the list. */
@media (orientation:portrait){
 #home{flex-direction:column}
 .time{width:auto;display:grid;grid-template-columns:auto 1fr;column-gap:16px;align-items:end}
 .clock{font-size:84px;grid-row:1/3}.date{margin:0 0 4px}.next{margin:0;grid-column:1/3;margin-top:10px}.usage{grid-column:2;grid-row:2;margin:0 0 10px}
 .tiles{grid-template-columns:1fr;grid-template-rows:repeat(3,minmax(0,1fr))}
 .tile{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto 1fr;column-gap:16px}
 .tile h2{grid-column:1/3}.tile .big{grid-row:2;align-self:start;min-width:64px}.tile ul,.tile .note{grid-row:2;grid-column:2;margin-top:8px}
 .rbody{flex-direction:column}.rtext{flex:0 1 auto;max-height:34%}
}
@media (prefers-reduced-motion:no-preference){.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}}
</style></head><body>
<header class="bar"><span class="dot" id="dot"></span><b>${esc(opts.agentName)}</b><span id="barClock" hidden></span>
<span class="sp"></span><span class="chip" id="lock"></span><span class="chip" id="battery"></span>
<button class="gear" id="remote" aria-label="See the host's screen (RustDesk)" hidden>🖥</button>
<button class="gear" id="gear" aria-label="Phone settings" hidden>⚙</button></header>

<section class="page" id="home">
 <div class="time"><div class="clock" id="clock">--:--</div><div class="date" id="date"></div>
  <div class="usage" id="usage" hidden><span>Claude</span><i><b id="usageBar"></b></i><span id="usageN"></span></div>
  <div class="next" id="next"></div></div>
 <div class="tiles">
  <article class="tile" id="tNeeds"><h2>Needs you</h2><div class="big" id="needsN">–</div><ul id="needsL"></ul></article>
  <article class="tile" id="tAppr"><h2>Approvals</h2><div class="big" id="apprN">–</div><ul id="apprL"></ul></article>
  <article class="tile" id="tRun"><h2>Running</h2><div class="big" id="runN">–</div><ul id="runL"></ul></article>
 </div>
</section>

<section class="page" id="run" hidden>
 <div class="rhead"><button class="back" id="back" aria-label="Back to Home">‹</button>
  <div class="w"><div class="rtitle ell" id="rTitle"></div><div class="rsub ell" id="rSub"></div></div>
  <div class="rclock" id="rClock"></div></div>
 <div class="rbody"><ol class="steps" id="rSteps"></ol><div class="rtext" id="rText"></div></div>
</section>

<section class="page" id="night" hidden>
 <div class="nclock" id="nClock"></div><div class="ndate" id="nDate"></div>
 <div class="nurgent" id="nUrgent"></div><div class="nheld" id="nHeld"></div>
</section>

<div class="alert" id="alert" hidden role="alert"><div class="akind" id="aKind">Urgent</div><div class="atext" id="aText"></div><div class="asub" id="aSub">Tap to dismiss</div></div>
<div class="toast" id="toast" hidden></div>
<div class="offline" id="offline" hidden></div>

<script>
'use strict';
const TZ=${inScript(opts.timeZone)},BUILD=${inScript(opts.build)};
const phone=window.taraPhone;
const $=(id)=>document.getElementById(id);
const hm=new Intl.DateTimeFormat([], {hour:'2-digit',minute:'2-digit',hour12:false,timeZone:TZ});
const day=new Intl.DateTimeFormat([], {weekday:'long',day:'numeric',month:'long',timeZone:TZ});
/** Minutes untouched before quiet hours show the Night view, and before Run goes back to Home. */
const NIGHT_IDLE=60e3,RUN_IDLE=10*60e3,RUN_DONE=60e3,ALERT_SHOW=5*60e3;
let S=null,view='home',watch=null,watchTask=null,lastTouch=Date.now(),lastMsg=0,es=null;
const handled=new Set();

function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function ago(t){const s=Math.max(0,(Date.now()-t)/1e3);if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min';if(s<86400)return Math.floor(s/3600)+' h';return Math.floor(s/86400)+' d';}
function dur(ms){const s=Math.max(0,Math.floor(ms/1e3)),h=Math.floor(s/3600),m=Math.floor(s/60)%60,x=String(s%60).padStart(2,'0');return h?h+':'+String(m).padStart(2,'0')+':'+x:m+':'+x;}
function until(t){const m=Math.round((t-Date.now())/60e3);return m<=0?'now':m<60?'in '+m+' min':hm.format(t);}
function item(kind,title,sub){const li=el('li');li.append(el('span','k '+(kind||'')));const d=el('div');d.append(el('div','t c2',title));if(sub)d.append(el('div','s ell',sub));li.append(d);return li;}
function tile(id,cls,n){const t=$(id);t.className='tile '+cls;return t;}

function renderHome(){
 if(!S)return;
 const n=S.needs,needsTotal=n.urgent+n.waiting;
 tile('tNeeds',n.urgent?'red':n.waiting?'amber':'green');$('needsN').textContent=S.ready?needsTotal:'…';
 const nl=$('needsL');nl.replaceChildren();
 if(S.ready&&!needsTotal)nl.append(el('li','note','All clear'));
 for(const i of n.top)nl.append(item(i.tier,i.title,[i.project,i.at&&ago(i.at)].filter(Boolean).join(' · ')));
 const a=S.approvals;tile('tAppr',a.total?'amber':'green');$('apprN').textContent=a.total;
 const al=$('apprL');al.replaceChildren();
 if(!a.total)al.append(el('li','note','None waiting'));
 for(const p of a.projects.slice(0,3))al.append(item('',p.project+(p.count>1?' · '+p.count+' cards':''),(p.count>1?'oldest ':'')+ago(p.oldestAt)+' · '+p.title));
 tile('tRun',S.running.length?'blue':'green');$('runN').textContent=S.running.length;
 const rl=$('runL');rl.replaceChildren();
 if(!S.running.length){rl.append(el('li','note','Nothing running'));
  const last=S.recent[0];if(last)rl.append(item(last.status==='ok'||last.status==='silent'?'':'urgent',last.title,last.project+' · '+word(last.status)+' · '+ago(last.endedAt||last.startedAt)));}
 for(const t of S.running.slice(0,3)){const li=item('run',t.title,'');li.dataset.id=t.id;
  const s=li.querySelector('.s')||li.lastChild.appendChild(el('div','s ell'));s.dataset.start=t.startedAt;s.dataset.rest=[t.project,t.step].filter(Boolean).join(' · ');
  li.onclick=()=>openRun(t.id);rl.append(li);}
 if(S.running.length>3)rl.append(el('li','note','+'+(S.running.length-3)+' more'));
 const nx=$('next');nx.replaceChildren();
 if(S.next.length){nx.append(el('h2',null,'Next up'));for(const j of S.next.slice(0,3)){const r=el('div','nx');const tm=el('time',null,until(j.at));tm.dataset.at=j.at;r.append(tm,el('span','ell',j.name+' · '+j.project));nx.append(r);}}
 const u=S.usage;$('usage').hidden=!u;
 if(u){const pc=Math.round(u.share*100);$('usageBar').style.width=Math.min(100,pc)+'%';$('usageN').textContent=pc+'%';$('usage').className='usage'+(u.share>=.9?' bad':u.share>=.7?' warn':'');}
 renderNight();ticks();
}
function word(s){return s==='ok'?'done':s==='silent'?'nothing to do':s==='aborted'?'stopped':s;}
function ticks(){
 const now=new Date();$('clock').textContent=hm.format(now);$('date').textContent=day.format(now);
 $('barClock').textContent=hm.format(now);$('nClock').textContent=hm.format(now);$('nDate').textContent=day.format(now);
 for(const s of document.querySelectorAll('#runL .s[data-start]'))s.textContent=dur(Date.now()-Number(s.dataset.start))+(s.dataset.rest?' · '+s.dataset.rest:'');
 for(const t of document.querySelectorAll('#next time'))t.textContent=until(Number(t.dataset.at));
 if(view==='run'&&watchTask)runClock();
}
function renderNight(){
 if(!S)return;$('nUrgent').textContent=S.needs.urgent?S.needs.urgent+' urgent':'';
 $('nHeld').textContent=S.held?S.held+(S.held===1?' alert':' alerts')+' for the morning':'';
}

/* Run view */
function openRun(id){watch=id;watchTask=null;lastTouch=Date.now();show('run');$('rTitle').textContent='…';$('rSub').textContent='';$('rSteps').replaceChildren();$('rText').textContent='';fetchRun();}
async function fetchRun(){
 if(!watch)return;const id=watch;
 try{const r=await fetch('/phone/run/'+encodeURIComponent(id),{cache:'no-store'});
  if(id!==watch)return;
  if(r.status===404){watchTask={status:'gone',title:'This run is no longer in memory',startedAt:Date.now(),steps:[],text:''};renderRun();return;}
  if(!r.ok)return;watchTask=(await r.json()).task;renderRun();}catch{}
}
function runClock(){const t=watchTask,c=$('rClock');
 c.textContent=t.status==='gone'?'':dur((t.endedAt||Date.now())-t.startedAt);
 c.className='rclock'+(t.status==='running'?'':t.status==='ok'||t.status==='silent'?' ok':' bad');}
function renderRun(){
 const t=watchTask;if(!t)return;
 $('rTitle').textContent=t.title;
 $('rSub').textContent=[t.project,t.kind,t.status==='running'?(t.stepCount+' steps'):word(t.status),t.error].filter(Boolean).join(' · ');
 const ol=$('rSteps');ol.replaceChildren();
 for(const s of t.steps.slice(-30)){const li=el('li',s.state+(s.depth?' d1':''));li.append(el('i',s.state==='running'?'pulse':null,s.state==='ok'?'✓':s.state==='error'?'✗':'●'),el('span','ell',s.text));ol.append(li);}
 if(!t.steps.length)ol.append(el('li','dim',t.status==='running'?'Starting…':'No steps'));
 $('rText').textContent=(t.text||'').trim().slice(-500);runClock();
}

/* Views */
function show(v){if(v===view)return;view=v;
 for(const id of ['home','run','night'])$(id).hidden=id!==v;
 document.body.classList.toggle('night',v==='night');$('barClock').hidden=v!=='run';}
function pick(){
 const now=Date.now(),idle=now-lastTouch;
 if(S&&S.quiet.now&&idle>NIGHT_IDLE){show('night');return;}
 if(view==='night')show('home');
 if(view==='run'){const t=watchTask,ended=t&&t.status!=='running';
  if(idle>RUN_IDLE||(ended&&idle>RUN_DONE&&now-(t.endedAt||0)>RUN_DONE)){watch=null;show('home');}}
}
$('back').onclick=()=>{watch=null;show('home');};
addEventListener('pointerdown',()=>{lastTouch=Date.now();if(view==='night')show('home');},{capture:true});

/* Alerts */
let alertTimer;
/** The shell wakes, vibrates and speaks for alerts itself (it hears them with the screen off); the page shows them. */
const nativeAlerts=Boolean(phone&&phone.nativeAlerts);
function alertNow(a,silent){
 if(handled.has(a.id))return;handled.add(a.id);
 if(a.held){renderNight();return;}
 const box=$('alert');box.className='alert'+(a.kind==='summary'?' summary':'');
 $('aKind').textContent=a.kind==='summary'?'While you were away':'Urgent';$('aText').textContent=a.text.replace(/^Heads up: /,'');
 box.hidden=false;lastTouch=Date.now();if(view==='night')show('home');
 clearTimeout(alertTimer);alertTimer=setTimeout(()=>{box.hidden=true;},ALERT_SHOW);
 if(phone&&!nativeAlerts&&!silent){if(a.wake)phone.wakeScreen();phone.vibrate(a.speak?700:300);if(a.speak)setTimeout(()=>phone.speak(a.text),400);}
}
$('alert').onclick=()=>{$('alert').hidden=true;};
let toastTimer;
function toast(text){const t=$('toast');t.textContent=text;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},8000);}

/* Events */
function onState(s){
 if(s.build!==BUILD){location.reload();return;}
 // Alerts that came while this page wasn't listening (screen off): shown, not said again.
 for(const a of s.alerts){if(!handled.has(a.id)&&a.wake&&Date.now()-a.at<3*60e3)alertNow(a,true);handled.add(a.id);}
 S=s;try{localStorage.setItem('glance',JSON.stringify(s));}catch{}
 renderHome();pick();
}
function connect(){
 if(es)es.close();
 es=new EventSource('/phone/events');lastMsg=Date.now();
 es.onopen=()=>{$('dot').className='dot on';$('offline').hidden=true;};
 es.addEventListener('state',(e)=>{lastMsg=Date.now();onState(JSON.parse(e.data));});
 es.addEventListener('ping',()=>{lastMsg=Date.now();});
 es.addEventListener('alert',(e)=>{lastMsg=Date.now();alertNow(JSON.parse(e.data));});
 es.addEventListener('run',(e)=>{lastMsg=Date.now();const r=JSON.parse(e.data),t=r.task;
  if(r.phase==='started')toast('▶ '+t.title+' · '+t.project);
  else toast((t.status==='ok'||t.status==='silent'?'✓ ':t.status==='aborted'?'■ ':'✗ ')+t.title+' · '+word(t.status));
  if(t.id===watch)fetchRun();});
 es.onerror=()=>{$('dot').className='dot';if(es.readyState===2){es=null;signedOut();}};
}
async function signedOut(){
 try{const r=await fetch('/phone/ping',{cache:'no-store'});
  if(r.status===401){$('dot').className='dot off';$('offline').textContent='Signed out: the shell renews the session';$('offline').hidden=false;setTimeout(()=>location.reload(),60e3);return;}}
 catch{$('dot').className='dot off';$('offline').textContent='Offline';$('offline').hidden=false;}
 setTimeout(connect,10e3);
}
/** A connection that went quiet (Wi-Fi dropped without a close) is replaced. */
setInterval(()=>{if(es&&Date.now()-lastMsg>60e3){$('dot').className='dot off';connect();}},15e3);

/* The shell */
function status(){
 if(!phone)return;
 const lock=phone.lockState();$('lock').textContent=lock==='locked'?'🔒':'';
 try{const b=JSON.parse(phone.battery());$('battery').textContent=b.level+'%'+(b.charging?' ⚡':'');
  $('battery').className='chip'+(b.temperature>=42?' bad':b.level<20&&!b.charging?' warn':'');}catch{}
}
if(phone){$('gear').hidden=false;$('gear').onclick=()=>phone.openSetup();document.addEventListener('visibilitychange',status);
 // RustDesk, to see and use the host's screen (the shared Chromes): the shell asks for the unlock first.
 if(phone.hasRemote&&phone.hasRemote()){$('remote').hidden=false;$('remote').onclick=()=>phone.openRemote();}}

try{const last=JSON.parse(localStorage.getItem('glance')||'null');if(last&&last.build===BUILD){S=last;for(const a of S.alerts)handled.add(a.id);renderHome();}}catch{}
ticks();status();connect();
setInterval(()=>{ticks();pick();},1000);setInterval(status,30e3);
setInterval(()=>{if(view==='run'&&watch)fetchRun();},1500);
</script></body></html>`;
}
