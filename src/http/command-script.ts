import { HUD_SCRIPT } from './command-hud.js';

/**
 * The Command page's script: the WebSocket to `/command/ws`, microphone and speech (AudioWorklets),
 * and everything on screen except the HUD (src/http/command-hud.ts): subtitles, live tasks and the
 * Watch view, Operations panels, the gauge strip and the project list for narrow screens. Every string
 * from the server goes in as text, never HTML.
 */
const HEAD = `
  const $ = (id) => document.getElementById(id);
  /** h('div', {class: 'x'}, 'text', child): every string becomes text, never HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid !== undefined && kid !== null && kid !== false) el.append(kid);
    return el;
  }
`;

const APP = `
  const orb = $('talk'), orbLabel = $('talk-label'), stateEl = $('live-state'), status = $('live-status'), alertBox = $('live-alert'),
    alertText = $('live-alert-text'), log = $('transcript'), ops = $('ops'), systems = $('systems'), form = $('type-form'),
    linkPill = $('link-pill'), focusPill = $('focus-pill'), soundBtn = $('sound'), subs = $('subtitles'), subUser = $('sub-user'),
    subModel = $('sub-model'), tasksRunning = $('tasks-running'), tasksDone = $('tasks-done'), tasksHead = $('tasks-head'),
    watchEl = $('watch'), stageClock = $('stage-clock');
  const AGENT = log.dataset.agent;
  const LABEL = { idle: 'Standing by', connecting: 'Connecting', listening: 'Listening', thinking: 'Working', speaking: 'Speaking' };
  let ws, retry = 0, state = 'idle', talking = false, playing = false, turnBreak = true, last = null;
  let micStream, micCtx, micSource, micNode, outCtx, player;

  const MIC_WORKLET = 'class Mic extends AudioWorkletProcessor{constructor(){super();this.step=sampleRate/16000;this.t=0;this.prev=0;this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
    'process(inputs){const x=inputs[0][0];if(!x)return true;for(let k=0;k<x.length;k++){const s=x[k];while(this.t<=1){const v=Math.max(-1,Math.min(1,this.prev+(s-this.prev)*this.t));' +
    'this.buf[this.n++]=v*32767;this.sq+=v*v;if(this.n===this.buf.length){this.port.postMessage({pcm:this.buf.buffer,rms:Math.sqrt(this.sq/this.n)},[this.buf.buffer]);this.buf=new Int16Array(1600);this.n=0;this.sq=0}' +
    'this.t+=this.step}this.t-=1;this.prev=s}return true}}registerProcessor("mic",Mic)';
  // Posts true/false when playback starts and stops.
  const PLAYER_WORKLET = 'class Player extends AudioWorkletProcessor{constructor(){super();this.q=[];this.off=0;this.on=false;this.port.onmessage=(e)=>{if(e.data==="flush"){this.q=[];this.off=0}else this.q.push(e.data)}}' +
    'process(_,outputs){const out=outputs[0][0];let i=0;while(i<out.length&&this.q.length){const b=this.q[0];const n=Math.min(out.length-i,b.length-this.off);' +
    'for(let k=0;k<n;k++)out[i+k]=b[this.off+k]/32768;i+=n;this.off+=n;if(this.off>=b.length){this.q.shift();this.off=0}}for(;i<out.length;i++)out[i]=0;' +
    'const on=this.q.length>0;if(on!==this.on){this.on=on;this.port.postMessage(on)}return true}}registerProcessor("player",Player)';
  const moduleUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));

  const send = (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const showAlert = (text) => { alertText.textContent = text; alertBox.hidden = false; };
  const hideAlert = () => { alertBox.hidden = true; };
  const announce = (text) => { status.textContent = text; };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const elapsed = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const sourceNow = () => (playing ? 'out' : talking ? 'mic' : null);

  /** A button that asks once more before it acts: the first click arms it for a few seconds. */
  function confirmButton(label, cls, act) {
    let timer;
    const b = h('button', { type: 'button', class: 'mini ' + (cls || '') }, label);
    b.addEventListener('click', () => {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = 'Confirm: ' + label;
        timer = setTimeout(() => { b.classList.remove('armed'); b.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      b.textContent = label + '…';
      act();
    });
    return b;
  }

  // Answers may carry \\u0060inline code\\u0060: show it as code, never as HTML.
  function withCode(el, text) {
    text.split('\\u0060').forEach((part, i) => el.append(i % 2 ? h('code', {}, part) : part));
    return el;
  }

  // ---- Projects: orbit nodes, the narrow-screen list, the project panel ----
  let lastProjects = [], needs = null, focusUntil = 0, usage = null, firstOverview;
  const projectsReady = new Promise((resolve) => { firstOverview = resolve; });
  const working = (name) => [...tasks.values()].filter((t) => t.status === 'running' && t.project === name && t.kind !== 'job');
  function health(p) {
    const busy = working(p.name);
    const tone = p.jobs.failing.length || (p.repo && p.repo.error) ? 'bad' : p.approvals ? 'warn' : p.jobs.running.length || busy.length ? 'run' : 'ok';
    const stats = [];
    // Jobs are counted from the scheduler; chats and questions from the live tasks.
    if (busy.length) stats.push(['run', busy.length + ' working', busy.map((t) => t.title).join(', ')]);
    if (p.jobs.running.length) stats.push(['run', p.jobs.running.length + ' running', p.jobs.running.join(', ')]);
    if (p.jobs.failing.length) stats.push(['bad', plural(p.jobs.failing.length, 'failing job'), p.jobs.failing.join(', ')]);
    if (p.approvals) stats.push(['warn', plural(p.approvals, 'approval')]);
    if (p.repo && p.repo.changes) stats.push(['', plural(p.repo.changes, 'changed file')]);
    if (p.jobs.paused) stats.push(['', p.jobs.paused + ' paused']);
    return { tone, stats, active: busy.length + p.jobs.running.length > 0, meta: stats.length ? stats[0][1] : p.jobs.total ? plural(p.jobs.total, 'job') + ' · quiet' : 'quiet' };
  }
  function projectBody(p, hl) {
    const show = (what) => () => send({ type: 'show', what, project: p.name });
    return [
      h('div', { class: 'pstats' }, hl.stats.length ? hl.stats.map(([tone, text, title]) => h('span', { class: tone, title }, text)) : h('span', {}, 'All quiet')),
      h('div', { class: 'acts' },
        p.jobs.total ? h('button', { type: 'button', class: 'mini', on: { click: show('jobs') } }, 'Jobs') : null,
        p.repo ? h('button', { type: 'button', class: 'mini', on: { click: show('repo') } }, 'Changes') : null,
        p.approvals ? h('button', { type: 'button', class: 'mini primary', on: { click: show('approvals') } }, 'Approvals') : null,
        p.dashboardUrl ? h('a', { class: 'mini', href: p.dashboardUrl, target: '_blank', rel: 'noopener' }, 'Dashboard ↗') : null),
    ];
  }
  function renderProjects() {
    const list = lastProjects.map((p) => ({ p, hl: health(p) }));
    hud.setProjects(list.map(({ p, hl }) => ({ name: p.name, title: p.title, tone: hl.tone, meta: hl.meta, active: hl.active })));
    systems.replaceChildren(...(list.length ? list.map(({ p, hl }) => h('div', { class: 'sys', 'data-tone': hl.tone, 'data-project': p.name },
      h('div', { class: 'sys-top' }, h('span', { class: 'sys-dot', 'aria-hidden': 'true' }), h('b', {}, p.title),
        p.repo && p.repo.branch ? h('span', { class: 'branch', title: 'Branch' }, p.repo.branch) : null),
      projectBody(p, hl))) : [h('p', { class: 'dim' }, 'No projects connected.')]));
    renderGauges();
  }
  hud.onNode((name) => {
    const p = lastProjects.find((x) => x.name === name);
    if (p) renderPanel('project:' + name, { kind: 'project', project: p });
  });

  // ---- Gauge strip ----
  const gaugeEls = {};
  const counted = {};
  function ticker(el, value) {
    const from = counted[el.id] ?? 0;
    counted[el.id] = value;
    if (from === value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = value; return; }
    const t0 = performance.now();
    const step = (now) => {
      const f = Math.min(1, (now - t0) / 450);
      el.textContent = Math.round(from + (value - from) * (1 - Math.pow(1 - f, 3)));
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const GAUGES = [
    ['tasks', 'Tasks', () => document.getElementById('tasks-head').scrollIntoView({ behavior: 'smooth', block: 'center' })],
    ['jobs', 'Jobs on', () => send({ type: 'show', what: 'jobs' })],
    ['approvals', 'Approvals', () => send({ type: 'show', what: 'approvals' })],
    ['failing', 'Failing', () => send({ type: 'show', what: 'jobs' })],
    ['needs', 'Needs you', () => send({ type: 'show', what: 'attention' })],
    ['prs', 'PRs', () => send({ type: 'show', what: 'attention' })],
    ['usage', 'Usage', null],
    ['focus', 'Focus', null],
  ];
  const gaugesEl = $('gauges');
  for (const [key, label, act] of GAUGES) {
    const b = h('b', { id: 'g-' + key }, '–');
    const el = h('button', { type: 'button', class: 'g zero', disabled: !act, on: act ? { click: act } : {} }, h('span', {}, label), b);
    gaugeEls[key] = { el, b };
    gaugesEl.append(el);
  }
  function gauge(key, value, tone, text) {
    const g = gaugeEls[key];
    g.el.className = 'g ' + (tone || (value ? '' : 'zero'));
    if (typeof value === 'number' && text === undefined) ticker(g.b, value);
    else g.b.textContent = text;
  }
  function renderGauges() {
    const running = [...tasks.values()].filter((t) => t.status === 'running').length;
    const jobsRunning = lastProjects.reduce((n, p) => n + p.jobs.running.length, 0);
    const approvals = lastProjects.reduce((n, p) => n + p.approvals, 0);
    const failing = lastProjects.reduce((n, p) => n + p.jobs.failing.length, 0);
    gauge('tasks', running, running ? 'run' : '');
    gauge('jobs', jobsRunning, jobsRunning ? 'run' : '');
    gauge('approvals', approvals, approvals ? 'warn' : '');
    gauge('failing', failing, failing ? 'bad' : '');
    const now = needs ? needs.urgent + needs.waiting : 0;
    gauge('needs', now, needs && needs.urgent ? 'bad' : now ? 'warn' : '', needs ? undefined : '–');
    gauge('prs', needs ? needs.prs : 0, needs && needs.prs ? 'warn' : '', needs ? undefined : '–');
    const pct = usage && typeof usage.utilization === 'number' ? Math.round(usage.utilization * 100) : null;
    const u = gaugeEls.usage;
    u.el.className = 'g ' + (pct === null ? 'zero' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '');
    u.b.textContent = pct === null ? '–' : pct + '%';
    u.el.querySelector('span').textContent = usage ? (WINDOW[usage.window] || 'Usage') + ' use' : 'Usage';
    let meter = u.el.querySelector('.meter');
    if (pct !== null) { if (!meter) { meter = h('i', { class: 'meter' }); u.el.append(meter); } meter.style.width = pct + '%'; }
    u.el.title = usage && usage.resetsAt ? 'Resets ' + clock(usage.resetsAt * (usage.resetsAt < 1e12 ? 1000 : 1)) : '';
    const focused = focusUntil > Date.now();
    gaugeEls.focus.el.querySelector('span').textContent = focused ? 'Focus until' : 'Focus';
    gauge('focus', 0, focused ? 'warn' : 'zero', focused ? clock(focusUntil) : 'off');
  }
  const WINDOW = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus' };

  // ---- Live tasks and the Watch view ----
  const tasks = new Map();
  const expanded = new Set();
  let watching = null;
  const KIND = { chat: 'chat', job: 'job', ask: 'question' };
  const DONE = { ok: ['done', 'ok'], aborted: ['stopped', 'stopped'], timeout: ['timed out', 'bad'], limit: ['usage limit', 'bad'], error: ['failed', 'bad'] };

  // ---- Spoken alerts: the browser's own voice, while the voice session is closed ----
  // Only one Command tab speaks: the visible one at once, others after a moment unless one claimed it.
  let alertLang;
  const speakers = 'BroadcastChannel' in window ? new BroadcastChannel('command-speech') : null;
  const claimed = new Set();
  if (speakers) speakers.onmessage = (e) => claimed.add(e.data);
  const canSpeak = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
  function say(id, text) {
    if (!('speechSynthesis' in window)) return;
    if (!canSpeak()) { showAlert(text + ' (Click anywhere on this page once so alerts can speak.)'); return; }
    setTimeout(() => {
      if (claimed.has(id)) return;
      claimed.add(id);
      if (speakers) speakers.postMessage(id);
      const u = new SpeechSynthesisUtterance(text);
      if (alertLang) {
        u.lang = alertLang;
        const voices = speechSynthesis.getVoices();
        const voice = voices.find((v) => v.lang === alertLang) || voices.find((v) => v.lang.startsWith(alertLang.split('-')[0]));
        if (voice) u.voice = voice;
      }
      u.rate = 1.04;
      speechSynthesis.speak(u);
      subModel.textContent = text;
      subUser.textContent = '';
      subs.classList.remove('quiet');
      clearTimeout(subsTimer);
      subsTimer = setTimeout(() => subs.classList.add('quiet'), 8000);
    }, document.visibilityState === 'visible' ? 0 : 400);
  }
  function onAlert(e) {
    const a = e.alert;
    renderPanel(a.id, { kind: 'alert', alert: a });
    hud.alert();
    if (a.quiet) return;
    hud.sfx('alert', true);
    if (!e.voice) say(a.id, a.text);
  }
  let notices = 0;
  function onNotify(e) {
    renderPanel('notify:' + ++notices, { kind: 'action', text: e.text, ok: e.ok });
    if (e.quiet) return;
    hud.sfx(e.ok ? 'done' : 'fail');
    say('notify:' + e.text + ':' + Math.floor(Date.now() / 10000), e.text);
  }

  const stepItem = (st, t0) => h('li', { class: 'step', 'data-state': st.state, 'data-depth': String(st.depth) },
    t0 ? h('span', { class: 'at' }, '+' + elapsed(st.at - t0)) : null,
    h('span', { class: 'ic', 'aria-hidden': 'true' }, st.state === 'ok' ? '✓' : st.state === 'error' ? '✕' : ''), h('span', {}, st.text));

  function taskCard(t) {
    const running = t.status === 'running';
    const [label, tone] = running ? ['running', 'run'] : DONE[t.status] || [t.status, 'bad'];
    const open = expanded.has(t.id);
    const steps = open ? t.steps : t.steps.slice(running ? -5 : -3);
    const hidden = t.stepCount - steps.length;
    const head = h('div', { class: 'task-head' }, h('span', { class: 't ' + tone }, running ? KIND[t.kind] || t.kind : label), h('b', { title: t.title }, t.title),
      h('time', running ? { 'data-since': t.startedAt } : {}, elapsed((t.endedAt || Date.now()) - t.startedAt)));
    const meta = h('div', { class: 'task-meta' }, t.project + ' · ' + plural(t.stepCount, 'step') + (t.costUsd ? ' · $' + t.costUsd.toFixed(2) : ''));
    const list = steps.length ? h('ol', { class: 'steps' }, steps.map((st) => stepItem(st))) : null;
    const more = hidden > 0 || open ? h('button', { type: 'button', class: 'more', on: { click: () => { open ? expanded.delete(t.id) : expanded.add(t.id); upsertTask(t); } } },
      open ? 'Show fewer steps' : 'Show ' + Math.min(hidden, t.steps.length - steps.length) + ' earlier steps' + (t.stepCount > t.steps.length ? ' (the rest are in the transcript)' : '')) : null;
    const text = t.error || t.text;
    const actions = h('div', { class: 'acts' },
      h('button', { type: 'button', class: 'mini primary', on: { click: () => enterWatch(t.id) } }, 'Watch'),
      running ? confirmButton('Stop', '', () => send({ type: 'stop', id: t.id })) : null,
      t.url ? h('a', { class: 'mini', href: t.url, target: '_blank', rel: 'noopener' }, 'Slack ↗') : null);
    const cls = 'task ' + (running ? 'run' : 'done ' + tone) + (watching === t.id ? ' watched' : '');
    if (running)
      return h('article', { class: cls, 'data-id': t.id, 'aria-label': 'Running: ' + t.title }, head, meta, list, more,
        text ? h('p', { class: 'task-text' }, text.slice(-300)) : null, actions);
    return h('article', { class: cls, 'data-id': t.id }, head,
      h('details', { open: open || undefined, on: { toggle: (e) => { e.target.open ? expanded.add(t.id) : expanded.delete(t.id); } } },
        h('summary', {}, t.project + ' · ' + plural(t.stepCount, 'step') + (text ? ' · result' : '')), list, text ? withCode(h('p', { class: 'task-text' }), text) : null, actions));
  }

  function upsertTask(t) {
    const was = tasks.get(t.id);
    tasks.set(t.id, t);
    const card = taskCard(t);
    const old = document.querySelector('.task[data-id="' + CSS.escape(t.id) + '"]');
    const home = t.status === 'running' ? tasksRunning : tasksDone;
    if (old && old.parentElement === home) old.replaceWith(card);
    else { if (old) old.remove(); home.prepend(card); }
    while (tasksDone.children.length > 4) {
      const gone = tasksDone.lastElementChild;
      if (gone.dataset.id !== watching) tasks.delete(gone.dataset.id);
      gone.remove();
    }
    const n = tasksRunning.children.length;
    tasksHead.hidden = !n && !tasksDone.children.length;
    tasksHead.querySelector('b').textContent = n ? 'Live tasks · ' + n + ' running' : 'Recent tasks';
    if (watching === t.id) renderWatch();
    // Started or ended: the projects and gauges count it.
    if (!was || (was.status === 'running') !== (t.status === 'running')) {
      renderProjects();
      if (!was && t.status === 'running') { announce('Started: ' + t.title); hud.ping(t.project); if (live) hud.sfx('start'); }
      if (was && t.status !== 'running') { announce((DONE[t.status] || [t.status])[0] + ': ' + t.title); hud.sfx(t.status === 'ok' ? 'done' : t.status === 'aborted' ? 'blip' : 'fail'); }
    }
  }
  let live = false; // the first snapshot doesn't chime

  function enterWatch(id) {
    if (!tasks.has(id)) return;
    watching = id;
    for (const el of document.querySelectorAll('.task.watched')) el.classList.remove('watched');
    const card = document.querySelector('.task[data-id="' + CSS.escape(id) + '"]');
    if (card) card.classList.add('watched');
    hud.setMode('watch');
    watchEl.hidden = false;
    renderWatch();
    $('stage').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function leaveWatch() {
    if (!watching) return;
    for (const el of document.querySelectorAll('.task.watched')) el.classList.remove('watched');
    watching = null;
    watchEl.hidden = true;
    watchEl.replaceChildren();
    hud.setMode('orbit');
  }
  function renderWatch() {
    const t = tasks.get(watching);
    if (!t) return leaveWatch();
    const running = t.status === 'running';
    const [label, tone] = running ? ['running', 'run'] : DONE[t.status] || [t.status, 'bad'];
    const list = h('ol', { class: 'watch-steps', 'aria-label': 'Steps' }, t.steps.map((st) => stepItem(st, t.startedAt)));
    if (!t.steps.length) list.append(h('li', { class: 'step dim' }, running ? 'Starting…' : 'No steps.'));
    const old = watchEl.querySelector('.watch-steps');
    const stick = !old || old.scrollTop + old.clientHeight >= old.scrollHeight - 30;
    const top = old ? old.scrollTop : 0;
    watchEl.replaceChildren(
      h('div', { class: 'watch-head' }, h('span', { class: 't ' + tone }, running ? KIND[t.kind] || t.kind : label), h('b', { title: t.title }, t.title),
        h('time', running ? { 'data-since': t.startedAt } : {}, elapsed((t.endedAt || Date.now()) - t.startedAt))),
      h('div', { class: 'watch-meta' }, t.project.toUpperCase() + ' · ' + plural(t.stepCount, 'step') + (t.stepCount > t.steps.length ? ' (latest ' + t.steps.length + ')' : '') + (t.costUsd ? ' · $' + t.costUsd.toFixed(2) : '')),
      list,
      withCode(h('p', { class: 'watch-text' }), (t.error || t.text || '').slice(-900)),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'mini', on: { click: leaveWatch } }, '← Back (Esc)'),
        running ? confirmButton('Stop', '', () => send({ type: 'stop', id: t.id })) : null,
        t.url ? h('a', { class: 'mini', href: t.url, target: '_blank', rel: 'noopener' }, 'Slack ↗') : null));
    list.scrollTop = stick ? list.scrollHeight : top;
  }

  setInterval(() => {
    for (const el of document.querySelectorAll('time[data-since]')) el.textContent = elapsed(Date.now() - Number(el.dataset.since));
    stageClock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (focusUntil && focusUntil <= Date.now()) { focusUntil = 0; focusPill.hidden = true; renderGauges(); }
  }, 1000);

  // ---- Operations ----
  const TIER = { urgent: 'bad', waiting: 'warn', later: '' };
  const JOB = { running: ['running', 'run'], failing: ['failing', 'bad'], paused: ['paused', 'warn'], ok: ['ok', 'ok'], new: ['not run yet', ''] };
  const CHANGE = { modified: 'M', added: 'A', deleted: 'D', untracked: 'U', conflict: '!' };

  function runBars(recent) {
    if (!recent || !recent.length) return null;
    const max = Math.max(...recent.map((r) => r.ms), 1);
    return h('span', { class: 'runbars', 'aria-label': 'Last runs: ' + recent.map((r) => r.status).join(', ') },
      [...recent].reverse().map((r) => {
        const bar = h('i', { class: ['failed', 'error', 'timeout', 'limit'].includes(r.status) ? 'bad' : r.status === 'ok' ? '' : 'dim', title: r.status + ' · ' + clock(r.at) + ' · ' + elapsed(r.ms) });
        bar.style.height = Math.round(30 + (70 * r.ms) / max) + '%';
        return bar;
      }));
  }

  function diffLines(text) {
    const lines = text.split('\\n').filter((l) => !/^(diff --git|index |--- |\\+\\+\\+ |new file mode|deleted file mode)/.test(l));
    return h('div', { class: 'diff', role: 'region', 'aria-label': 'Diff', tabindex: '0' }, lines.map((l) =>
      h('div', { class: 'dl' + (l.startsWith('@@') ? ' hunk' : l[0] === '+' ? ' add' : l[0] === '-' ? ' del' : '') }, l || ' ')));
  }

  const PANELS = {
    alert: (p) => ({
      kind: p.alert.kind === 'focus-over' ? 'Focus over' : 'Urgent', title: p.alert.text, tone: 'bad', project: p.alert.items[0] && p.alert.items[0].project,
      body: [h('ul', { class: 'rows' }, p.alert.items.map((i) => h('li', {}, h('span', { class: 't bad' }, i.project || 'urgent'),
        h('span', { class: 'grow' }, i.url ? h('a', { href: i.url, target: i.url.startsWith('/') ? undefined : '_blank', rel: 'noopener' }, i.title) : i.title)))),
        p.alert.quiet ? h('p', { class: 'dim' }, 'Not said out loud: another alert was said a short while ago.') : null],
    }),
    attention: (p) => ({
      kind: 'Needs you', title: p.items.length ? plural(p.items.length, 'item') : 'Nothing', tone: p.items.some((i) => i.tier === 'urgent') ? 'bad' : p.items.length ? 'warn' : 'ok',
      body: [p.items.length ? h('ul', { class: 'rows' }, p.items.map((i) => h('li', {}, h('span', { class: 't ' + TIER[i.tier] }, i.tier),
        h('span', { class: 'grow' }, i.url ? h('a', { href: i.url, target: i.url.startsWith('/') ? undefined : '_blank', rel: 'noopener' }, i.title) : i.title)))) : h('p', { class: 'dim' }, 'Nothing needs you.'),
        p.notes.length ? h('p', { class: 'dim' }, 'Could not check: ' + p.notes.join('; ')) : null],
    }),
    project: (p) => {
      const hl = health(p.project);
      return { kind: 'Project', title: p.project.title, project: p.project.name, tone: hl.tone === 'bad' ? 'bad' : hl.tone === 'warn' ? 'warn' : '',
        body: [p.project.repo && p.project.repo.branch ? h('p', { class: 'dim mono' }, 'on ' + p.project.repo.branch) : null, projectBody(p.project, hl)] };
    },
    jobs: (p) => ({
      kind: 'Jobs', title: p.project || 'All projects', project: p.project,
      body: p.jobs.length ? h('ul', { class: 'rows' }, p.jobs.map((j) => {
        const [label, tone] = JOB[j.state] || [j.state, ''];
        const sub = [p.project ? '' : j.project, j.nextRun ? 'next ' + clock(j.nextRun) : '', j.lastError ? j.lastError.slice(0, 140) : ''].filter(Boolean).join(' · ');
        return h('li', {}, h('span', { class: 'grow' }, j.name, sub ? h('span', { class: 'sub' }, sub) : null), runBars(j.recent), h('span', { class: 't ' + tone }, label),
          confirmButton('Run now', 'primary', () => send({ type: 'job', action: 'run', project: j.project, id: j.id })),
          j.state === 'paused'
            ? h('button', { type: 'button', class: 'mini', on: { click: () => send({ type: 'job', action: 'resume', project: j.project, id: j.id }) } }, 'Resume')
            : confirmButton('Pause', '', () => send({ type: 'job', action: 'pause', project: j.project, id: j.id })));
      })) : h('p', { class: 'dim' }, 'No scheduled jobs.'),
    }),
    repo: (p) => {
      const s = p.status;
      return {
        kind: 'Changes', title: p.repo, project: p.repo, tone: s.error ? 'bad' : '',
        body: [
          h('p', { class: 'dim' }, [s.branch ? 'On ' + s.branch : '', s.head ? 'last commit: ' + s.head.subject : ''].filter(Boolean).join(' · ')),
          s.error ? h('p', {}, s.error) : s.changes.length ? h('ul', { class: 'rows' }, s.changes.map((c) => h('li', {},
            h('span', { class: 't', title: c.state }, CHANGE[c.state] || '?'),
            h('span', { class: 'grow' }, c.binary ? h('span', { class: 'path' }, c.path) : h('button', { type: 'button', class: 'path', title: 'Show the diff', on: { click: () => send({ type: 'show', what: 'repo', project: p.repo, file: c.path }) } }, c.path)),
            c.binary ? h('span', { class: 'dim' }, 'binary') : h('span', { class: 'mono' }, h('span', { class: 'plus' }, '+' + c.added), ' ', h('span', { class: 'minus' }, '−' + c.removed))))) : h('p', {}, 'Nothing uncommitted.'),
          h('p', {}, h('a', { href: '/code/' + encodeURIComponent(p.repo) }, 'Open in Code →')),
        ],
      };
    },
    diff: (p) => ({
      kind: 'Diff', title: p.file, project: p.repo,
      body: [h('p', { class: 'dim' }, p.repo),
        p.diff.binary ? h('p', {}, 'A binary file.') : p.diff.text.trim() ? diffLines(p.diff.text) : h('p', { class: 'dim' }, 'No changes to show.'),
        p.diff.truncated ? h('p', { class: 'dim' }, 'Cut short: open it in Code for the rest.') : null,
        h('p', {}, h('a', { href: '/code/' + encodeURIComponent(p.repo) + '/diff?path=' + encodeURIComponent(p.file) }, 'Open in Code →'))],
    }),
    approvals: (p) => ({
      kind: 'Approvals', title: p.items.length ? plural(p.items.length, 'card') + ' waiting' : 'None waiting', project: p.project, tone: p.items.length ? 'warn' : 'ok',
      body: p.items.length ? p.items.map((i) => h('div', { class: 'approval' },
        h('div', {}, h('span', { class: 't' }, i.project), ' ', h('b', {}, i.title)),
        i.body ? h('div', { class: 'body' }, i.body) : null,
        h('div', { class: 'acts' }, i.options.map((o, n) => confirmButton(o, n === 0 ? 'primary' : '', () => send({ type: 'decide', id: i.id, option: o }))),
          h('a', { class: 'mini', href: '/approvals' }, 'Edit on Approvals →')))) : h('p', { class: 'dim' }, 'Nothing is waiting for a decision.'),
    }),
    ask: (p) => ({
      kind: 'Asked', title: p.project, project: p.project, tone: p.error ? 'bad' : p.answer ? 'ok' : 'warn',
      body: [h('p', { class: 'dim' }, p.question),
        p.error ? h('p', {}, 'Failed: ' + p.error) : p.answer ? withCode(h('p', {}), p.answer) : h('p', {}, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Checking…')],
    }),
    dispatch: (p) => ({
      kind: 'Sent to Slack', title: p.project, project: p.project, tone: p.error ? 'bad' : '',
      body: [h('p', { class: 'dim' }, p.task),
        p.error ? h('p', {}, 'Failed: ' + p.error) : p.url ? h('p', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'Open the Slack thread ↗')) : h('p', {}, 'Started in the project channel.')],
    }),
  };

  function renderPanel(id, p) {
    const old = ops.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (old) old.remove();
    const empty = ops.querySelector('.empty');
    if (empty) empty.remove();
    let el;
    if (p.kind === 'action') {
      el = h('div', { class: 'action' + (p.ok ? '' : ' bad'), 'data-id': id, role: p.ok ? undefined : 'alert' },
        h('span', { class: 'mark', 'aria-hidden': 'true' }, p.ok ? '✓' : '✕'), h('span', {}, (p.project ? p.project + ': ' : '') + p.text), h('time', {}, clock(Date.now())));
      announce((p.ok ? 'Done: ' : 'Failed: ') + p.text);
      if (!p.ok) hud.sfx('fail');
    } else {
      const v = (PANELS[p.kind] || (() => ({ kind: p.kind, title: '', body: [] })))(p);
      el = h('article', { class: 'panel ' + (v.tone || ''), 'data-id': id },
        h('div', { class: 'panel-head' }, h('span', { class: 'kind' }, v.kind), h('b', { title: v.title }, v.title), h('time', {}, clock(Date.now())),
          h('button', { type: 'button', class: 'x', 'aria-label': 'Close', on: { click: () => el.remove() } }, '×')),
        v.body);
      announce(v.kind + (v.title ? ': ' + v.title : ''));
      hud.ping(v.project);
      hud.sfx('blip');
    }
    ops.prepend(el);
    ops.parentElement.scrollTop = 0;
    while (ops.children.length > 24) ops.lastElementChild.remove();
  }
  $('ops-clear').addEventListener('click', () => {
    ops.replaceChildren(h('p', { class: 'empty' }, 'Cleared.'));
  });

  // ---- Voice ----
  const showLabel = () => {
    stateEl.textContent = state === 'listening' && !talking ? 'Ready · press Talk or type' : LABEL[state] || state;
  };

  function setState(next) {
    if (next === state) return;
    state = next;
    hud.setState(next);
    showLabel();
    if (next === 'listening' || next === 'thinking') turnBreak = true;
    if (next === 'idle' || next === 'listening') announce(LABEL[next]);
    if (next === 'idle' && talking) setTalking(false);
    clearTimeout(subsTimer);
    if (next === 'listening' || next === 'idle') subsTimer = setTimeout(() => subs.classList.add('quiet'), 7000);
  }
  let subsTimer;

  async function setupOutput() {
    // Resume first, while the click or key press still counts as one: some browsers won't start
    // audio after an await.
    if (!outCtx) outCtx = new AudioContext({ sampleRate: 24000 });
    const resumed = outCtx.resume();
    if (!player) {
      await outCtx.audioWorklet.addModule(moduleUrl(PLAYER_WORKLET));
      player = new AudioWorkletNode(outCtx, 'player', { numberOfInputs: 0, outputChannelCount: [1] });
      player.port.onmessage = (e) => { playing = e.data; hud.setSource(sourceNow()); };
      player.onprocessorerror = () => showAlert('Sound playback stopped working. Reload the page.');
      const analyser = outCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      player.connect(analyser).connect(outCtx.destination);
      hud.attach('out', analyser);
    }
    await resumed;
    if (outCtx.state !== 'running') showAlert('The browser is holding back sound: click anywhere on the page to allow it.');
  }
  document.addEventListener('click', () => { if (outCtx && outCtx.state !== 'running') outCtx.resume(); });

  async function startMic() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      showAlert('The microphone only works over HTTPS (or on localhost). Turn on http.tls, or type below.');
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
    const analyser = micCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    micSource.connect(analyser);
    hud.attach('mic', analyser);
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
    talking = on;
    hud.setSource(sourceNow());
    orb.setAttribute('aria-pressed', String(on));
    orbLabel.textContent = on ? 'Stop' : 'Talk';
    showLabel();
    if (on) {
      if (!(await startMic())) return setTalking(false);
      hideAlert();
      send({ type: 'talk' });
    } else {
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
      last = h('li', { class: 'turn ' + who, 'data-who': who }, h('span', { class: 'who' }, who === 'user' ? 'You' : AGENT), '');
      last.dataset.raw = '';
      log.append(last);
      while (log.children.length > 60) log.firstElementChild.remove();
      turnBreak = false;
      if (who === 'user') subModel.textContent = '';
    }
    // Markers such as <no speech> or {pause} arrive split across pieces: clean the whole turn, and
    // hold back a marker that hasn't closed yet.
    last.dataset.raw += text;
    const words = last.dataset.raw.replace(/<[^>]*>|\\{[^}]*\\}/g, '').replace(/[<{][^>}]*$/, '');
    last.lastChild.textContent = words;
    last.hidden = !words.trim();
    if (!last.hidden) log.scrollTop = log.scrollHeight;
    // Subtitles: the end of the current turn.
    const tail = words.trim().length > 200 ? '…' + words.trim().slice(-200) : words.trim();
    (who === 'user' ? subUser : subModel).textContent = tail;
    subs.classList.remove('quiet');
    clearTimeout(subsTimer);
  }

  function onOverview(e) {
    lastProjects = e.projects;
    needs = e.needs || needs;
    focusUntil = e.focusUntil;
    const focused = focusUntil > Date.now();
    focusPill.hidden = !focused;
    if (focused) focusPill.lastChild.textContent = 'Focus until ' + clock(focusUntil);
    renderProjects();
    firstOverview(lastProjects.map((p) => ({ name: p.name, ...health(p) })));
  }

  function onEvent(e) {
    if (e.type === 'state') setState(e.state);
    else if (e.type === 'transcript') addText(e.who, e.text);
    else if (e.type === 'interrupted') { if (player) player.port.postMessage('flush'); turnBreak = true; }
    else if (e.type === 'panel') renderPanel(e.id, e.panel);
    else if (e.type === 'overview') onOverview(e);
    else if (e.type === 'tasks') {
      live = false;
      tasks.clear(); tasksRunning.replaceChildren(); tasksDone.replaceChildren();
      [...e.tasks].reverse().forEach(upsertTask);
      live = true;
      usage = e.usage || usage;
      renderGauges();
    }
    else if (e.type === 'task') upsertTask(e.task);
    else if (e.type === 'usage') { usage = e.usage; renderGauges(); }
    else if (e.type === 'watch') enterWatch(e.id);
    else if (e.type === 'alert') onAlert(e);
    else if (e.type === 'notify') onNotify(e);
    else if (e.type === 'config') alertLang = e.alertLang;
    else if (e.type === 'error') { showAlert(e.message); setTalking(false); }
  }

  function setLink(on) {
    linkPill.classList.toggle('on', on);
    linkPill.lastChild.textContent = on ? 'Connected' : 'Reconnecting…';
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/command/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { retry = 0; hideAlert(); orb.disabled = false; setLink(true); };
    ws.onmessage = (e) => (typeof e.data === 'string' ? onEvent(JSON.parse(e.data)) : play(e.data));
    ws.onclose = () => {
      orb.disabled = true;
      setLink(false);
      setTalking(false);
      setState('idle');
      showAlert('Lost the connection to ' + AGENT + '. Reconnecting…');
      setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    };
  }

  orb.addEventListener('click', () => setTalking(!talking));
  // Space toggles Talk from anywhere on the page, except while typing or on another control; Esc leaves Watch.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && watching) { leaveWatch(); return; }
    if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t !== document.body && t !== document.documentElement) return;
    e.preventDefault();
    if (!orb.disabled) setTalking(!talking);
  });
  $('live-alert-close').addEventListener('click', hideAlert);
  $('show-attention').addEventListener('click', () => send({ type: 'show', what: 'attention' }));
  // A briefing is a typed turn: the model calls brief and says it.
  async function brief() {
    await setupOutput();
    turnBreak = true;
    addText('user', 'Brief me.');
    turnBreak = true;
    send({ type: 'text', text: 'Brief me.' });
  }
  $('brief').addEventListener('click', brief);
  soundBtn.setAttribute('aria-pressed', String(hud.soundOn()));
  soundBtn.addEventListener('click', () => {
    const on = !hud.soundOn();
    hud.setSound(on);
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.lastChild.textContent = on ? 'Sound on' : 'Sound off';
  });
  soundBtn.lastChild.textContent = hud.soundOn() ? 'Sound on' : 'Sound off';
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

  renderGauges();
  hud.runBoot(AGENT, () => Promise.race([projectsReady, new Promise((r) => setTimeout(() => r([]), 1500))]));
  connect();
`;

export const COMMAND_SCRIPT = `
(() => {
${HEAD}
${HUD_SCRIPT}
${APP}
})();
`;
