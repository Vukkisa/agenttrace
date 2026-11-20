/**
 * Self-contained offline HTML report. No external scripts, fonts or images.
 * Contains only metadata, counts, commands/paths (redacted) — never prompts or tool output
 * unless the user opted into error excerpts.
 */
import type { SessionAnalysis } from '../analytics/analyze.js';
import { formatUsd } from '../analytics/costs/index.js';
import { formatDuration } from '../analytics/timing/index.js';
import type { Finding } from '../analytics/findings.js';
import type { TokenTotals } from '../analytics/tokens/index.js';
import { VERSION } from '../version.js';

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
const n = (v: number) => v.toLocaleString('en-US');
const tm = (d?: Date) => (d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const dt = (d?: Date) => (d ? d.toLocaleString() : 'Not available');

const badge = (basis: string) => `<span class="basis basis-${esc(basis)}">${esc(basis)}</span>`;

function kv(rows: [string, string][]): string {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function tokenRow(label: string, t: TokenTotals, cost: string): string {
  return `<tr><td>${esc(label)}</td><td class="num">${n(t.input)}</td><td class="num">${n(t.output)}</td><td class="num">${n(t.cacheRead)}</td><td class="num">${n(t.cacheWrite)}</td><td class="num">${cost}</td></tr>`;
}

function bar(label: string, value: number, max: number, text: string, cls = ''): string {
  const pct = max > 0 ? Math.max(0.5, (value / max) * 100) : 0;
  return `<div class="bar-row"><span class="bar-label">${esc(label)}</span><span class="bar-track"><span class="bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></span></span><span class="bar-val">${esc(text)}</span></div>`;
}

function timelineSvg(a: SessionAnalysis): string {
  const start = a.timing.start?.getTime(); const end = a.timing.end?.getTime();
  if (start === undefined || end === undefined || end <= start) return '<p class="muted">Not enough timestamps to draw a timeline.</p>';
  const W = 1000; const x = (t: number) => ((t - start) / (end - start)) * W;
  const parts: string[] = [];
  // pauses
  for (const p of a.timing.pauses) parts.push(`<rect class="tl-pause" x="${x(p.from.getTime()).toFixed(1)}" y="0" width="${Math.max(1, x(p.to.getTime()) - x(p.from.getTime())).toFixed(1)}" height="120"><title>Pause ${esc(formatDuration(p.ms))}</title></rect>`);
  // repeated-pattern spans
  for (const f of [...a.findings, ...a.loops]) {
    if (!f.firstAt || !f.lastAt || f.kind === 'repeated-read') continue;
    const x1 = x(f.firstAt.getTime()); const x2 = x(f.lastAt.getTime());
    parts.push(`<rect class="tl-span ${f.kind === 'possible-loop' ? 'loop' : 'fail'}" x="${x1.toFixed(1)}" y="78" width="${Math.max(2, x2 - x1).toFixed(1)}" height="10"><title>${esc(f.title)}: ${esc(f.subject)}</title></rect>`);
  }
  // events
  for (const e of a.timeline) {
    const xx = x(e.t.getTime()).toFixed(1);
    if (e.kind === 'user-prompt') parts.push(`<line class="tl-user" x1="${xx}" x2="${xx}" y1="0" y2="24"><title>User prompt ${esc(tm(e.t))}</title></line>`);
    else if (e.kind === 'assistant-end') parts.push(`<line class="tl-end" x1="${xx}" x2="${xx}" y1="4" y2="20"><title>Assistant turn ended ${esc(tm(e.t))}</title></line>`);
    else if (e.kind === 'interrupt' || e.kind === 'api-error') parts.push(`<circle class="tl-err" cx="${xx}" cy="12" r="4"><title>${esc(e.kind)} ${esc(tm(e.t))}</title></circle>`);
    else if (e.kind === 'compaction') parts.push(`<rect class="tl-compact" x="${xx}" y="2" width="4" height="20"><title>Context compaction ${esc(tm(e.t))}</title></rect>`);
    else if (e.kind === 'tool') {
      const cls = e.status === 'error' ? 'tl-tool-err' : e.status === 'interrupted' ? 'tl-tool-int' : 'tl-tool';
      const y = e.status === 'error' ? 58 : 40;
      parts.push(`<rect class="${cls}" x="${xx}" y="${y}" width="2" height="14"><title>${esc(e.label)} ${esc(e.status)} ${esc(tm(e.t))}</title></rect>`);
    }
  }
  return `<svg class="timeline" viewBox="0 0 ${W} 120" preserveAspectRatio="none" role="img" aria-label="Session activity timeline">
<text class="tl-lab" x="2" y="34">turns</text><text class="tl-lab" x="2" y="52">tools</text><text class="tl-lab" x="2" y="70">failed</text><text class="tl-lab" x="2" y="100">repeated</text>
${parts.join('\n')}</svg>
<div class="tl-axis"><span>${esc(tm(a.timing.start))}</span><span>${esc(tm(a.timing.end))}</span></div>
<div class="legend"><span><i class="lg user"></i>user prompt</span><span><i class="lg tool"></i>tool call</span><span><i class="lg err"></i>failed call / error</span><span><i class="lg fail"></i>repeated failure span</span><span><i class="lg loop"></i>possible loop span</span><span><i class="lg pause"></i>pause</span></div>`;
}

function findingCard(f: Finding): string {
  const ev = f.evidence.map(e => `<tr><td>${esc(tm(e.timestamp))}</td><td>${esc(e.tool)}</td><td class="code">${esc(e.input)}</td><td class="st-${esc(e.status)}">${esc(e.status)}${e.exitCode !== undefined ? ` (exit ${esc(e.exitCode)})` : ''}</td><td>${esc(e.errorClass ?? '')}${e.errorSnippet ? `<div class="snip">${esc(e.errorSnippet)}</div>` : ''}</td></tr>`).join('');
  return `<article class="finding sev-${esc(f.severity)}">
  <header><span class="flabel">${esc(f.label)}</span>${badge(f.basis)}<h3>${esc(f.title)}</h3></header>
  ${kv([
    ['Subject', `<code>${esc(f.subject)}</code>`],
    ['Occurrences', `${esc(f.occurrences)}${f.failures ? ` (${esc(f.failures)} failed)` : ''}`],
    ['Time range', f.firstAt ? `${esc(tm(f.firstAt))} – ${esc(tm(f.lastAt))} (${esc(formatDuration(f.spanMs))})` : 'Not available'],
    ['Tools', esc(f.tools.join(', '))],
    ...(f.eventuallySucceeded !== undefined ? [['Later success', f.eventuallySucceeded ? 'yes' : 'no'] as [string, string]] : []),
    ...(f.modificationsBetween !== undefined ? [['File changes in between', esc(f.modificationsBetween)] as [string, string]] : []),
  ])}
  <p><strong>Why flagged:</strong> ${esc(f.why)}</p>
  <p><strong>Recommendation:</strong> ${esc(f.recommendation)}</p>
  <details><summary>Evidence (${esc(f.evidence.length)} of ${esc(f.occurrences)} events)</summary>
  <table class="ev"><thead><tr><th>Time</th><th>Tool</th><th>Input (redacted)</th><th>Result</th><th>Error class</th></tr></thead><tbody>${ev}</tbody></table></details>
</article>`;
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--accent:#3355cc;--ok:#2f8a4c;--err:#c8382e;--warn:#c27c0e;--loop:#8a4fd0;--pause:#d9d9d4;--code:#f1f1ee}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121214;--card:#1c1c1f;--fg:#ececee;--muted:#9a9aa2;--line:#2e2e33;--accent:#7f9bff;--ok:#5cc27e;--err:#ff6b5f;--warn:#e8a93b;--loop:#b88cff;--pause:#2f2f34;--code:#26262a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}h3{font-size:15px;margin:4px 0 8px}
.sub{color:var(--muted);margin:0 0 20px;word-break:break-all}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.stat{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.stat b{display:block;font-size:20px}.stat span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto}.code,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:8px 0}.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-word}
.basis{font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:1px 8px;margin-left:8px;border:1px solid var(--line);color:var(--muted)}.basis-measured{color:var(--ok);border-color:var(--ok)}.basis-heuristic{color:var(--loop);border-color:var(--loop)}.basis-estimated{color:var(--warn);border-color:var(--warn)}
.finding{border:1px solid var(--line);border-left:4px solid var(--warn);border-radius:8px;padding:12px 14px;margin:0 0 12px}.finding.sev-high{border-left-color:var(--err)}.finding.sev-low{border-left-color:var(--muted)}
.flabel{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--err)}.sev-low .flabel{color:var(--muted)}
.st-error{color:var(--err)}.st-success{color:var(--ok)}.st-interrupted{color:var(--warn)}.snip{color:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
.muted{color:var(--muted)}.note{font-size:12px;color:var(--muted)}ul.diag{padding-left:18px;margin:0}ul.diag li{margin:4px 0}
.bar-row{display:grid;grid-template-columns:minmax(120px,240px) 1fr 110px;gap:10px;align-items:center;margin:4px 0}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track{height:10px;background:var(--code);border-radius:5px;overflow:hidden}.bar-fill{display:block;height:100%;background:var(--accent)}.bar-fill.err{background:var(--err)}.bar-val{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.timeline{width:100%;height:120px;display:block;background:var(--code);border-radius:6px}.tl-lab{font-size:9px;fill:var(--muted)}.tl-user{stroke:var(--accent);stroke-width:2}.tl-end{stroke:var(--muted);stroke-width:1}.tl-err{fill:var(--err)}.tl-compact{fill:var(--warn)}
.tl-tool{fill:var(--ok);opacity:.7}.tl-tool-err{fill:var(--err)}.tl-tool-int{fill:var(--warn)}.tl-pause{fill:var(--pause);opacity:.8}.tl-span.fail{fill:var(--err);opacity:.45}.tl-span.loop{fill:var(--loop);opacity:.55}
.tl-axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:4px}.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:var(--muted);margin-top:8px}.lg{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.lg.user{background:var(--accent)}.lg.tool{background:var(--ok)}.lg.err{background:var(--err)}.lg.fail{background:var(--err);opacity:.45}.lg.loop{background:var(--loop)}.lg.pause{background:var(--pause)}
details summary{cursor:pointer;color:var(--accent)}footer{color:var(--muted);font-size:12px;margin-top:24px}
@media (max-width:600px){.bar-row{grid-template-columns:100px 1fr 80px}}
`;

export function renderSessionHtml(a: SessionAnalysis, opts: { generatedAt?: Date } = {}): string {
  const gen = opts.generatedAt ?? new Date();
  const c = a.cost;
  const costText = c.totalUsd !== undefined ? formatUsd(c.totalUsd) + (c.status === 'partial' ? ' (partial)' : '') : 'Not available';
  const modelRows = Object.entries(a.tokens.byModel).map(([m, t]) => {
    const mc = c.byModel.find(x => x.model === m);
    const ct = mc?.status === 'complete' ? formatUsd(mc.costUsd) : mc?.status === 'unknown-model' ? 'No price (unknown model)' : `Incomplete price: ${mc?.missing?.join(', ')}`;
    return tokenRow(m, t, esc(ct));
  }).join('');
  const maxTool = Math.max(1, ...a.tools.byTool.map(t => t.calls));
  const toolBars = a.tools.byTool.slice(0, 15).map(t => bar(t.tool, t.calls, maxTool, `${t.calls}${t.errors ? ` · ${t.errors} failed` : ''}`)).join('');
  const failBars = a.tools.byTool.filter(t => t.errors).map(t => bar(t.tool, t.errors, Math.max(...a.tools.byTool.map(x => x.errors)), `${t.errors} failed`, 'err')).join('');
  const cats = Object.entries(a.timing.categoriesMs).sort((x, y) => y[1] - x[1]);
  const maxCat = Math.max(1, ...cats.map(([, v]) => v));
  const catBars = cats.map(([k, v]) => bar(k, v, maxCat, formatDuration(v))).join('');
  const toolTimeRows = a.timing.toolTimes.slice(0, 15).map(t => `<tr><td>${esc(t.tool)}</td><td class="num">${t.calls}</td><td class="num">${t.measuredCalls ? esc(formatDuration(t.measuredMs)) + ` <span class="muted">(${t.measuredCalls})</span>` : '—'}</td><td class="num">${t.logIntervalCalls ? esc(formatDuration(t.logIntervalMs)) + ` <span class="muted">(${t.logIntervalCalls})</span>` : '—'}</td></tr>`).join('');
  const failedRows = a.failedCalls.slice(0, 50).map(e => `<tr><td>${esc(tm(e.timestamp))}</td><td>${esc(e.tool)}</td><td class="code">${esc(e.input)}</td><td>${e.exitCode !== undefined ? esc(e.exitCode) : '—'}</td><td>${esc(e.errorClass ?? '')}${e.errorSnippet ? `<div class="snip">${esc(e.errorSnippet)}</div>` : ''}</td></tr>`).join('');
  const failures = a.findings.filter(f => f.kind !== 'repeated-read');
  const reads = a.findings.filter(f => f.kind === 'repeated-read');
  const diagWarnings = a.diagnostics.flatMap(d => [
    ...(d.malformedLines ? [`${d.malformedLines} malformed line(s)`] : []),
    ...Object.entries(d.unknownTypeCounts).map(([k, v]) => `${v}× unsupported record "${k}"`),
    ...d.warnings,
  ]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentTrace Report</title><style>${CSS}</style></head><body><main>
<h1>AgentTrace session report</h1>
<p class="sub">${esc(a.agent)} · ${esc(a.sessionId)}${a.projectDir ? ' · ' + esc(a.projectDir) : ''}</p>

<section><h2>Session overview</h2>
<div class="grid">
<div class="stat"><b>${esc(formatDuration(a.timing.observedMs))}</b><span>Observed duration ${badge('measured')}</span></div>
<div class="stat"><b>${esc(formatDuration(a.timing.activeMs))}</b><span>Excl. pauses &gt; ${esc(formatDuration(a.timing.pauseThresholdMs))}</span></div>
<div class="stat"><b>${esc(costText)}</b><span>API-equivalent cost ${badge('estimated')}</span></div>
<div class="stat"><b>${n(a.tools.total)}</b><span>Tool calls</span></div>
<div class="stat"><b>${n(a.tools.failed)}</b><span>Failed tool calls</span></div>
<div class="stat"><b>${n(a.findings.length + a.loops.length)}</b><span>Findings</span></div>
</div>
${kv([
    ['Agent', esc(a.agent) + (a.cliVersion ? ` <span class="muted">v${esc(a.cliVersion)}</span>` : '')],
    ['Session ID', `<code>${esc(a.sessionId)}</code>`],
    ['Model(s)', esc(a.models.join(', ') || 'Not available')],
    ['Start', esc(dt(a.timing.start))],
    ['End', esc(dt(a.timing.end))],
    ['Git branch', esc(a.gitBranch ?? 'Not available')],
    ['Turns', `${a.counts.userPrompts} user prompt(s), ${a.counts.assistantTurnsEnded} completed assistant turn(s), ${a.counts.interruptions} interruption(s), ${a.counts.apiErrors} API error(s), ${a.counts.compactions} compaction(s)`],
  ])}
</section>

<section><h2>Final diagnosis</h2><ul class="diag">${a.diagnosis.map(d => `<li>${badge(d.basis)} ${esc(d.text)}</li>`).join('')}</ul>
<p class="note">measured = counted directly from log events · estimated = derived from timestamps or prices · heuristic = pattern-based; not proof of agent intent.</p></section>

<section><h2>Token usage</h2>
${a.tokens.available ? `<div class="tablewrap"><table><thead><tr><th>Model</th><th class="num">Input (uncached)</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">API-equiv. cost</th></tr></thead>
<tbody>${modelRows}${Object.keys(a.tokens.byModel).length > 1 ? tokenRow('Total', a.tokens.total, esc(costText)) : ''}</tbody></table></div>
${a.tokens.subagent.records ? `<p class="note">Includes subagent usage: ${n(a.tokens.subagent.input + a.tokens.subagent.output + a.tokens.subagent.cacheRead + a.tokens.subagent.cacheWrite)} tokens.</p>` : ''}
${a.tokens.total.reasoning ? `<p class="note">Reasoning/thinking tokens (already included in output): ${n(a.tokens.total.reasoning)}.</p>` : ''}
<p class="note">Usage derivation: ${esc(a.tokens.sources.join(', '))}. ${a.agent === 'codex' ? 'Codex reports cumulative totals; AgentTrace uses deltas between snapshots to avoid double counting.' : 'Claude Code writes one record per content block; usage is de-duplicated by message ID.'}</p>`
    : '<p>Not available — this log contains no token usage records.</p>'}
</section>

<section><h2>Activity timeline</h2>${timelineSvg(a)}</section>

<section><h2>Failure analysis</h2>
${failures.length ? failures.map(findingCard).join('') : `<p class="muted">No repeated failures met the threshold (${a.config.threshold}).</p>`}
${failBars ? `<h3>Failed calls by tool</h3>${failBars}` : ''}
${failedRows ? `<details><summary>All failed tool calls (${a.failedCalls.length})</summary><div class="tablewrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Input (redacted)</th><th>Exit</th><th>Error class</th></tr></thead><tbody>${failedRows}</tbody></table></div></details>` : ''}
</section>

<section><h2>Possible repetitive behaviour</h2>
${a.loops.length ? a.loops.map(findingCard).join('') : '<p class="muted">No repetitive patterns detected.</p>'}
${reads.length ? `<h3>Repeated operations (may be legitimate)</h3>${reads.map(findingCard).join('')}` : ''}
<p class="note">These are patterns in the logs, not proof that the agent was stuck. Changes made outside the agent's own tools are not visible.</p>
</section>

<section><h2>Cost and time analysis</h2>
<h3>Tool activity</h3>${toolBars || '<p class="muted">No tool calls.</p>'}
<h3>Time breakdown ${badge('estimated')}</h3>${catBars || '<p class="muted">Not enough timestamps.</p>'}
<p class="note">Gaps between consecutive log events are attributed to the activity in progress. Tool time includes approval waits.</p>
<h3>Tool duration</h3><div class="tablewrap"><table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Measured by agent</th><th class="num">Call→result interval</th></tr></thead><tbody>${toolTimeRows}</tbody></table></div>
<h3>Main sources of inefficiency</h3>
${a.waste.repeatedFailureMs || a.waste.callsInRepeatedPatterns ? `<ul class="diag"><li>${badge('estimated')} ${esc(formatDuration(a.waste.repeatedFailureMs))} inside repeated-failure / loop periods (first to last repeated attempt).</li><li>${badge('measured')} ${n(a.waste.callsInRepeatedPatterns)} tool calls belong to repeated patterns.</li>${a.timing.pauses.length ? `<li>${badge('measured')} ${a.timing.pauses.length} long pause(s): ${esc(formatDuration(a.timing.pauses.reduce((s, p) => s + p.ms, 0)))}.</li>` : ''}</ul>` : '<p class="muted">No repeated-failure periods detected.</p>'}
<p class="note">${esc(c.disclaimer)}</p>
${c.byModel.filter(m => m.price).length ? `<details><summary>Pricing used</summary><div class="tablewrap"><table><thead><tr><th>Model</th><th class="num">Input $/M</th><th class="num">Output $/M</th><th class="num">Cache read $/M</th><th class="num">Cache write 5m / 1h $/M</th><th>Source</th><th>Updated</th></tr></thead><tbody>${c.byModel.filter(m => m.price).map(m => `<tr><td>${esc(m.model)}</td><td class="num">${esc(m.price!.inputPerMTok)}</td><td class="num">${esc(m.price!.outputPerMTok)}</td><td class="num">${esc(m.price!.cacheReadPerMTok ?? '—')}</td><td class="num">${esc(m.price!.cacheWrite5mPerMTok ?? '—')} / ${esc(m.price!.cacheWrite1hPerMTok ?? '—')}</td><td>${esc(m.price!.source)}${m.assumptions.length ? `<div class="snip">${esc(m.assumptions.join('; '))}</div>` : ''}</td><td>${esc(m.price!.lastUpdated)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
${c.unknownModels.length ? `<p class="note">No usable price for: ${esc(c.unknownModels.join(', '))}. Add prices with <code>--pricing &lt;file&gt;</code>.</p>` : ''}
</section>

<section><h2>Parser diagnostics</h2>
<p class="note">${a.diagnostics.length} file(s) parsed, ${n(a.diagnostics.reduce((s, d) => s + d.parsedRecords, 0))} records.</p>
${diagWarnings.length ? `<ul class="diag">${diagWarnings.slice(0, 30).map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '<p class="muted">No parser warnings.</p>'}
</section>

<footer>Generated by AgentTrace ${VERSION} on ${esc(gen.toLocaleString())}. Generated locally; no data left this machine. Contains no prompts or tool outputs${a.config.includeErrorSnippets ? ' except redacted first-line error excerpts (--show-errors)' : ''}.</footer>
</main></body></html>
`;
}
