import { type DashboardContext, esc, layout, pageHead, section } from './dashboard.js';

/**
 * `/live`: talk to the agent. The page streams the microphone to `/live/ws` while Talk is on and plays
 * the speech that comes back; see docs/live.md for the protocol. Quiet by default: nothing plays
 * unless you talked first.
 */

const CSS = `
.live{max-width:720px}
.talk-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;padding:22px 0 26px}
.orb{--ring:var(--border-light);width:132px;height:132px;border-radius:50%;border:3px solid var(--ring);background:radial-gradient(circle at 50% 40%,var(--card-hover),var(--card-bg));color:var(--text-heading);font:inherit;font-size:15px;font-weight:600;cursor:pointer;display:grid;place-items:center;transition:border-color .2s,box-shadow .2s}
.orb:hover{border-color:var(--accent)}
.orb[aria-pressed=true]{--ring:var(--accent);box-shadow:0 0 0 8px var(--accent-dim)}
.orb[data-state=connecting]{--ring:var(--text-dim)}
.orb[data-state=thinking]{--ring:var(--amber);box-shadow:0 0 0 8px var(--amber-dim)}
.orb[data-state=speaking]{--ring:var(--green);box-shadow:0 0 0 8px var(--green-dim)}
.orb[data-state=listening][aria-pressed=true]{animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{50%{box-shadow:0 0 0 14px var(--accent-dim)}}
.live-state{font-size:14px;color:var(--text-dim);min-height:21px}
.hint{font-size:12.5px;color:var(--text-dim);text-align:center;max-width:460px}
.hint kbd{border:1px solid var(--border-light);border-radius:4px;padding:0 5px;font:inherit;font-size:12px}
.alert{display:flex;gap:10px;align-items:center;background:var(--red-dim);border:1px solid var(--red);color:var(--text-heading);border-radius:var(--radius);padding:10px 14px;margin-bottom:16px}
.alert[hidden]{display:none}
.alert .grow{flex:1}
.transcript{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.turn{max-width:85%;padding:8px 12px;border-radius:12px;background:var(--card-bg);border:1px solid var(--border);overflow-wrap:anywhere}
.turn.user{justify-self:end;background:var(--accent-dim);border-color:transparent;color:var(--text-heading)}
.turn .who{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin-bottom:2px}
.type-form{display:flex;gap:8px;margin-top:14px}
.type-form .input{flex:1;min-height:0;min-width:0}
.card .answer{margin:6px 0 0;color:var(--text)}
.diag{margin-top:8px;font-size:13px;color:var(--text-dim)}
.diag summary{cursor:pointer}
`;

