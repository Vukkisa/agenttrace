/**
 * Combine per-area analytics into one SessionAnalysis. Pure function of the parsed session,
 * pricing table and config, so it is reusable by future VS Code / MCP front-ends.
 */
import type { AgentName, NormalizedSession, ParserDiagnostics } from '../types.js';
import type { PricingTable } from '../pricing/index.js';
import { summarizeTokens, type TokenSummary, mergeTotals, emptyTotals, type TokenTotals } from './tokens/index.js';
import { summarizeCost, type CostSummary, formatUsd } from './costs/index.js';
import { analyzeTiming, type TimingSummary, formatDuration } from './timing/index.js';
import { detectFailures } from './failures/index.js';
import { detectLoops } from './loops/index.js';
import { toSummary, summarizeSummaries, type MultiSummary } from './summary.js';
import { DEFAULT_DETECTION, type DetectionConfig, type Finding, evidenceOf, type EvidenceItem } from './findings.js';

export interface ToolStats { tool: string; calls: number; errors: number; interrupted: number; unknown: number }

export interface WasteSummary {
  /** Union of observed spans of failure/loop findings (estimated). */
  repeatedFailureMs: number;
  callsInRepeatedPatterns: number;
  sources: string[];
}

export interface DiagnosisLine { text: string; basis: 'measured' | 'heuristic' | 'estimated' }

export interface SessionAnalysis {
  agent: AgentName;
  sessionId: string;
  projectDir?: string;
  gitBranch?: string;
  cliVersion?: string;
  models: string[];
  files: string[];
  tokens: TokenSummary;
  cost: CostSummary;
  timing: TimingSummary;
  tools: { total: number; failed: number; interrupted: number; byTool: ToolStats[] };
  failedCalls: EvidenceItem[];
  findings: Finding[];
  loops: Finding[];
  waste: WasteSummary;
  diagnosis: DiagnosisLine[];
  counts: { userPrompts: number; assistantTurnsEnded: number; interruptions: number; apiErrors: number; compactions: number; subagentToolCalls: number };
  /** Lightweight timeline points (no content). */
  timeline: { t: Date; kind: string; label: string; status?: string }[];
  diagnostics: ParserDiagnostics[];
  config: DetectionConfig;
}

