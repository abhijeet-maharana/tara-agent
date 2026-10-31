/**
 * The Command page's styles, on top of the dashboard's look (src/http/look.ts): a stage with the core
 * and the project orbit, live task cards, Operations panels and the gauge strip.
 */
export const COMMAND_CSS = `
:root{--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.main>*{max-width:none}
.mono{font-family:var(--mono)}
.cmd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.cmd-head h1{margin:0}
.cmd-head .who{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-dim)}
.cmd-head .grow{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--border-light);color:var(--text-dim);background:none;font-family:inherit}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--text-dim)}
.pill.on{color:var(--text-heading)}.pill.on .dot{background:var(--green);box-shadow:0 0 8px var(--green)}
.pill.focus{border-color:var(--amber);color:var(--amber)}.pill.focus .dot{background:var(--amber)}
.pill.warn{border-color:var(--amber);color:var(--amber)}.pill.bad{border-color:var(--red);color:var(--red)}
.pill.warn .dot{background:var(--amber)}.pill.bad .dot{background:var(--red)}
button.pill{cursor:pointer}button.pill:hover{color:var(--text-heading);border-color:var(--accent)}
button.pill[aria-pressed=true]{color:var(--accent);border-color:var(--accent)}
.pill[hidden]{display:none}
.alert{display:flex;gap:10px;align-items:center;background:var(--red-dim);border:1px solid var(--red);color:var(--text-heading);border-radius:var(--radius);padding:10px 14px;margin-bottom:16px}
.alert[hidden]{display:none}
.alert .grow{flex:1}
.deck{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,410px);gap:18px;align-items:start}
.left{display:flex;flex-direction:column;gap:14px;min-width:0}
.col-head{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-dim);font-weight:500}
.col-head b{color:var(--accent);font-weight:600}
.col-head .grow{flex:1}
.col-head button{font:inherit;letter-spacing:normal;text-transform:none;background:none;border:0;color:var(--text-dim);cursor:pointer;padding:0;font-family:var(--font)}
.col-head button:hover{color:var(--accent)}
.col-head[hidden]{display:none}

/* Stage: the core, the orbit, the watch view */
.stage{--cx:50%;--cy:46%;--r:80px;--grid:color-mix(in srgb,var(--accent) 6%,transparent);position:relative;height:clamp(380px,56vh,580px);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;isolation:isolate;
  background:radial-gradient(circle at var(--cx) var(--cy),color-mix(in srgb,var(--accent) 10%,transparent),transparent 55%),linear-gradient(var(--grid) 1px,transparent 1px) 0 0/32px 32px,linear-gradient(90deg,var(--grid) 1px,transparent 1px) 0 0/32px 32px,var(--panel)}
.stage canvas{position:absolute;inset:0;width:100%;height:100%;z-index:0}
.brk{position:absolute;width:18px;height:18px;border:0 solid color-mix(in srgb,var(--accent) 55%,transparent);z-index:1;pointer-events:none}
.brk.tl{top:9px;left:9px;border-top-width:1.5px;border-left-width:1.5px}.brk.tr{top:9px;right:9px;border-top-width:1.5px;border-right-width:1.5px}
.brk.bl{bottom:9px;left:9px;border-bottom-width:1.5px;border-left-width:1.5px}.brk.br{bottom:9px;right:9px;border-bottom-width:1.5px;border-right-width:1.5px}
.stage-tag{position:absolute;top:14px;z-index:1;font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:color-mix(in srgb,var(--accent) 70%,var(--text-dim));pointer-events:none}
.stage-tag.l{left:34px}.stage-tag.r{right:34px;font-variant-numeric:tabular-nums}
.reactor{position:absolute;z-index:3;left:calc(var(--cx) - var(--r));top:calc(var(--cy) - var(--r));width:calc(var(--r) * 2);height:calc(var(--r) * 2);border-radius:50%;border:0;padding:0;background:none;cursor:pointer;color:var(--text-heading);font-family:var(--mono);font-size:13px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;text-indent:.24em}
.reactor:disabled{cursor:default;color:var(--text-dim)}
.reactor:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
.stage[data-mode=watch] .reactor{font-size:10px;letter-spacing:.12em;text-indent:.12em}
.live-state{position:absolute;z-index:2;left:0;right:0;top:calc(var(--cy) + var(--r) * 1.78 + 4px);text-align:center;font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--text-dim);pointer-events:none}
.stage[data-mode=watch] .live-state,.stage[data-mode=watch] .stage-tag{display:none}
.subtitles{position:absolute;z-index:2;left:50%;bottom:18px;transform:translateX(-50%);width:min(680px,86%);text-align:center;pointer-events:none;transition:opacity .6s}
.subtitles.quiet{opacity:0}
.subtitles p{margin:0;text-shadow:0 1px 8px var(--bg),0 0 2px var(--bg)}
.sub-user{font-size:13px;color:var(--text-dim);margin-bottom:4px!important}
.sub-model{font-size:16.5px;line-height:1.4;color:var(--text-heading)}
.stage[data-mode=watch] .subtitles{display:none}
.nodes{position:absolute;inset:0;z-index:2;pointer-events:none}
.node{--tone:var(--green);position:absolute;transform:translate(-50%,-50%);pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:1px;min-width:96px;max-width:170px;padding:6px 11px;border:1px solid color-mix(in srgb,var(--tone) 45%,var(--border));border-radius:8px;background:color-mix(in srgb,var(--card-bg) 90%,transparent);color:var(--text);font:inherit;cursor:pointer;transition:opacity .5s,box-shadow .3s,border-color .3s,left .5s,top .5s}
.node[data-tone=bad]{--tone:var(--red)}.node[data-tone=warn]{--tone:var(--amber)}.node[data-tone=run]{--tone:var(--accent)}
.node b{display:flex;align-items:center;gap:6px;max-width:100%;color:var(--text-heading);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.node b::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone);box-shadow:0 0 7px var(--tone)}
.node .nm{font-family:var(--mono);font-size:10.5px;color:var(--text-dim);white-space:nowrap}
.node:hover,.node:focus-visible{border-color:var(--tone);outline:none;box-shadow:0 0 0 1px var(--tone)}
.node.active{box-shadow:0 0 18px color-mix(in srgb,var(--tone) 35%,transparent)}
.node.ping{box-shadow:0 0 0 2px var(--accent),0 0 22px var(--accent-dim)}
.stage.booting .node{opacity:0}
.stage[data-mode=watch] .nodes{display:none}
.boot{position:absolute;z-index:4;left:34px;top:38px;margin:0;padding:0;background:none;border:0;border-radius:0;font-family:var(--mono);font-size:12px;line-height:1.55;color:var(--accent);white-space:pre;pointer-events:none;transition:opacity .5s;text-shadow:0 0 8px var(--accent-dim)}
.boot.done{opacity:0}
.boot .ok{color:var(--green)}.boot .bad{color:var(--red)}.boot .warn{color:var(--amber)}
.watch{position:absolute;z-index:2;inset:14px 14px 14px 112px;display:flex;flex-direction:column;gap:8px;min-height:0}
.watch[hidden]{display:none}
.watch-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.watch-head b{flex:1;min-width:0;font-size:16px;color:var(--text-heading);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.watch-head time{font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--accent)}
.watch-meta{font-family:var(--mono);font-size:11.5px;color:var(--text-dim);letter-spacing:.04em}
.watch-steps{flex:1;min-height:0;overflow-y:auto;list-style:none;margin:0;padding:8px 10px;display:grid;align-content:start;gap:4px;font-family:var(--mono);font-size:12.5px;background:color-mix(in srgb,var(--bg) 70%,transparent);border:1px solid var(--border);border-radius:8px}
.watch-steps .at{flex:none;width:44px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.watch-text{margin:0;max-height:30%;overflow-y:auto;font-size:13.5px;color:var(--text);white-space:pre-wrap;border-left:2px solid var(--accent);padding-left:10px}
.watch-text:empty{display:none}

/* Live tasks */
.tasks{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:10px}
.tasks:empty{display:none}
.task{--rc:var(--accent);position:relative;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;overflow:hidden;min-width:0}
.task.run{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.task.run::after{content:"";position:absolute;left:0;top:0;width:40%;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 1.8s linear infinite;will-change:transform}
@keyframes scan{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
.task.ok{--rc:var(--green)}.task.bad{--rc:var(--red)}.task.stopped{--rc:var(--text-dim)}
.task.watched{box-shadow:0 0 0 1px var(--accent)}
.task-head{display:flex;align-items:center;gap:8px}
.task-head b{flex:1;min-width:0;color:var(--text-heading);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-head time{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12px;color:var(--rc)}
.task-meta{font-size:12px;color:var(--text-dim);margin:2px 0 6px}
.steps{list-style:none;margin:0 0 6px;padding:0;display:grid;gap:3px;font-size:12.5px;font-family:var(--mono)}
.step{display:flex;gap:7px;align-items:baseline;color:var(--text);overflow-wrap:anywhere}
.step[data-depth="1"]{padding-left:16px;color:var(--text-dim)}
.step .ic{flex:none;width:12px;text-align:center}
.step[data-state=ok] .ic{color:var(--green)}.step[data-state=error] .ic{color:var(--red)}
.step[data-state=running]{color:var(--text-heading)}
.step[data-state=running] .ic::before{content:"";display:inline-block;width:8px;height:8px;border:1.5px solid var(--accent);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.task-text{font-size:13px;color:var(--text-dim);margin:0 0 6px;white-space:pre-wrap;max-height:4.8em;overflow:hidden;-webkit-mask:linear-gradient(transparent,#000 1.4em);mask:linear-gradient(transparent,#000 1.4em)}
.task.done .task-text{-webkit-mask:none;mask:none;max-height:none}
.task.done{padding:8px 12px}
.task.done details summary{cursor:pointer;font-size:12.5px;color:var(--text-dim)}
.more{background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--text-dim);cursor:pointer}
.more:hover{color:var(--accent)}
.acts{display:flex;flex-wrap:wrap;gap:6px}
.mini{font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid var(--border-light);background:transparent;color:var(--text);cursor:pointer;text-decoration:none}
.mini:hover{border-color:var(--accent);color:var(--text-heading)}
.mini.primary{border-color:var(--accent);color:var(--accent)}
.mini.armed{background:var(--amber-dim);border-color:var(--amber);color:var(--amber)}
.mini:disabled{opacity:.45;cursor:default}

/* Typing, conversation log, project list for narrow screens */
.type-form{display:flex;gap:8px}
.type-form .input{flex:1;min-height:0;min-width:0}
.log,.diag{font-size:13px;color:var(--text-dim)}
.log summary,.diag summary{cursor:pointer}
.transcript{display:grid;gap:8px;margin:10px 0 0;padding:0;list-style:none;max-height:40vh;overflow-y:auto}
.transcript:empty::after{content:"Nothing said yet.";font-size:13px}
.turn{max-width:88%;padding:7px 11px;border-radius:12px;background:var(--card-bg);border:1px solid var(--border);overflow-wrap:anywhere;font-size:14px;color:var(--text)}
.turn.user{justify-self:end;background:var(--accent-dim);border-color:transparent;color:var(--text-heading)}
.turn .who{display:block;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-dim);margin-bottom:2px}
.systems-wrap{display:none}.systems-list{display:grid;gap:10px}
.sys{--tone:var(--green);background:var(--card-bg);border:1px solid var(--border);border-left:3px solid var(--tone);border-radius:var(--radius);padding:10px 12px}
.sys[data-tone=bad]{--tone:var(--red)}.sys[data-tone=warn]{--tone:var(--amber)}.sys[data-tone=run]{--tone:var(--accent)}
.sys-top{display:flex;align-items:center;gap:8px}
.sys-top b{color:var(--text-heading);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.branch{margin-left:auto;font-size:11.5px;color:var(--text-dim);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.sys-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--tone);box-shadow:0 0 8px var(--tone)}
.pstats{margin:6px 0 8px;font-size:12.5px;color:var(--text-dim);display:flex;flex-wrap:wrap;gap:4px 10px}
.pstats .bad{color:var(--red)}.pstats .warn{color:var(--amber)}.pstats .run{color:var(--accent)}

/* Operations */
.ops-col{position:sticky;top:12px;max-height:calc(100vh - 120px);overflow-y:auto;overscroll-behavior:contain;padding-right:2px}
.ops{display:grid;gap:10px}
.ops .empty{color:var(--text-dim);font-size:13px;margin:0;padding:14px;border:1px dashed var(--border-light);border-radius:var(--radius)}
.panel{--rc:var(--accent);background:var(--card-bg);border:1px solid var(--border);border-top:2px solid var(--rc);border-radius:var(--radius);padding:10px 12px;animation:enter .3s ease-out;min-width:0}
.panel.bad{--rc:var(--red)}.panel.ok{--rc:var(--green)}.panel.warn{--rc:var(--amber)}
@keyframes enter{from{opacity:0;transform:translateY(-8px);clip-path:inset(0 0 100% 0)}to{clip-path:inset(0 0 0 0)}}
.panel-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.panel-head .kind{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--rc)}
.panel-head b{color:var(--text-heading);font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.panel-head time{font-family:var(--mono);font-size:11px;color:var(--text-dim)}
.panel-head .x{background:none;border:0;color:var(--text-dim);cursor:pointer;font-size:15px;line-height:1;padding:0 2px}
.panel-head .x:hover{color:var(--text-heading)}
.panel p{margin:4px 0;font-size:13.5px}
.panel .dim,.dim{color:var(--text-dim)}
.panel a{color:var(--accent)}
.rows{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.rows li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13.5px}
.rows li .grow{flex:1;min-width:120px;overflow-wrap:anywhere}
.rows .sub{display:block;font-size:12px;color:var(--text-dim)}
.t{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;color:var(--text-dim);white-space:nowrap}
.t.bad{color:var(--red)}.t.warn{color:var(--amber)}.t.ok{color:var(--green)}.t.run{color:var(--accent)}
.path{font-family:var(--mono);font-size:12.5px;background:none;border:0;padding:0;color:var(--text);text-align:left;cursor:pointer}
button.path:hover{color:var(--accent);text-decoration:underline}
.plus{color:var(--green)}.minus{color:var(--red)}
.runbars{display:inline-flex;align-items:flex-end;gap:2px;height:18px}
.runbars i{width:4px;min-height:5px;border-radius:1px;background:var(--green);opacity:.85}
.runbars i.bad{background:var(--red)}.runbars i.dim{background:var(--text-dim)}
.diff{margin:6px 0;max-height:380px;overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-family:var(--mono);font-size:12px;line-height:1.5}
.dl{white-space:pre;padding:0 10px;min-width:max-content}
.dl.add{background:var(--green-dim);color:var(--text-heading)}.dl.del{background:var(--red-dim);color:var(--text-heading)}
.dl.hunk{color:var(--accent);background:var(--accent-dim);margin-top:4px}
.approval{border-top:1px solid var(--border);padding-top:8px;margin-top:8px}
.approval:first-child{border-top:0;padding-top:0;margin-top:0}
.approval .body{white-space:pre-wrap;font-size:12.5px;color:var(--text-dim);max-height:110px;overflow:auto;margin:4px 0 6px}
.action{display:flex;gap:8px;align-items:center;font-size:13px;padding:6px 10px;border-radius:var(--radius);background:var(--panel);border:1px solid var(--border)}
.action.bad{border-color:var(--red);color:var(--text-heading)}
.action .mark{color:var(--green)}.action.bad .mark{color:var(--red)}
.action time{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--text-dim)}
.spin{display:inline-block;width:10px;height:10px;border:2px solid var(--amber);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-1px;margin-right:6px}

/* Gauge strip */
.gauges{position:sticky;bottom:10px;z-index:5;margin-top:18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:0 12px 30px 8px var(--bg)}
.g{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:8px 12px 9px;background:var(--panel);border:0;color:var(--text);font:inherit;text-align:left;cursor:pointer;min-width:0}
.g:hover{background:var(--card-hover)}
.g:disabled{cursor:default}.g:disabled:hover{background:var(--panel)}
.g span{font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-dim);white-space:nowrap}
.g b{font-family:var(--mono);font-size:19px;font-weight:600;line-height:1.2;color:var(--text-heading);font-variant-numeric:tabular-nums;white-space:nowrap}
.g.run b{color:var(--accent)}.g.warn b{color:var(--amber)}.g.bad b{color:var(--red)}.g.zero b{color:var(--text-dim)}
.g .meter{position:absolute;left:0;bottom:0;height:2px;background:var(--accent);transition:width .6s}
.g.warn .meter{background:var(--amber)}.g.bad .meter{background:var(--red)}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

@media (max-width:1100px){.deck{grid-template-columns:1fr}.ops-col{position:static;max-height:none;overflow:visible}}
@media (max-width:900px){.nodes{display:none}.systems-wrap{display:block}.stage{height:320px}.watch{inset:88px 12px 12px 12px}}
@media (max-width:600px){.stage{height:280px}.gauges{position:static;grid-template-columns:repeat(4,1fr)}.g{padding:7px 8px}.g b{font-size:16px}.stage-tag.r{display:none}.sub-model{font-size:15px}}
@media (prefers-reduced-motion:reduce){.task.run::after,.step[data-state=running] .ic::before,.spin,.panel{animation:none}.node,.subtitles,.boot,.g .meter{transition:none}}
`;
