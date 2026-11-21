import { esc } from './dashboard.js';
import { TOKENS } from './look.js';

/**
 * `/phone`: the desk phone's glance screen (docs/jarvis-phone.md, Phase 2). One page with three views:
 *
 *   Home   needs you, approvals waiting, running now, next up, Claude usage, the VM host's figures, clock
 *   Run    one running session's live steps (tap a run on Home); back to Home when idle
 *   Night  large dim clock and the urgent count, in quiet hours after a minute untouched
 *
 * Everything arrives over `/phone/events` (state, run, alert; see phone-events.ts); the Run view reads
 * `/phone/run/<id>`. It must fit 914 × 411 CSS px (landscape, how the phone sits) and 411 × 914
 * without scrolling: lists are capped and lines ellipsised, never scrolled. The shell's bridge
 * (`window.taraPhone`) wakes the screen, vibrates and speaks; in a plain browser the page still works.
 * 🖥 in the bar opens RustDesk on the phone to see the host's screen (Phase 3, decided 2026-11-17: no
 * live Chrome view of our own; see the plan).
 *
 * Voice (Phase 4): 🎙 in the bar, or a tap on the clock, starts push to talk. The shell listens and
 * speaks (Android's recognizer and text to speech) and reports to `window.taraVoice`; the overlay shows
 * what was heard, the answer and its panel, and Yes / No when a question waits. 🔕 holds alerts for
 * an hour (quiet mode; voice sets any length).
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
.host{font-size:13px;color:var(--text-dim);margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.host.warn{color:var(--amber)}.host.bad{color:var(--red)}
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
.np{display:flex;align-items:center;gap:8px;min-width:0;max-width:38vw;height:34px;padding:0 4px 0 12px;border-radius:999px;background:var(--panel);border:1px solid var(--border-light);font-size:14px;color:var(--text)}
.np[hidden]{display:none}.np span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.np button{border:0;background:none;min-width:34px;height:30px;font-size:17px;padding:0}
.mbtns button{border:1px solid var(--border-light);background:var(--card-bg);font-size:18px}
.mbtns{display:flex;gap:10px;margin-top:auto}.mbtns button{flex:1;height:48px;border-radius:12px}
.offline{position:fixed;right:14px;bottom:12px;font-size:13px;color:var(--amber)}
.gear.on{color:var(--amber)}#quiet{font-size:15px;white-space:nowrap}#mic{font-size:22px}#mic.on{color:var(--accent)}

/* Voice */
.voice{position:fixed;inset:0;z-index:8;display:flex;gap:30px;align-items:center;padding:22px 34px;background:rgba(5,8,15,.95)}
.voice[hidden]{display:none}
.orb{--l:0;width:150px;height:150px;flex:none;border-radius:50%;background:radial-gradient(circle at 50% 42%,#93c5fd,var(--accent) 45%,#1e3a8a 80%);box-shadow:0 0 calc(18px + var(--l)*70px) rgba(59,130,246,.55);transform:scale(calc(1 + var(--l)*.14));transition:transform .09s,box-shadow .09s}
.voice[data-state=thinking] .orb{background:radial-gradient(circle at 50% 42%,#fde68a,var(--amber) 45%,#78350f 80%);box-shadow:0 0 34px rgba(245,158,11,.45)}
.voice[data-state=speaking] .orb{background:radial-gradient(circle at 50% 42%,#bbf7d0,var(--green) 45%,#14532d 80%);box-shadow:0 0 34px rgba(34,197,94,.45)}
.voice[data-state=idle] .orb,.voice[data-state=starting] .orb{opacity:.45;transform:none}
.vcol{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;max-height:100%;overflow:hidden}
.vstate{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim);min-height:16px}
.vyou{font-size:19px;color:var(--text-dim)}.vyou.partial{opacity:.65}.vyou:empty{display:none}
.vsay{font-size:clamp(22px,min(4.4vw,8vh),34px);font-weight:500;line-height:1.25;color:var(--text-heading);overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}
.vsay.long{font-size:clamp(18px,min(3.2vw,6vh),25px);-webkit-line-clamp:7}.vsay.err{color:var(--amber)}.vsay:empty{display:none}
.vpanel{background:var(--card-bg);border:1px solid var(--border);border-radius:14px;padding:10px 14px;min-height:0;overflow:hidden}.vpanel[hidden]{display:none}
.vpanel h3{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.vpanel ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.vpanel li{min-width:0}.vpanel li .t{font-size:16px}.vpanel li .s{font-size:13px;color:var(--text-dim)}
.vpanel li.red .t{color:var(--red)}.vpanel li.amber .t{color:var(--amber)}.vpanel li.blue .t{color:var(--accent)}
.vbtns{display:flex;gap:12px;flex:none}.vbtns[hidden]{display:none}
.vbtns button{height:54px;min-width:120px;border-radius:14px;border:1px solid var(--border-light);background:var(--panel);font-size:20px}
.vbtns button.yes{background:#14532d;border-color:var(--green)}
.vclose{position:absolute;top:10px;right:14px;width:48px;height:48px;border-radius:50%;border:1px solid var(--border-light);background:var(--panel);font-size:20px;color:var(--text-dim)}
.vhint{font-size:14px;color:var(--text-dim);min-height:18px}
.vtime{position:absolute;right:16px;bottom:10px;font-size:12px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.time.talk{cursor:pointer}
/* Voice v2: the step strip and cards */
.voice.live{align-items:stretch;gap:16px;padding:14px 72px 58px 20px}
.voice.live .orb{align-self:flex-start;width:64px;height:64px;margin-top:4px}
.voice.live .vcol{gap:8px}
.voice.live .vstate{font-size:12px}
.voice.live .vhint{display:none}
.voice.live .vyou{font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}
.voice.live .vsay{flex:none;font-size:clamp(18px,min(3vw,6vh),26px);-webkit-line-clamp:3}
.voice.live.cards .vsay{font-size:clamp(16px,min(2.4vw,5vh),21px);-webkit-line-clamp:2}
.voice.live .vtime{bottom:16px}
.voice.live .vclose{width:44px;height:44px;top:10px;right:12px}
.vcards{display:flex;gap:10px;min-height:0;flex:1 1 auto;overflow:hidden}.vcards:empty{display:none}
.card{flex:1 1 0;min-width:0;min-height:0;background:var(--card-bg);border:1px solid var(--border);border-radius:14px;padding:10px 14px;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;overflow-x:hidden;display:flex;flex-direction:column;gap:6px}
.card h3{margin:0;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim)}
.card ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;min-height:0;overflow:hidden}
.card li .t{font-size:15px}.card li .s{font-size:12.5px;color:var(--text-dim)}
.card li.red .t{color:var(--red)}.card li.amber .t{color:var(--amber)}.card li.blue .t{color:var(--accent)}.card li.green .t{color:var(--green)}
.card.confirm{border-color:var(--amber)}.card.confirm .q{font-size:20px;color:var(--text-heading)}.card.confirm .r{font-size:16px}
.card .btns{display:flex;gap:10px;margin-top:auto}.card .btns button{flex:1;height:50px;border-radius:12px;border:1px solid var(--border-light);background:var(--panel);font-size:19px}.card .btns .yes{background:#14532d;border-color:var(--green)}
.card .ans{font-size:14.5px;line-height:1.4;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}.card .ans.x{display:block;-webkit-box-orient:vertical;white-space:pre-wrap}
.card pre{margin:0;font:11.5px/1.4 ui-monospace,monospace;color:var(--text-dim);white-space:pre;overflow-x:hidden;text-overflow:ellipsis}
.posters{display:flex;gap:10px;min-height:0;overflow:hidden}.poster{width:92px;flex:none;display:flex;flex-direction:column;gap:4px}
.poster img,.poster i{width:92px;height:132px;border-radius:8px;object-fit:cover;background:var(--panel);display:block}
.poster b{font-size:13px;font-weight:600;color:var(--text-heading)}.poster span{font-size:11.5px;color:var(--text-dim)}
.strip{position:absolute;left:20px;right:76px;bottom:10px;height:38px;-webkit-mask-image:linear-gradient(to right,transparent,#000 40px);mask-image:linear-gradient(to right,transparent,#000 40px);display:flex;gap:8px;align-items:center;overflow:hidden;justify-content:flex-end}.strip:empty{display:none}
.step{flex:none;max-width:220px;font-size:13px !important;display:flex;gap:6px;align-items:center;padding:6px 12px;border-radius:999px;background:var(--panel);border:1px solid var(--border-light);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step i{font-style:normal}.step.running i{color:var(--accent)}.step.ok i{color:var(--green)}.step.error i{color:var(--red)}.step.error{border-color:var(--red)}

/* Wake word training */
.train{position:fixed;inset:0;z-index:12;display:flex;flex-direction:column;justify-content:center;gap:16px;padding:24px 40px;background:#050810;text-align:center}
.train[hidden]{display:none}
.tstep{font-size:15px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}
.tsay{font-size:clamp(26px,min(6vw,9vh),48px);font-weight:600;color:var(--text-heading);line-height:1.2}
.tbig{font-size:clamp(60px,22vh,150px);font-weight:300;line-height:1;color:var(--accent);font-variant-numeric:tabular-nums}
.tbig.now{color:var(--green)}.tbig.rec{color:var(--red)}
.thint{font-size:17px;color:var(--text-dim);min-height:22px}
.tbtns{display:flex;gap:12px;justify-content:center}.tbtns button{height:54px;min-width:140px;border-radius:14px;border:1px solid var(--border-light);background:var(--panel);font-size:19px}
.tbtns .go{background:#14532d;border-color:var(--green)}

/* Portrait (411 × 914): time on top, tiles stacked with the count beside the list. */
@media (orientation:portrait){
 #home{flex-direction:column}
 .time{width:auto;display:grid;grid-template-columns:auto 1fr;column-gap:16px;align-items:end}
 .clock{font-size:84px;grid-row:1/3}.date{margin:0 0 4px}.next{margin:0;grid-column:1/3;margin-top:10px}.usage{grid-column:2;grid-row:2;margin:0 0 10px}.host{grid-column:1/3;margin:0}
 .tiles{grid-template-columns:1fr;grid-template-rows:repeat(3,minmax(0,1fr))}
 .tile{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto 1fr;column-gap:16px}
 .tile h2{grid-column:1/3}.tile .big{grid-row:2;align-self:start;min-width:64px}.tile ul,.tile .note{grid-row:2;grid-column:2;margin-top:8px}
 .rbody{flex-direction:column}.rtext{flex:0 1 auto;max-height:34%}
 .voice{flex-direction:column;justify-content:center;gap:22px}.orb{width:120px;height:120px}.vcol{flex:0 1 auto;width:100%}
}
@media (prefers-reduced-motion:no-preference){.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}}
</style></head><body>
<header class="bar"><span class="dot" id="dot"></span><b>${esc(opts.agentName)}</b><span id="barClock" hidden></span>
<span class="sp"></span><div class="np" id="np" hidden><span id="npT"></span><button id="npP" aria-label="Pause or play">⏸</button><button id="npS" aria-label="Stop the music">⏹</button></div><button class="gear" id="wake" hidden aria-label="Listening for “Hey ${esc(opts.agentName)}”: tap to teach it your voice">👂</button><span class="chip" id="lock"></span><span class="chip" id="battery"></span>
<button class="gear" id="quiet" aria-label="Quiet mode: hold alerts for an hour">🔔</button>
<button class="gear" id="remote" aria-label="See the host's screen (RustDesk)" hidden>🖥</button>
<button class="gear" id="mic" aria-label="Talk to ${esc(opts.agentName)}" hidden>🎙</button>
<button class="gear" id="gear" aria-label="Phone settings" hidden>⚙</button></header>

<section class="page" id="home">
 <div class="time"><div class="clock" id="clock">--:--</div><div class="date" id="date"></div>
  <div class="usage" id="usage" hidden><span>Claude</span><i><b id="usageBar"></b></i><span id="usageN"></span></div>
  <div class="host" id="host" hidden></div>
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

<div class="voice" id="voice" hidden data-state="idle"><div class="orb" id="vOrb"></div>
 <div class="vcol"><div class="vstate" id="vState"></div><div class="vyou" id="vYou"></div><div class="vsay" id="vSay" aria-live="polite"></div>
  <div class="vpanel" id="vPanel" hidden><h3 id="vPTitle"></h3><ul id="vPLines"></ul></div>
  <div class="vbtns" id="vBtns" hidden><button class="yes" id="vYes">Yes</button><button id="vNo">No</button></div>
  <div class="vcards" id="vCards"></div><div class="vhint" id="vHint"></div></div>
 <div class="strip" id="vStrip"></div><div class="vtime" id="vTime"></div><button class="vclose" id="vClose" aria-label="Close">✕</button></div>
<div class="train" id="train" hidden><div class="tstep" id="tStep">Teach ${esc(opts.agentName)} your voice</div>
 <div class="tsay" id="tSay">About 3 minutes: “Hey ${esc(opts.agentName)}” 8 times close by, 8 times from where you usually sit, then a few other sentences and 20 seconds of the room. Only jarvis keeps the recordings.</div>
 <div class="tbig" id="tBig"></div><div class="thint" id="tHint"></div>
 <div class="tbtns"><button class="go" id="tGo">Start</button><button id="tClose">Close</button></div></div>
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
 const h=S.vmHost;$('host').hidden=!h;if(h){$('host').textContent=(h.name||'Host')+' · '+h.line;$('host').className='host'+(h.status==='ok'?'':' '+h.status);}
 renderNight();renderQuiet();ticks();
}
function word(s){return s==='ok'?'done':s==='silent'?'nothing to do':s==='aborted'?'stopped':s;}
function ticks(){
 const now=new Date();$('clock').textContent=hm.format(now);$('date').textContent=day.format(now);
 $('barClock').textContent=hm.format(now);$('nClock').textContent=hm.format(now);$('nDate').textContent=day.format(now);
 for(const s of document.querySelectorAll('#runL .s[data-start]'))s.textContent=dur(Date.now()-Number(s.dataset.start))+(s.dataset.rest?' · '+s.dataset.rest:'');
 for(const t of document.querySelectorAll('#next time'))t.textContent=until(Number(t.dataset.at));
 if(view==='run'&&watchTask)runClock();
}
function renderQuiet(){
 const u=S&&S.quiet.until,b=$('quiet');
 // Quiet mode also stops "Hey Jarvis" listening (films, calls).
 if(phone&&phone.setWake)phone.setWake(!u);b.classList.toggle('on',Boolean(u));
 b.textContent=u?'🔕 '+hm.format(u):'🔔';b.setAttribute('aria-label',u?'Quiet until '+hm.format(u)+': tap to end':'Quiet mode: hold alerts for an hour');
}
$('quiet').onclick=async()=>{
 const on=Boolean(S&&S.quiet.until);
 try{const r=await fetch('/phone/quiet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({minutes:on?0:60})});
  if(r.ok){const j=await r.json();if(S){S.quiet.until=j.until||undefined;renderQuiet();}toast(j.until?'🔕 Quiet until '+hm.format(j.until)+': alerts wait':'🔔 Quiet mode off');}}catch{}
};
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

/* Voice: the shell listens and speaks; this shows it (window.taraVoice). */
let voiceHide;
const VOICE_IDLE=12e3,VOICE_PANEL=30e3;
function voiceOpen(){$('voice').hidden=false;clearTimeout(voiceHide);lastTouch=Date.now();if(view==='night')show('home');}
function voiceClose(){$('voice').hidden=true;clearTimeout(voiceHide);}
function voiceLater(){clearTimeout(voiceHide);voiceHide=setTimeout(voiceClose,$('vPanel').hidden?VOICE_IDLE:VOICE_PANEL);}
function voicePanel(p){
 const box=$('vPanel');box.hidden=!p||!p.lines||!p.lines.length;if(box.hidden)return;
 $('vPTitle').textContent=p.title||'';const ul=$('vPLines');ul.replaceChildren();
 for(const l of p.lines.slice(0,5)){const li=el('li',l.tone||'');li.append(el('div','t ell',l.text));if(l.sub)li.append(el('div','s ell',l.sub));ul.append(li);}
}
function voiceSay(text,err){const s=$('vSay');const live=$('voice').classList.contains('live');
 // Live answers read like subtitles: the latest words (the full text is on the cards).
 if(live&&text&&text.length>170)text='…'+text.slice(-170).replace(/^S*s/,'');
 s.textContent=text||'';s.className='vsay'+(err?' err':'')+((text||'').length>140?' long':'');}
const STATES={starting:'Wait…',listening:'Listening…',thinking:'Thinking…',speaking:'',idle:''};
const HINTS={starting:'Tap to stop',listening:'Tap to stop',thinking:'Tap to stop',speaking:'Tap to stop',idle:'Tap to talk again'};
window.taraVoice=function(e){
 if(e.type==='state'){const st=e.state;$('voice').dataset.state=st;$('vState').textContent=STATES[st]||'';$('vHint').textContent=HINTS[st]||'';$('mic').classList.toggle('on',st!=='idle');
  if(st==='starting'||st==='listening'){voiceOpen();if(st==='starting')$('vYou').textContent='';$('vOrb').style.setProperty('--l',0);}
  if(st==='idle')voiceLater();else clearTimeout(voiceHide);
  if(st!=='speaking'&&st!=='idle')$('vBtns').hidden=st!=='listening'||$('vBtns').dataset.on!=='1';}
 else if(e.type==='level')$('vOrb').style.setProperty('--l',e.level);
 else if(e.type==='partial'){voiceOpen();const y=$('vYou');y.textContent=e.text;y.className='vyou partial';}
 else if(e.type==='heard'){voiceOpen();const y=$('vYou');y.textContent='“'+e.text+'”';y.className='vyou';voiceSay('');voicePanel(null);$('vBtns').hidden=true;$('vBtns').dataset.on='';$('vTime').textContent='';}
 else if(e.type==='reply'){const r=e.reply;voiceOpen();voiceSay(r.say);voicePanel(r.panel);
  const ask=r.expect==='confirm';$('vBtns').hidden=!ask;$('vBtns').dataset.on=ask?'1':'';
  if(r.watch){openRun(r.watch);setTimeout(voiceClose,2500);}
  else if(r.show){show(r.show);setTimeout(voiceClose,1500);}}
 else if(e.type==='error'){voiceOpen();voiceSay(e.text,true);}
 else if(e.type==='timing')$('vTime').textContent=(e.total/1e3).toFixed(1)+' s';
};
function talk(){if(phone&&phone.listen)phone.listen();}
$('vYes').onclick=(ev)=>{ev.stopPropagation();phone&&phone.voiceText('yes');};
$('vNo').onclick=(ev)=>{ev.stopPropagation();phone&&phone.voiceText('no');};
// A tap on the overlay talks again when it is idle, and stops it otherwise; ✕ closes it.
$('voice').onclick=(ev)=>{if(ev.target.closest('.vbtns,.vpanel'))return;lastTouch=Date.now();
 if($('voice').dataset.state==='idle')talk();else if(phone&&phone.cancelVoice)phone.cancelVoice();};
$('vClose').onclick=(ev)=>{ev.stopPropagation();lClosed=true;if(phone&&phone.cancelVoice)phone.cancelVoice();voiceClose();};
$('mic').onclick=talk;
/** An answer that came later (a question for Claude). */
function lateAnswer(v){voiceOpen();$('voice').dataset.state='speaking';$('vState').textContent='';$('vHint').textContent='';
 const y=$('vYou');y.textContent=v.heard||'';y.className='vyou';voiceSay(v.say);voicePanel(v.panel||null);$('vBtns').hidden=true;
 if(phone&&phone.answer)phone.answer(v.say);voiceLater();}

/* Voice v2: Gemini Live through the shell (window.taraLive): state, words, steps, cards. */
const LSTATES={connecting:'Connecting…',listening:'Listening…',thinking:'Working…',speaking:'',idle:''};
const LHINTS={connecting:'Tap to stop',listening:'Tap to stop',thinking:'Tap to stop',speaking:'Tap to interrupt or stop',idle:'Tap to talk again'};
let lSaid='',lHeard='',lLastWho='',lCards=new Map(),lSteps=new Map();
function liveReset(){$('voice').classList.remove('cards');lSaid='';lHeard='';$('vYou').textContent='';voiceSay('');$('vCards').replaceChildren();$('vStrip').replaceChildren();lCards.clear();lSteps.clear();$('vTime').textContent='';voicePanel(null);$('vBtns').hidden=true;}
function stepEl(st){const d=el('div','step '+st.status);d.append(el('i',st.status==='running'?'pulse':null,st.status==='ok'?'✓':st.status==='error'?'✗':'●'),el('span',null,st.label));d.title=st.detail||'';return d;}
function renderSteps(){const box=$('vStrip');box.replaceChildren();for(const st of [...lSteps.values()].slice(innerWidth>innerHeight?-5:-3))box.append(stepEl(st));}
function cardEl(id,c){
 const d=el('div','card '+c.kind);
 if(c.kind==='list'){d.append(el('h3',null,c.title));const ul=el('ul');for(const l of (c.lines||[]).slice(0,6)){const li=el('li',l.tone||'');li.append(el('div','t ell',l.text));if(l.sub)li.append(el('div','s ell',l.sub));ul.append(li);}d.append(ul);}
 else if(c.kind==='confirm'){d.append(el('h3',null,'Confirm'),el('div','q',c.question));
  if(c.state==='asking'){const b=el('div','btns'),y=el('button','yes','Yes'),n=el('button',null,'No');y.onclick=(e)=>{e.stopPropagation();phone&&phone.voiceText('yes');};n.onclick=(e)=>{e.stopPropagation();phone&&phone.voiceText('no');};b.append(y,n);d.append(b);}
  else d.append(el('div','r',c.state==='yes'?'✓ Yes':c.state==='no'?'✗ No':'Expired'));}
 else if(c.kind==='sources'){d.append(el('h3',null,'Sources'+(c.queries&&c.queries[0]?' · '+c.queries[0]:'')));const ul=el('ul');for(const x of c.sources.slice(0,5)){const li=el('li');li.append(el('div','t ell',x.title),el('div','s ell',x.site||''));ul.append(li);}d.append(ul);}
 else if(c.kind==='titles'){d.append(el('h3',null,c.title));const g=el('div','posters');for(const x of c.items.slice(0,6)){const p=el('div','poster');if(x.image){const im=el('img');im.src=x.image;im.alt='';im.onerror=()=>im.replaceWith(el('i'));p.append(im);}else p.append(el('i'));p.append(el('b','c2',x.title));if(x.sub||x.note)p.append(el('span','c2',[x.sub,x.note].filter(Boolean).join(' · ')));g.append(p);}d.append(g);}
 else if(c.kind==='claude'){d.append(el('h3',null,'Claude · '+c.model+(c.status==='working'?' · working':c.status==='error'?' · failed':'')));
  if(c.answer)d.append(el('div','ans',c.answer));else{const ul=el('ul');ul.append(el('li','t c2',c.question));for(const s of (c.steps||[]).slice(-4))ul.append(el('li','s ell','· '+s));d.append(ul);}}
 else if(c.kind==='log'){d.append(el('h3',null,c.title),el('pre',null,(c.lines||[]).slice(-12).join('\\n')));}
 else if(c.kind==='run'){d.append(el('h3',null,'Run · '+word(c.status)),el('div','q',c.title),el('div','s',c.project));d.onclick=(e)=>{e.stopPropagation();openRun(c.task);voiceClose();};}
 else if(c.kind==='music'){d.append(el('h3',null,'♪ '+c.state));if(c.image){const im=el('img');im.src=c.image;im.style.cssText='width:100%;max-height:120px;object-fit:cover;border-radius:8px';d.append(im);}d.append(el('div','q c2',c.title));if(c.sub)d.append(el('div','s',c.sub));
  const b=el('div','mbtns'),p=el('button',null,'⏸'),x=el('button',null,'⏹');p.onclick=(e)=>{e.stopPropagation();musicDo(npState==='paused'?'resume':'pause');};x.onclick=(e)=>{e.stopPropagation();musicDo('stop');};b.append(p,x);d.append(b);
  musicShow(c.title,c.state);}
 return d;
}
function renderCards(){const box=$('vCards');box.replaceChildren();const landscape=innerWidth>innerHeight;
 // The confirm card first while it asks; then the newest.
 const all=[...lCards.entries()];const ask=all.filter(([,c])=>c.kind==='confirm'&&c.state==='asking');const rest=all.filter((x)=>!ask.includes(x)).reverse();
 for(const [id,c] of [...ask,...rest].slice(0,landscape?2:1))box.append(cardEl(id,c));
 $('voice').classList.toggle('cards',box.childElementCount>0);}
let lState='idle';
/** Markers such as <no speech> can arrive split over two pieces: drop them and their halves. */
function spoken(t){return t.replace(/<[^>]*>/g,'').replace(/^[^<>]*>/,'').replace(/<[^>]*$/,'').trim();}
/** ✕ closed this conversation: its last events don't open the screen again (a new one starts with connecting). */
let lClosed=false;
window.taraLive=function(e){
 const v=$('voice');v.classList.add('live');
 if(e.type==='state'&&e.state==='connecting')lClosed=false;
 if(lClosed&&e.type!=='wake'&&e.type!=='sample'&&!(e.type==='state'&&e.state==='idle'))return;
 if(e.type==='state'){const st=e.state;
  // A new answer starts: its words replace the last one's.
  if(st==='speaking'&&lState!=='speaking')lLastWho='';lState=st;v.dataset.state=st==='connecting'?'starting':st==='thinking'?'thinking':st;$('vState').textContent=[LSTATES[st],LHINTS[st]].filter(Boolean).join(' · ');$('vHint').textContent=LHINTS[st]||'';$('mic').classList.toggle('on',st!=='idle');
  if(st==='connecting'){voiceOpen();liveReset();}else if(st!=='idle')voiceOpen();
  if(st==='idle')voiceLater();else clearTimeout(voiceHide);}
 else if(e.type==='level')$('vOrb').style.setProperty('--l',e.level);
 else if(e.type==='wake')$('wake').hidden=!e.on;
 else if(e.type==='sample'){onSample(e);return;}
 else if(e.type==='transcript'){voiceOpen();
  if(e.who==='user'){if(lLastWho!=='user'){lHeard='';}lHeard+=e.text;const y=$('vYou');y.textContent='“'+lHeard.trim()+'”';y.className='vyou';}
  else{if(lLastWho!=='model')lSaid='';lSaid+=e.text;voiceSay(spoken(lSaid));}
  lLastWho=e.who;}
 else if(e.type==='interrupted'){lLastWho='';}
 else if(e.type==='step'){const old=lSteps.get(e.id);lSteps.set(e.id,{label:e.label||(old&&old.label)||'',status:e.status,detail:e.detail});renderSteps();}
 else if(e.type==='card'){voiceOpen();lCards.delete(e.id);lCards.set(e.id,e.card);renderCards();}
 else if(e.type==='show'){show(e.page);setTimeout(voiceClose,1500);}
 else if(e.type==='watch'){openRun(e.task);setTimeout(voiceClose,2500);}
 else if(e.type==='error'){voiceOpen();voiceSay(e.message,true);}
 else if(e.type==='timing')$('vTime').textContent=(e.total/1e3).toFixed(1)+' s';
};

/* Wake word training: recordings of the owner for a verifier trained on jarvis (see the plan doc). */
const NAME=${inScript(opts.agentName)};
const TRAIN=[
 {label:'wake',where:'near',n:8,ms:2500,lead:6,say:'Sit close to the phone, at arm’s length. When it says NOW, say “Hey '+NAME+'” the way you normally would.'},
 {label:'wake',where:'far',n:8,ms:2500,lead:15,say:'Now go to where you usually sit, across the room. Say “Hey '+NAME+'” at your normal volume when it says NOW.'},
 {label:'other',where:'talk',n:6,ms:3000,lead:8,say:'Now say anything else at NOW: a sentence, some Hinglish, or words that sound close (“hey Travis”, “service”, “harvest”).'},
 {label:'other',where:'room',n:1,ms:20000,lead:8,say:'Last: stay quiet for 20 seconds. A TV or fan on is fine: this records the room.'}];
let tStep=0,tClip=0,tTimer=null,tRunning=false;
function tShow(big,cls,hint){const b=$('tBig');b.textContent=big;b.className='tbig'+(cls?' '+cls:'');if(hint!=null)$('tHint').textContent=hint;}
function tCount(sec,then){clearTimeout(tTimer);if(!tRunning)return;if(sec<=0){then();return;}tShow(String(sec));tTimer=setTimeout(()=>tCount(sec-1,then),1000);}
function tNext(){
 if(!tRunning)return;const st=TRAIN[tStep];
 if(!st){tRunning=false;$('tStep').textContent='Done';$('tSay').textContent='Thank you. '+NAME+' will learn your voice from these on jarvis.';tShow('✓','now','');$('tGo').textContent='Record more';tStep=0;tClip=0;return;}
 $('tStep').textContent='Step '+(tStep+1)+' of '+TRAIN.length+' · '+(st.n>1?'clip '+(tClip+1)+' of '+st.n:'');$('tSay').textContent=st.say;
 tCount(tClip===0?st.lead:3,()=>{tShow('NOW','now');if(phone&&phone.vibrate)phone.vibrate(80);
  setTimeout(()=>{if(!tRunning)return;tShow(st.ms>5000?'Quiet…':'●','rec');phone.recordWakeSample(st.label,st.where,st.ms);},250);});
}
function onSample(e){
 if(!tRunning)return;
 if(e.state==='recording')return;
 if(e.state==='error'){tShow('!','rec',e.message||'Failed');tRunning=false;$('tGo').textContent='Try again';return;}
 const st=TRAIN[tStep];tShow('✓','now',e.level!=null?'Level '+e.level:'');
 tClip++;if(tClip>=st.n){tStep++;tClip=0;}
 tTimer=setTimeout(tNext,1200);
}
/** Starts at the first step jarvis doesn't have enough of yet (a reload or an error never sends you back). */
async function tResume(){
 try{const r=await fetch('/phone/wake-samples',{cache:'no-store'});if(!r.ok)return;const c=(await r.json()).counts||{};
  tStep=TRAIN.findIndex((st)=>(c[st.label+'-'+st.where]||0)<st.n);tClip=0;
  if(tStep<0){tStep=0;$('tStep').textContent='All recorded';$('tSay').textContent='Every step is done. Start records another round; Close keeps what you have.';}
  else if(tStep>0){$('tStep').textContent='Continue at step '+(tStep+1)+' of '+TRAIN.length;$('tSay').textContent=TRAIN[tStep].say;$('tGo').textContent='Continue';}}catch{}
}
$('wake').onclick=()=>{if(!phone||!phone.recordWakeSample)return;$('train').hidden=false;lastTouch=Date.now();tResume();
 // While teaching, saying the wake word mustn't open a conversation.
 if(phone.setTraining)phone.setTraining(true);};
$('tGo').onclick=()=>{if(tRunning){tRunning=false;clearTimeout(tTimer);$('tGo').textContent='Continue';tShow('','', 'Paused');return;}
 tRunning=true;$('tGo').textContent='Pause';tNext();};
$('tClose').onclick=()=>{tRunning=false;clearTimeout(tTimer);$('train').hidden=true;$('tGo').textContent='Start';
 if(phone&&phone.setTraining)phone.setTraining(false);};

/* Music on the speaker: a bar with ⏸ / ⏹ whenever something plays, so it can always be stopped by tap. */
let npState='',npTitle='';
function musicShow(title,state){const st=String(state||'').toLowerCase();npState=st==='playing'||st==='buffering'?'playing':st==='paused'?'paused':'';
 if(title)npTitle=title;$('np').hidden=!npState;if(phone&&phone.setMusic)phone.setMusic(npState==='playing');$('npT').textContent='♪ '+npTitle;$('npP').textContent=npState==='paused'?'▶':'⏸';}
async function musicDo(action){try{const r=await fetch('/phone/music',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
 if(r.ok){const j=await r.json();musicShow(j.playing,j.state||(action==='stop'?'':action==='pause'?'paused':'playing'));}else toast('Speaker: '+r.status);}catch{toast('No answer from the speaker');}}
$('npP').onclick=()=>musicDo(npState==='paused'?'resume':'pause');
$('npS').onclick=()=>musicDo('stop');
async function musicStatus(){try{const r=await fetch('/phone/music',{cache:'no-store'});if(r.ok){const j=await r.json();musicShow(j.playing,j.state);}}catch{}}

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
 es.addEventListener('voice',(e)=>{lastMsg=Date.now();lateAnswer(JSON.parse(e.data));});
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
 if(phone.hasRemote&&phone.hasRemote()){$('remote').hidden=false;$('remote').onclick=()=>phone.openRemote();}
 // Push to talk: 🎙, or a tap anywhere on the clock column.
 if(phone.hasVoice&&phone.hasVoice()){$('mic').hidden=false;const t=document.querySelector('.time');t.classList.add('talk');t.onclick=talk;}}

try{const last=JSON.parse(localStorage.getItem('glance')||'null');if(last&&last.build===BUILD){S=last;for(const a of S.alerts)handled.add(a.id);renderHome();}}catch{}
ticks();status();connect();musicStatus();setInterval(musicStatus,60e3);
setInterval(()=>{ticks();pick();},1000);setInterval(status,30e3);
setInterval(()=>{if(view==='run'&&watch)fetchRun();},1500);
</script></body></html>`;
}