function unionMs(intervals: [number, number][]): number {
  const s = intervals.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0; let cur: [number, number] | undefined;
  for (const iv of s) {
    if (!cur || iv[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [...iv] as [number, number]; }
    else cur[1] = Math.max(cur[1], iv[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function diagnose(a: Omit<SessionAnalysis, 'diagnosis'>): DiagnosisLine[] {
  const out: DiagnosisLine[] = [];
  const { tools, findings, loops, cost, timing, tokens } = a;
  if (tools.total === 0 && !tokens.available) {
    out.push({ text: 'No tool calls or token usage were found in this session log.', basis: 'measured' });
    return out;
  }
  out.push({
    text: `${tools.total} tool call(s) recorded; ${tools.failed} returned an error` + (tools.interrupted ? ` and ${tools.interrupted} were interrupted.` : '.'),
    basis: 'measured',
  });
  const all = [...findings, ...loops].sort((x, y) => (y.spanMs ?? 0) - (x.spanMs ?? 0));
  const seen = new Set<string>();
  for (const f of all) {
    if (f.kind === 'repeated-read' || seen.has(f.subject)) continue;
    seen.add(f.subject);
    const span = f.spanMs !== undefined ? `, spanning about ${formatDuration(f.spanMs)} from first to last attempt` : '';
    if (f.kind === 'possible-loop') {
      out.push({ text: `Possible repetitive behaviour: ${f.title.toLowerCase()} (${f.subject})${span}.`, basis: 'heuristic' });
    } else if (f.kind === 'repeated-failed-test' || f.kind === 'repeated-failed-command') {
      const what = f.kind === 'repeated-failed-test' ? 'test command' : 'command';
      const after = f.eventuallySucceeded ? ' It later succeeded.' : ' No later successful run was recorded.';
      out.push({ text: `${f.failures} failed runs of the same ${what} were detected (${f.subject})${span}.${after}`, basis: 'measured' });
    } else {
      out.push({ text: `${f.title} (${f.occurrences}×)${span}.`, basis: f.basis });
    }
    if (out.length >= 6) break;
  }
  const reads = findings.filter(f => f.kind === 'repeated-read');
  if (reads.length) out.push({ text: `${reads.length} file(s) were read ${a.config.threshold}+ times with no recorded change in between (may be legitimate).`, basis: 'heuristic' });
  if (a.waste.repeatedFailureMs > 0) {
    out.push({ text: `About ${formatDuration(a.waste.repeatedFailureMs)} of the session falls inside repeated-failure periods (back-to-back repeated attempts, gaps ≤ ${formatDuration(a.config.similarErrorWindowMs)}).`, basis: 'estimated' });
  }
  if (cost.totalUsd !== undefined) {
    out.push({ text: `Estimated API-equivalent cost: ${formatUsd(cost.totalUsd)}${cost.status === 'partial' ? ' (partial: some models have no price)' : ''}.`, basis: 'estimated' });
  } else if (tokens.available) {
    out.push({ text: 'API-equivalent cost not available: no price is configured for the model(s) used.', basis: 'measured' });
  }
  if (timing.pauses.length) {
    const total = timing.pauses.reduce((s, p) => s + p.ms, 0);
    out.push({ text: `${timing.pauses.length} pause(s) longer than ${formatDuration(timing.pauseThresholdMs)} totalling ${formatDuration(total)}.`, basis: 'measured' });
  }
  if (findings.length === 0 && loops.length === 0) out.push({ text: `No repeated failures or repetitive patterns met the threshold (${a.config.threshold}).`, basis: 'measured' });
  return out;
}

export function analyzeSession(s: NormalizedSession, pricing: PricingTable, cfg: Partial<DetectionConfig> & { pauseThresholdMs?: number } = {}): SessionAnalysis {
  const config: DetectionConfig = { ...DEFAULT_DETECTION, ...cfg };
  const tokens = summarizeTokens(s.usage);
  const cost = summarizeCost(tokens, pricing);
  const timing = analyzeTiming(s, cfg.pauseThresholdMs);
  const findings = detectFailures(s, config);
  const loops = detectLoops(s, config);

  const byToolMap = new Map<string, ToolStats>();
  for (const c of s.toolCalls) {
    const st = byToolMap.get(c.name) ?? { tool: c.name, calls: 0, errors: 0, interrupted: 0, unknown: 0 };
    st.calls++;
    if (c.status === 'error') st.errors++;
    if (c.status === 'interrupted') st.interrupted++;
    if (c.status === 'unknown') st.unknown++;
    byToolMap.set(c.name, st);
  }
  const byTool = [...byToolMap.values()].sort((a, b) => b.calls - a.calls);
  const failed = s.toolCalls.filter(c => c.status === 'error');

  const intervals: [number, number][] = [...findings, ...loops]
    .filter(f => f.kind !== 'repeated-read' && f.kind !== 'similar-errors')
    .flatMap(f => f.repeatPeriods ?? []);
  const waste: WasteSummary = {
    repeatedFailureMs: unionMs(intervals),
    callsInRepeatedPatterns: [...findings, ...loops].filter(f => f.kind !== 'repeated-read').reduce((n, f) => n + f.occurrences, 0),
    sources: [...new Set([...findings, ...loops].map(f => f.kind))],
  };

  const timeline: SessionAnalysis['timeline'] = [];
  for (const b of s.boundaries) timeline.push({ t: b.timestamp, kind: b.kind, label: b.kind });
  for (const c of s.toolCalls) if (c.timestamp && !c.subagent) timeline.push({ t: c.timestamp, kind: 'tool', label: c.name, status: c.status });
  timeline.sort((a, b) => a.t.getTime() - b.t.getTime());

  const base: Omit<SessionAnalysis, 'diagnosis'> = {
    agent: s.agent, sessionId: s.sessionId, projectDir: s.projectDir, gitBranch: s.gitBranch, cliVersion: s.cliVersion,
    models: s.models, files: s.files, tokens, cost, timing,
    tools: { total: s.toolCalls.length, failed: failed.length, interrupted: s.toolCalls.filter(c => c.status === 'interrupted').length, byTool },
    failedCalls: failed.slice(0, 200).map(c => evidenceOf(c, config)),
    findings, loops, waste,
    counts: {
      userPrompts: s.boundaries.filter(b => b.kind === 'user-prompt').length,
      assistantTurnsEnded: s.boundaries.filter(b => b.kind === 'assistant-end').length,
      interruptions: s.interruptions, apiErrors: s.apiErrors,
      compactions: s.boundaries.filter(b => b.kind === 'compaction').length,
      subagentToolCalls: s.toolCalls.filter(c => c.subagent).length,
    },
    timeline, diagnostics: s.diagnostics, config,
  };
  return { ...base, diagnosis: diagnose(base) };
}

export type { MultiSummary } from './summary.js';

/** Aggregate full analyses. Thin wrapper over summarizeSummaries (kept for API compatibility). */
export function summarizeMany(analyses: SessionAnalysis[], pricing: PricingTable): MultiSummary {
  return summarizeSummaries(analyses.map(a => toSummary(a)), pricing);
}
