/**
 * The Command page's HUD, as a script fragment that runs inside the page's script (it uses `$` and
 * `h` from there): the core drawn on a canvas (rings, and a waveform from the real microphone or
 * voice), projects orbiting it with links that pulse while work runs there, the boot sequence, and UI
 * sounds. It knows nothing about the WebSocket: the page tells it the state, the projects and where
 * the sound comes from, and gets node clicks back.
 */
export const HUD_SCRIPT = `
  // ---- HUD ----
  const hud = (() => {
    const stage = $('stage'), canvas = $('hud'), nodesEl = $('nodes'), bootEl = $('boot');
    const ctx = canvas.getContext('2d');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const SPIN = { idle: 0.08, connecting: 1.4, listening: 0.35, thinking: 1.8, speaking: 0.6 };
    let W = 0, H = 0, dpr = 1, links = true, mode = 'orbit', state = 'idle', source = null, bootStart = 0, bootDone = true, level = 0;
    const analysers = {};
    const bins = new Uint8Array(128);
    const geo = { cx: 0, cy: 0, r: 0 }, goal = { cx: 0, cy: 0, r: 0 };
    let nodes = [], onNode = () => {}, colors = {}, cssVars = '', alertUntil = 0;

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      for (const k of ['accent', 'amber', 'green', 'red', 'text-dim', 'border-light']) colors[k] = cs.getPropertyValue('--' + k).trim();
    }
    function rgba(color, a) {
      const m = /^#([0-9a-f]{6})$/i.exec(color || '');
      if (!m) return color;
      const n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }
    const TONE = { ok: 'green', warn: 'amber', bad: 'red', run: 'accent' };
    const stateColor = () => colors[{ idle: 'accent', connecting: 'text-dim', listening: 'accent', thinking: 'amber', speaking: 'green' }[state] || 'accent'];

    function layout() {
      W = stage.clientWidth; H = stage.clientHeight;
      // Narrow screens hide the nodes (the page lists the projects instead): no links to nowhere.
      links = nodesEl.offsetWidth > 0;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (mode === 'watch') { goal.r = 30; goal.cx = 54; goal.cy = 58; }
      else { goal.r = Math.max(46, Math.min(84, Math.min(W, H) * 0.15)); goal.cx = W / 2; goal.cy = H * 0.46; }
      if (!geo.r || still.matches) Object.assign(geo, goal);
      placeNodes();
    }

    // Around the core, leaving the bottom middle free for the subtitles.
    function placeNodes() {
      const n = nodes.length;
      const rx = Math.max(120, Math.min(W * 0.37, W / 2 - 92)), ry = H * 0.34;
      nodes.forEach((node, i) => {
        const a = ((120 + (300 * (i + 0.5)) / n) * Math.PI) / 180;
        node.x = goal.cx + rx * Math.cos(a);
        node.y = goal.cy + ry * Math.sin(a);
        node.el.style.left = node.x + 'px';
        node.el.style.top = node.y + 'px';
      });
    }

    /** list: [{name, title, tone: ok|warn|bad|run, meta, active}] */
    function setProjects(list) {
      const old = new Map(nodes.map((n) => [n.name, n]));
      nodes = list.map((p, i) => {
        let node = old.get(p.name);
        if (!node) {
          const el = h('button', { type: 'button', class: 'node', 'data-project': p.name }, h('b', {}), h('span', { class: 'nm' }));
          el.addEventListener('click', () => onNode(p.name));
          el.style.transitionDelay = bootDone ? '0s' : (0.15 + i * 0.12) + 's';
          nodesEl.append(el);
          node = { name: p.name, el };
        }
        old.delete(p.name);
        node.tone = p.tone; node.active = p.active;
        node.el.dataset.tone = p.tone;
        node.el.classList.toggle('active', p.active);
        node.el.firstChild.textContent = p.title;
        node.el.lastChild.textContent = p.meta;
        node.el.setAttribute('aria-label', p.title + ': ' + p.meta);
        return node;
      });
      for (const gone of old.values()) gone.el.remove();
      placeNodes();
      kick();
    }

    function ping(name) {
      const node = nodes.find((n) => n.name === name);
      if (!node) return;
      node.el.classList.add('ping');
      node.flash = performance.now();
      setTimeout(() => node.el.classList.remove('ping'), 2200);
    }

    // Frames only as often as something moves: 60 a second while sound plays, it thinks or connects,
    // or the stage changes; 30 while work pulses along the links; 12 otherwise; none while the stage
    // is off screen or the tab hidden. Reduced motion: 4.
    let pending = false, timer = 0, onScreen = true;
    function schedule(delay) {
      if (pending) return;
      pending = true;
      const go = () => { timer = 0; requestAnimationFrame((now) => { pending = false; frame(now); }); };
      if (delay) timer = setTimeout(go, delay); else go();
    }
    /** Something changed: draw now rather than at the next slow frame. */
    function kick() {
      if (timer) { clearTimeout(timer); timer = 0; pending = false; }
      schedule(0);
    }
    function frame(now) {
      if (document.hidden || !onScreen || !W) return;
      draw(now);
      const moving = Math.abs(goal.r - geo.r) + Math.abs(goal.cx - geo.cx) + Math.abs(goal.cy - geo.cy) > 0.5;
      const busy = source || state === 'thinking' || state === 'connecting' || !bootDone || now < alertUntil || moving;
      schedule(still.matches ? 250 : busy ? 0 : nodes.some((n) => n.active) ? 33 : 83);
    }
    document.addEventListener('visibilitychange', kick);
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; if (onScreen) kick(); }).observe(stage);

    function draw(now) {
      const calm = still.matches;
      const k = calm ? 1 : 0.14;
      geo.cx += (goal.cx - geo.cx) * k; geo.cy += (goal.cy - geo.cy) * k; geo.r += (goal.r - geo.r) * k;
      const vars = geo.cx.toFixed(1) + '|' + geo.cy.toFixed(1) + '|' + geo.r.toFixed(1);
      if (vars !== cssVars) {
        cssVars = vars;
        stage.style.setProperty('--cx', geo.cx.toFixed(1) + 'px');
        stage.style.setProperty('--cy', geo.cy.toFixed(1) + 'px');
        stage.style.setProperty('--r', geo.r.toFixed(1) + 'px');
      }
      const t = now / 1000;
      const boot = bootDone ? 1 : Math.min(1, (now - bootStart) / 1400);
      const ease = 1 - Math.pow(1 - boot, 3);
      const { cx, cy, r } = geo;
      // An urgent alert turns the core red for a few seconds, pulsing.
      const alerting = now < alertUntil;
      const col = alerting ? colors.red : stateColor();
      if (alerting) level = Math.max(level, calm ? 0.4 : 0.25 + 0.25 * Math.sin(t * 9));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';

      // Sound: the voice while it plays, else the microphone while talking.
      const an = source && analysers[source];
      let sum = 0;
      if (an) { an.getByteFrequencyData(bins); for (let i = 2; i < 40; i++) sum += bins[i]; }
      level += ((an ? sum / 38 / 255 : 0) - level) * 0.25;

      // Links to the projects; work running there travels along them.
      if (mode === 'orbit' && bootDone && links) {
        for (const n of nodes) {
          const dx = n.x - cx, dy = n.y - cy, d = Math.hypot(dx, dy);
          if (d < r * 2) continue;
          const ux = dx / d, uy = dy / d, x0 = cx + ux * r * 1.75, y0 = cy + uy * r * 1.75;
          const tone = colors[TONE[n.tone]] || colors.accent;
          ctx.setLineDash(n.active ? [] : [2, 6]);
          ctx.strokeStyle = n.active || n.tone === 'bad' ? rgba(tone, 0.5) : rgba(colors.accent, 0.18);
          ctx.lineWidth = n.active ? 1.3 : 1;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(n.x, n.y); ctx.stroke();
          ctx.setLineDash([]);
          if (n.active && !calm) {
            for (let j = 0; j < 2; j++) {
              const f = (t / 1.6 + j / 2 + n.x * 0.001) % 1;
              const px = x0 + (n.x - x0) * f, py = y0 + (n.y - y0) * f;
              ctx.fillStyle = rgba(tone, 0.22);
              ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.fill();
              ctx.fillStyle = tone;
              ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }

      // Tick ring, turning slowly the other way.
      const ticks = Math.round(60 * ease);
      ctx.strokeStyle = rgba(colors.accent, 0.4); ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < ticks; i++) {
        const a = (i / 60) * Math.PI * 2 - (calm ? 0 : t * 0.04);
        const r0 = r * 1.62, r1 = r0 + (i % 5 === 0 ? 7 : 3);
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      ctx.stroke();
      // Three arcs, faster while it thinks or connects.
      const turn = calm ? 0 : t * (SPIN[state] || 0.3);
      // A wide faint stroke under a thin bright one: a glow without shadowBlur, which is slow to draw.
      const arcs = () => {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a0 = turn + (i * Math.PI * 2) / 3;
          ctx.moveTo(cx + Math.cos(a0) * r * 1.38, cy + Math.sin(a0) * r * 1.38);
          ctx.arc(cx, cy, r * 1.38, a0, a0 + ((Math.PI * 2) / 3 - 0.7) * ease);
        }
        ctx.stroke();
      };
      ctx.strokeStyle = rgba(col, 0.16); ctx.lineWidth = 9; arcs();
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; arcs();
      if (state === 'thinking' && !calm) {
        const a = t * 3.2;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * r * 1.38, cy + Math.sin(a) * r * 1.38, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = rgba(col, 0.3); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.18, 0, Math.PI * 2 * ease); ctx.stroke();

      // Waveform: 72 bars around the core, mirrored left and right.
      const bars = 72;
      ctx.lineWidth = Math.max(1.5, r / 36);
      // Bars in four brightness steps, one path each, rather than one stroke per bar.
      const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < bars; i++) {
        const m = i < bars / 2 ? i : bars - 1 - i;
        const v = an ? bins[2 + m] / 255 : calm ? 0.05 : 0.05 + 0.035 * Math.sin(t * 1.6 + i * 0.35);
        const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const r0 = r * 1.02, r1 = r0 + 2 + v * r * 0.4 * ease;
        const path = paths[Math.min(3, Math.floor(v * 4))];
        path.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); path.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      }
      paths.forEach((path, k) => { ctx.strokeStyle = rgba(col, 0.3 + 0.2 * k); ctx.stroke(path); });

      // The core itself, glowing with the sound.
      const glow = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
      glow.addColorStop(0, rgba(col, 0.1 + level * 0.5));
      glow.addColorStop(1, rgba(col, 0.02));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.96 * (1 + level * 0.06), 0, Math.PI * 2); ctx.fill();
      const rim = r * 0.96 * (1 + level * 0.06);
      ctx.strokeStyle = rgba(col, 0.12 + level * 0.35); ctx.lineWidth = 5 + level * 14;
      ctx.beginPath(); ctx.arc(cx, cy, rim, 0, Math.PI * 2 * ease); ctx.stroke();
      ctx.strokeStyle = rgba(col, 0.9); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, rim, 0, Math.PI * 2 * ease); ctx.stroke();
    }

    // Boot: rings draw in, a few lines of systems check, then the projects fade in. Once per browser
    // session, never with reduced motion, and any key or click skips it.
    function runBoot(agent, projectsReady) {
      let seen = false;
      try { seen = sessionStorage.getItem('command-booted') === '1'; sessionStorage.setItem('command-booted', '1'); } catch {}
      if (seen || still.matches) return;
      bootDone = false; bootStart = performance.now();
      kick();
      stage.classList.add('booting');
      bootEl.hidden = false;
      const timers = [];
      const finish = () => {
        if (bootDone) return;
        bootDone = true;
        timers.forEach(clearTimeout);
        stage.classList.remove('booting');
        bootEl.classList.add('done');
        setTimeout(() => { bootEl.hidden = true; bootEl.replaceChildren(); nodes.forEach((n) => { n.el.style.transitionDelay = '0s'; }); }, 2200);
        window.removeEventListener('keydown', finish, true);
        stage.removeEventListener('pointerdown', finish);
      };
      window.addEventListener('keydown', finish, true);
      stage.addEventListener('pointerdown', finish);
      const line = (text, tone) => {
        const pad = !text[1] ? '' : text[0].length < 20 ? ' ' + '.'.repeat(20 - text[0].length) + ' ' : ' ';
        bootEl.append(text[0] + pad, tone ? h('span', { class: tone }, text[1]) : text[1] || '', '\\n');
      };
      const at = (ms, fn) => timers.push(setTimeout(fn, ms));
      at(0, () => line(['COMMAND // ' + agent.toUpperCase(), '']));
      at(220, () => line(['core', 'online'], 'ok'));
      at(420, () => line(['voice link', 'standing by'], 'ok'));
      at(640, () => projectsReady().then((list) => {
        if (bootDone) return;
        list.slice(0, 6).forEach((p, i) => at(i * 110, () => line([p.name, p.meta], p.tone === 'bad' ? 'bad' : p.tone === 'warn' ? 'warn' : 'ok')));
        at(list.slice(0, 6).length * 110 + 160, () => {
          const trouble = list.filter((p) => p.tone === 'bad' || p.tone === 'warn').length;
          line(['systems', trouble ? trouble + ' need you' : 'nominal'], trouble ? 'warn' : 'ok');
          at(650, finish);
        });
      }));
      at(4500, finish);
    }

    // UI sounds, made here (no files), off unless turned on.
    let sfxCtx = null, sfxOn = false;
    try { sfxOn = localStorage.getItem('command-sound') === 'on'; } catch {}
    function tone(freq, start, dur, type, gain) {
      const o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, sfxCtx.currentTime + start);
      g.gain.setValueAtTime(0, sfxCtx.currentTime + start);
      g.gain.linearRampToValueAtTime(gain || 0.05, sfxCtx.currentTime + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, sfxCtx.currentTime + start + dur);
      o.connect(g).connect(sfxCtx.destination);
      o.start(sfxCtx.currentTime + start); o.stop(sfxCtx.currentTime + start + dur + 0.02);
    }
    const SOUNDS = {
      blip: () => tone(1320, 0, 0.07, 'sine', 0.03),
      start: () => { tone(523, 0, 0.09); tone(784, 0.08, 0.12); },
      done: () => { tone(659, 0, 0.1); tone(880, 0.09, 0.1); tone(1175, 0.18, 0.18); },
      fail: () => { tone(330, 0, 0.14, 'triangle', 0.06); tone(220, 0.12, 0.24, 'triangle', 0.06); },
      alert: () => { tone(880, 0, 0.16, 'triangle', 0.08); tone(660, 0.19, 0.16, 'triangle', 0.08); tone(880, 0.38, 0.26, 'triangle', 0.08); },
    };
    /** \`always\`: play even with Sound off (urgent alerts). */
    function sfx(kind, always) {
      if ((!sfxOn && !always) || !SOUNDS[kind]) return;
      // Browsers only start sound after a click or key press on the page.
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      try {
        if (!sfxCtx) sfxCtx = new AudioContext();
        if (sfxCtx.state !== 'running') sfxCtx.resume();
        SOUNDS[kind]();
      } catch {}
    }
    function setSound(on) {
      sfxOn = on;
      try { localStorage.setItem('command-sound', on ? 'on' : 'off'); } catch {}
      if (on) sfx('blip');
    }

    readColors();
    new ResizeObserver(() => { layout(); kick(); }).observe(stage);
    layout();
    kick();
    return {
      setState: (s) => { state = s; kick(); },
      setMode: (m) => { mode = m; stage.dataset.mode = m; layout(); kick(); },
      attach: (kind, analyser) => { analysers[kind] = analyser; },
      setSource: (kind) => { source = kind; kick(); },
      setProjects, ping, runBoot, sfx, setSound,
      alert: () => { alertUntil = performance.now() + 4000; kick(); },
      soundOn: () => sfxOn,
      onNode: (fn) => { onNode = fn; },
    };
  })();
`;