const SCRIPT = `
(() => {
  const $ = (id) => document.getElementById(id);
  const orb = $('talk'), stateEl = $('live-state'), status = $('live-status'), alertBox = $('live-alert'),
    alertText = $('live-alert-text'), log = $('transcript'), cards = $('cards'), form = $('type-form');
  const LABEL = { idle: 'Not listening', connecting: 'Connecting…', listening: 'Listening', thinking: 'Working on it…', speaking: 'Speaking' };
  let ws, retry = 0, state = 'idle', talking = false, playing = false, turnBreak = true, last = null;
  let micStream, micCtx, micSource, micNode, outCtx, player;

  const MIC_WORKLET = 'class Mic extends AudioWorkletProcessor{constructor(){super();this.step=sampleRate/16000;this.t=0;this.prev=0;this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
    'process(inputs){const x=inputs[0][0];if(!x)return true;for(let k=0;k<x.length;k++){const s=x[k];while(this.t<=1){const v=Math.max(-1,Math.min(1,this.prev+(s-this.prev)*this.t));' +
    'this.buf[this.n++]=v*32767;this.sq+=v*v;if(this.n===this.buf.length){this.port.postMessage({pcm:this.buf.buffer,rms:Math.sqrt(this.sq/this.n)},[this.buf.buffer]);this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
    'this.t+=this.step}this.t-=1;this.prev=s}return true}}registerProcessor("mic",Mic)';
  const PLAYER_WORKLET = 'class Player extends AudioWorkletProcessor{constructor(){super();this.q=[];this.off=0;this.on=false;this.port.onmessage=(e)=>{if(e.data==="flush"){this.q=[];this.off=0}else this.q.push(e.data)}}' +
    'process(_,outputs){const out=outputs[0][0];let i=0;while(i<out.length&&this.q.length){const b=this.q[0];const n=Math.min(out.length-i,b.length-this.off);' +
    'for(let k=0;k<n;k++)out[i+k]=b[this.off+k]/32768;i+=n;this.off+=n;if(this.off>=b.length){this.q.shift();this.off=0}}for(;i<out.length;i++)out[i]=0;' +
    'const on=this.q.length>0;if(on!==this.on){this.on=on;this.port.postMessage(on)}return true}}registerProcessor("player",Player)';
  const moduleUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

  const send = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const showAlert = (text) => { alertText.textContent = text; alertBox.hidden = false; };
  const hideAlert = () => { alertBox.hidden = true; };
  const announce = (text) => { status.textContent = text; };

  const showLabel = () => {
    stateEl.textContent = state === 'listening' && !talking ? 'Ready: press Talk or type' : LABEL[state] || state;
  };

  function setState(next) {
    if (next === state) return;
    state = next;
    orb.dataset.state = next;
    showLabel();
    if (next === 'listening' || next === 'thinking') turnBreak = true;
    if (next === 'idle' || next === 'listening') announce(LABEL[next]);
    if (next === 'idle' && talking) setTalking(false);
  }

  async function setupOutput() {
    // Resume first, while the click or key press still counts as one: some browsers won't start
    // audio after an await.
    if (!outCtx) outCtx = new AudioContext({ sampleRate: 24000 });
    const resumed = outCtx.resume();
    if (!player) {
      await outCtx.audioWorklet.addModule(moduleUrl(PLAYER_WORKLET));
      player = new AudioWorkletNode(outCtx, 'player', { numberOfInputs: 0, outputChannelCount: [1] });
      player.port.onmessage = (e) => { playing = e.data; };
      player.onprocessorerror = () => showAlert('Sound playback stopped working. Reload the page.');
      player.connect(outCtx.destination);
    }
    await resumed;
    if (outCtx.state !== 'running') showAlert('The browser is holding back sound: click anywhere on the page to allow it.');
  }
  document.addEventListener('click', () => { if (outCtx && outCtx.state !== 'running') outCtx.resume(); });

  async function startMic() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      showAlert('The microphone only works over HTTPS (or on localhost). Open this page through tailscale serve, or type below.');
      return false;
    }
    try {
      await setupOutput();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      showAlert('Could not use the microphone: ' + (err && err.message ? err.message : err) + '. Allow it in the address bar, or type below.');
      return false;
    }
    if (!micCtx) {
      micCtx = new AudioContext();
      await micCtx.audioWorklet.addModule(moduleUrl(MIC_WORKLET));
    }
    await micCtx.resume();
    diag.micRate = micCtx.sampleRate;
    micSource = micCtx.createMediaStreamSource(micStream);
    micNode = new AudioWorkletNode(micCtx, 'mic');
    micNode.port.onmessage = (e) => {
      if (!talking || !ws || ws.readyState !== 1) return;
      // While it speaks, only clearly louder sound goes up, so its own voice leaking into the mic doesn't cut it off.
      if (playing && e.data.rms < 0.04) return;
      diag.mic += e.data.pcm.byteLength;
      diag.level = e.data.rms;
      ws.send(e.data.pcm);
    };
    const sink = micCtx.createGain();
    sink.gain.value = 0;
    micSource.connect(micNode).connect(sink).connect(micCtx.destination);
    return true;
  }

  function stopMic() {
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (micSource) micSource.disconnect();
    if (micNode) micNode.disconnect();
    micStream = micSource = micNode = undefined;
  }

  async function setTalking(on) {
    if (on === talking) return;
    if (on) {
      talking = true;
      orb.setAttribute('aria-pressed', 'true');
      orb.textContent = 'Stop';
      showLabel();
      if (!(await startMic())) return setTalking(false);
      hideAlert();
      send({ type: 'talk' });
    } else {
      talking = false;
      orb.setAttribute('aria-pressed', 'false');
      orb.textContent = 'Talk';
      showLabel();
      stopMic();
      send({ type: 'mute' });
    }
  }

  function play(buf) {
    diag.speech += buf.byteLength;
    if (!player) { diag.dropped += buf.byteLength; return; }
    player.port.postMessage(new Int16Array(buf, 0, buf.byteLength >> 1));
  }

  function addText(who, text) {
    if (turnBreak || !last || last.dataset.who !== who) {
      last = document.createElement('li');
      last.className = 'turn ' + who;
      last.dataset.who = who;
      const label = document.createElement('span');
      label.className = 'who';
      label.textContent = who === 'user' ? 'You' : log.dataset.agent;
      last.append(label, document.createTextNode(''));
      last.dataset.raw = '';
      log.append(last);
      while (log.children.length > 60) log.firstElementChild.remove();
      turnBreak = false;
    }
    // Markers such as <no speech> or {pause} arrive split across pieces: clean the whole turn, and
    // hold back a marker that hasn't closed yet.
    last.dataset.raw += text;
    const words = last.dataset.raw.replace(/<[^>]*>|\\{[^}]*\\}/g, '').replace(/[<{][^>}]*$/, '');
    last.lastChild.textContent = words;
    last.hidden = !words.trim();
    if (!last.hidden) last.scrollIntoView({ block: 'nearest' });
  }

  // Answers may carry \`inline code\`: show it as code, never as HTML.
  function withCode(el, text) {
    text.split('\u0060').forEach((part, i) => {
      if (i % 2) {
        const code = document.createElement('code');
        code.textContent = part;
        el.append(code);
      } else el.append(part);
    });
  }

  function addCard(c) {
    const card = document.createElement('div');
    card.className = 'card ' + (c.error ? 'bad' : c.kind === 'ask' ? 'ok' : 'accent');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = (c.kind === 'ask' ? 'Asked ' : 'Sent to ') + c.project;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = c.kind === 'ask' ? c.question : c.task;
    card.append(title, meta);
    const body = document.createElement('p');
    body.className = 'answer';
    if (c.error) body.textContent = 'Failed: ' + c.error;
    else if (c.kind === 'ask') withCode(body, c.answer);
    else if (c.url) {
      const a = document.createElement('a');
      a.href = c.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Open the Slack thread';
      body.append(a);
    } else body.textContent = 'Started in the project channel.';
    card.append(body);
    const empty = cards.querySelector('.empty');
    if (empty) empty.remove();
    cards.prepend(card);
    while (cards.children.length > 12) cards.lastElementChild.remove();
    announce(c.error ? 'Failed in ' + c.project : c.kind === 'ask' ? 'Answer from ' + c.project : 'Sent to ' + c.project);
  }

  function onEvent(e) {
    if (e.type === 'state') setState(e.state);
    else if (e.type === 'transcript') addText(e.who, e.text);
    else if (e.type === 'interrupted') { if (player) player.port.postMessage('flush'); turnBreak = true; }
    else if (e.type === 'card') addCard(e);
    else if (e.type === 'error') { showAlert(e.message); setTalking(false); }
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { retry = 0; hideAlert(); orb.disabled = false; };
    ws.onmessage = (e) => (typeof e.data === 'string' ? onEvent(JSON.parse(e.data)) : play(e.data));
    ws.onclose = () => {
      orb.disabled = true;
      setTalking(false);
      setState('idle');
      showAlert('Lost the connection to tara. Reconnecting…');
      setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    };
  }

  orb.addEventListener('click', () => setTalking(!talking));
  // Space toggles Talk from anywhere on the page, except while typing or on another control.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t !== document.body && t !== document.documentElement) return;
    e.preventDefault();
    if (!orb.disabled) setTalking(!talking);
  });
  $('live-alert-close').addEventListener('click', hideAlert);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.elements.text;
    const text = input.value.trim();
    if (!text) return;
    await setupOutput();
    turnBreak = true;
    addText('user', text);
    turnBreak = true;
    send({ type: 'text', text });
    input.value = '';
  });

  // Details: what the audio is doing, for when something doesn't work.
  const diag = { mic: 0, speech: 0, dropped: 0, level: 0, micRate: 0 };
  const diagBox = $('live-diag');
  setInterval(() => {
    if (!diagBox.parentElement.open) return;
    const sec = (bytes, rate) => (bytes / rate / 2).toFixed(1) + ' s';
    diagBox.textContent = [
      'Connection: ' + (ws && ws.readyState === 1 ? 'open' : 'closed') + ', state ' + state + (talking ? ', talking' : ''),
      'Sound out: ' + (outCtx ? outCtx.state + ' at ' + outCtx.sampleRate + ' Hz' : 'not started yet (press Talk or send)') + (playing ? ', playing' : ''),
      'Speech received: ' + sec(diag.speech, 24000) + (diag.dropped ? ' (' + sec(diag.dropped, 24000) + ' arrived before sound was ready)' : ''),
      'Microphone: ' + (micCtx ? micCtx.state + ' at ' + diag.micRate + ' Hz' : 'off') + ', sent ' + sec(diag.mic, 16000) + ', level ' + diag.level.toFixed(3),
      'Page: ' + (window.isSecureContext ? 'secure' : 'NOT secure (no microphone)') + ', ' + navigator.userAgent,
    ].join('\\n');
  }, 1000);

  connect();
})();
`;

