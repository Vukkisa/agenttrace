/** Plain-text terminal rendering of analyses. No conversation content is printed. */
import type { SessionAnalysis, MultiSummary } from '../analytics/analyze.js';
import { formatUsd } from '../analytics/costs/index.js';
import { formatDuration } from '../analytics/timing/index.js';
import type { Finding } from '../analytics/findings.js';
import type { TokenTotals } from '../analytics/tokens/index.js';

const fmt = (n: number) => n.toLocaleString('en-US');
const time = (d?: Date) => (d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?');
const dt = (d?: Date) => (d ? d.toLocaleString() : 'Not available');

export function tokensLine(t: TokenTotals): string {
  return `in ${fmt(t.input)} · out ${fmt(t.output)} · cache read ${fmt(t.cacheRead)} · cache write ${fmt(t.cacheWrite)}`;
}

function findingBlock(f: Finding): string[] {
  const L: string[] = [];
  L.push(`  ${f.label.toUpperCase()}  [${f.basis}]  ${f.title}`);
  L.push(`    Subject:     ${f.subject}`);
  L.push(`    Occurrences: ${f.occurrences}${f.failures ? ` (${f.failures} failed)` : ''}`);
  if (f.firstAt) L.push(`    Time range:  ${time(f.firstAt)}–${time(f.lastAt)} (${formatDuration(f.spanMs)})`);
  if (f.eventuallySucceeded !== undefined) L.push(`    Later success: ${f.eventuallySucceeded ? 'yes' : 'no'}`);
  L.push(`    Why flagged: ${f.why}`);
  L.push(`    Recommendation: ${f.recommendation}`);
  for (const e of f.evidence.slice(0, 5)) {
    L.push(`      - ${time(e.timestamp)} ${e.tool} ${e.status}${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ''}${e.errorClass ? ` [${e.errorClass}]` : ''}${e.errorSnippet ? ` — ${e.errorSnippet}` : ''}`);
  }
  return L;
}

export function renderSessionText(a: SessionAnalysis): string {
  const L: string[] = [];
  L.push(`AgentTrace — ${a.agent} session ${a.sessionId}`);
  L.push('='.repeat(60));
  L.push(`Project:    ${a.projectDir ?? 'Not available'}${a.gitBranch ? ` (branch ${a.gitBranch})` : ''}`);
  L.push(`Models:     ${a.models.join(', ') || 'Not available'}`);
  L.push(`Start:      ${dt(a.timing.start)}`);
  L.push(`End:        ${dt(a.timing.end)}`);
  L.push(`Duration:   ${formatDuration(a.timing.observedMs)} observed, ${formatDuration(a.timing.activeMs)} excluding pauses > ${formatDuration(a.timing.pauseThresholdMs)}`);
  L.push(`Cost:       ${formatUsd(a.cost.totalUsd)} API-equivalent (${a.cost.status})`);
  const replayed = a.diagnostics.reduce((n, d) => n + (d.replayedRecords ?? 0), 0);
  if (replayed) {
    const from = [...new Set(a.diagnostics.flatMap(d => d.replayedFrom ?? []))].map(id => id.slice(0, 8));
    L.push(`Note:       Resumed session. ${fmt(replayed)} copied history record(s) were excluded and count in the original session${from.length ? ` (${from.join(', ')})` : ''}.`);
    if (!a.tokens.available) L.push('            This session has no usage of its own; look at the original session for tokens and cost.');
  }
  L.push('');
  L.push('TOKENS' + (a.tokens.available ? '' : ': Not available in this log'));
  if (a.tokens.available) {
    L.push(`  Total: ${tokensLine(a.tokens.total)}`);
    for (const [m, t] of Object.entries(a.tokens.byModel)) {
      const c = a.cost.byModel.find(x => x.model === m);
      L.push(`  ${m}: ${tokensLine(t)} → ${c?.status === 'complete' ? formatUsd(c.costUsd) : c?.status === 'unknown-model' ? 'no price (unknown model)' : `incomplete price (${c?.missing?.join(', ')})`}`);
    }
    if (a.tokens.subagent.records) L.push(`  Of which subagents: ${tokensLine(a.tokens.subagent)}`);
  }
  L.push('');
  L.push(`TOOLS: ${a.tools.total} calls, ${a.tools.failed} failed, ${a.tools.interrupted} interrupted`);
  for (const t of a.tools.byTool.slice(0, 12)) L.push(`  ${t.tool.padEnd(28)} ${String(t.calls).padStart(5)} ${t.calls === 1 ? 'call ' : 'calls'}  ${t.errors ? t.errors + ' failed' : ''}`);
  if (a.tools.failuresByType.length) L.push(`  Failures by type: ${a.tools.failuresByType.map(f => `${f.type} ${f.count}`).join(' · ')}`);
  L.push('');
  L.push('FINDINGS');
  if (!a.findings.length && !a.loops.length) L.push(`  None met the threshold (${a.config.threshold}).`);
  for (const f of [...a.findings, ...a.loops]) { L.push(...findingBlock(f)); L.push(''); }
  L.push('DIAGNOSIS');
  for (const d of a.diagnosis) L.push(`  • [${d.basis}] ${d.text}`);
  L.push('');
  L.push(a.cost.disclaimer);
  return L.join('\n');
}

export function renderMultiText(m: MultiSummary): string {
  const L: string[] = [];
  L.push(`AgentTrace — ${m.sessions.length} session(s)`);
  L.push('='.repeat(60));
  L.push(`Tokens: ${tokensLine(m.total)}`);
  L.push(`API-equivalent cost: ${formatUsd(m.cost.totalUsd)} (${m.cost.status})`);
  if (m.duplicates.messages) L.push(`Note: ${fmt(m.duplicates.messages)} message(s) appear in more than one session (forked or resumed) and are counted once in these totals; per-session rows below still show each session's own numbers.`);
  if (m.cost.unknownModels.length) L.push(`Models without pricing: ${m.cost.unknownModels.join(', ')}`);
  L.push('');
  L.push('BY MODEL');
  for (const [k, t] of Object.entries(m.byModel)) {
    const c = m.cost.byModel.find(x => x.model === k);
    L.push(`  ${k}: ${tokensLine(t)} → ${c?.status === 'complete' ? formatUsd(c.costUsd) : 'no price'}`);
  }
  L.push('');
  L.push('BY DAY');
  for (const [k, t] of Object.entries(m.byDay).sort()) L.push(`  ${k}: ${tokensLine(t)}`);
  L.push('');
  L.push('SESSIONS');
  for (const s of m.sessions) {
    L.push(`  ${s.agent.padEnd(11)} ${s.sessionId.slice(0, 8)}  ${s.start ? s.start.toLocaleString() : '?'}  ${formatDuration(s.durationMs).padEnd(8)} ${formatUsd(s.costUsd).padStart(8)}  ${s.toolCalls} calls, ${s.failed} failed, ${s.findings + s.loops} findings`);
  }
  return L.join('\n');
}
