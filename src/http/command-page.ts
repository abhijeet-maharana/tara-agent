import { COMMAND_SCRIPT } from './command-script.js';
import { COMMAND_CSS } from './command-style.js';
import { type DashboardContext, esc, layout } from './dashboard.js';

/**
 * `/command`: talk to the agent and watch it work. The stage holds the core (Talk) with every project
 * orbiting it, the subtitles, and the Watch view for one task; below it the live tasks, and beside it
 * Operations, where every tool call shows up as a panel; the gauge strip runs along the bottom. The
 * page streams the microphone to `/command/ws` while Talk is on and plays the speech that comes back;
 * see docs/command.md. Quiet by default: nothing plays unless you talked first.
 */
export function commandPage(ctx: DashboardContext, opts: { unlocked: boolean }): string {
  if (!opts.unlocked)
    return layout(
      ctx,
      'Command',
      'Command',
      `<header class="page-head"><h1>Command</h1></header><div class="card warn"><div class="title">This browser isn't unlocked</div><p class="answer">Command can start Claude conversations, run jobs and decide approvals, so it needs the same key as the Approvals page. <a href="/unlock">Unlock this browser</a>, then come back.</p></div>`,
    );
  const example = esc(ctx.projects[0]?.config.name ?? 'shop');
  const agent = esc(ctx.agentName);
  const body = `<header class="cmd-head"><h1>Command</h1><span class="who">${agent} · agent console</span><span class="grow"></span>
  <span class="pill focus" id="focus-pill" hidden><span class="dot" aria-hidden="true"></span><span></span></span>
  <button type="button" class="pill" id="brief" title="What needs you, what's running, what just finished, said out loud"><span class="dot" aria-hidden="true"></span><span>Brief me</span></button>
  <button type="button" class="pill" id="sound" aria-pressed="false" title="Short sounds when tasks start and finish"><span class="dot" aria-hidden="true"></span><span>Sound off</span></button>
  <span class="pill" id="link-pill"><span class="dot" aria-hidden="true"></span><span>Connecting…</span></span>
</header>
<div class="alert" id="live-alert" role="alert" hidden><span class="grow" id="live-alert-text"></span><button type="button" class="btn ghost" id="live-alert-close">Dismiss</button></div>
<div class="deck">
  <div class="left">
    <section class="stage" id="stage" data-mode="orbit" aria-label="Voice and projects">
      <canvas id="hud" aria-hidden="true"></canvas>
      <span class="brk tl" aria-hidden="true"></span><span class="brk tr" aria-hidden="true"></span><span class="brk bl" aria-hidden="true"></span><span class="brk br" aria-hidden="true"></span>
      <span class="stage-tag l" aria-hidden="true">Core // ${agent}</span><span class="stage-tag r" id="stage-clock" aria-hidden="true"></span>
      <div class="nodes" id="nodes" role="group" aria-label="Projects"></div>
      <button type="button" class="reactor" id="talk" aria-pressed="false" aria-describedby="live-state" disabled><span id="talk-label">Talk</span></button>
      <div class="live-state" id="live-state">Standing by</div>
      <div class="subtitles quiet" id="subtitles" aria-hidden="true"><p class="sub-user" id="sub-user"></p><p class="sub-model" id="sub-model"></p></div>
      <div class="watch" id="watch" hidden></div>
      <pre class="boot" id="boot" hidden aria-hidden="true"></pre>
    </section>
    <form class="type-form" id="type-form"><label class="visually-hidden" for="type-text">Type instead</label><input class="input" id="type-text" name="text" autocomplete="off" placeholder="Press Space to talk, or type: “What needs me?”, “What's running?”, “Show ${example}'s changes”"><button class="btn" type="submit">Send</button></form>
    <h2 class="col-head" id="tasks-head" hidden><b>Live tasks</b></h2>
    <div class="tasks" id="tasks-running" aria-live="off"></div>
    <div class="tasks" id="tasks-done"></div>
    <section aria-labelledby="systems-head" class="systems-wrap">
      <h2 class="col-head" id="systems-head"><b>Projects</b><span class="grow"></span><button type="button" id="show-attention">What needs me?</button></h2>
      <div class="systems-list" id="systems"></div>
    </section>
    <details class="log"><summary>Conversation</summary><ol class="transcript" id="transcript" aria-label="Conversation" data-agent="${agent}"></ol></details>
    <details class="diag"><summary>Sound details</summary><pre id="live-diag">Open to see what the sound and microphone are doing.</pre></details>
  </div>
  <aside class="ops-col" aria-labelledby="ops-head">
    <h2 class="col-head" id="ops-head"><b>Operations</b><span class="grow"></span><button type="button" id="ops-clear">Clear</button></h2>
    <div class="ops" id="ops"><p class="empty">Lists, answers and actions show up here as you ask, or when you click a project.</p></div>
  </aside>
</div>
<nav class="gauges" id="gauges" aria-label="At a glance"></nav>
<div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" id="live-status"></div>
<style>${COMMAND_CSS}</style>`;
  return layout(ctx, 'Command', 'Command', body, { script: COMMAND_SCRIPT });
}