export function livePage(ctx: DashboardContext, opts: { unlocked: boolean }): string {
  const head = pageHead('Live', `Talk to ${esc(ctx.agentName)}. It speaks only when you've talked to it.`);
  if (!opts.unlocked)
    return layout(
      ctx,
      'Live',
      'Live',
      `${head}<div class="card warn"><div class="title">This browser isn't unlocked</div><p class="answer">Live can start Claude conversations in your projects, so it needs the same key as deciding approvals. <a href="/unlock">Unlock this browser</a>, then come back.</p></div>`,
    );
  const body = `${head}
<div class="alert" id="live-alert" role="alert" hidden><span class="grow" id="live-alert-text"></span><button type="button" class="btn ghost" id="live-alert-close">Dismiss</button></div>
<div class="live">
  <div class="talk-wrap">
      <button type="button" class="orb" id="talk" aria-pressed="false" aria-describedby="live-state" data-state="idle" disabled>Talk</button>
      <div class="live-state" id="live-state">Not listening</div>
      <p class="hint">Press <kbd>Space</kbd> or the button to start and stop. Try “What needs me?”, “Ask ${esc(
        ctx.projects[0]?.config.name ?? 'shop',
      )} how the sync retries”, or “Focus for 45 minutes”.</p>
    </div>
    ${section(
      'Conversation',
      `<ol class="transcript" id="transcript" aria-label="Conversation" data-agent="${esc(ctx.agentName)}"></ol><form class="type-form" id="type-form"><label class="visually-hidden" for="type-text">Type instead</label><input class="input" id="type-text" name="text" autocomplete="off" placeholder="Or type here…"><button class="btn" type="submit">Send</button></form>`,
    )}
    ${section('Results', '<div id="cards"><p class="empty">Answers to questions and tasks sent to Slack appear here.</p></div>')}
  <details class="diag"><summary>Details</summary><pre id="live-diag">Open to see what the sound and microphone are doing.</pre></details>
</div>
<div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" id="live-status"></div>
<style>${CSS}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>`;
  return layout(ctx, 'Live', 'Live', body, { script: SCRIPT });
}
