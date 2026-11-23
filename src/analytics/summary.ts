/**
 * Compact per-session summary used by multi-session views and the cache.
 * Contains counts, token totals and timing only: no commands, paths from tool input,
 * prompts, tool output or other transcript content.
 */
import type { AgentName } from '../types.js';
import type { PricingTable } from '../pricing/index.js';
import { addRecord, emptyTotals, ledgerRowToRecord, mergeTotals, type LedgerRow, type TokenSummary, type TokenTotals } from './tokens/index.js';
import { summarizeCost, type CostSummary } from './costs/index.js';
import type { SessionAnalysis } from './analyze.js';

export interface SessionSummary {
  agent: AgentName;
  sessionId: string;
  projectDir?: string;
  start?: Date;
  observedMs?: number;
  models: string[];
  tokens: { available: boolean; total: TokenTotals; byModel: Record<string, TokenTotals>; byDay: Record<string, TokenTotals>; longByModel?: Record<string, TokenTotals>; ledger?: LedgerRow[] };
  toolCalls: number;
  failed: number;
  /** Number of log files (main + subagents). */
  files: number;
  /** Detection results; only valid for the detection settings that produced them. */
  detection: { key: string; findings: number; loops: number };
}

export function toSummary(a: SessionAnalysis, detectionKey = ''): SessionSummary {
  return {
    agent: a.agent, sessionId: a.sessionId, projectDir: a.projectDir, start: a.timing.start, observedMs: a.timing.observedMs,
    models: a.models,
    tokens: { available: a.tokens.available, total: a.tokens.total, byModel: a.tokens.byModel, byDay: a.tokens.byDay, longByModel: a.tokens.longByModel, ledger: a.tokens.ledger },
    toolCalls: a.tools.total, failed: a.tools.failed, files: a.files.length,
    detection: { key: detectionKey, findings: a.findings.length, loops: a.loops.length },
  };
}

function tokenSummary(t: SessionSummary['tokens']): TokenSummary {
  return { available: t.available, total: t.total, byModel: t.byModel, byDay: t.byDay, longByModel: t.longByModel, subagent: emptyTotals(), sources: [] };
}

export interface MultiSummary {
  sessions: { agent: AgentName; sessionId: string; start?: Date; durationMs?: number; models: string[]; tokens: TokenTotals; costUsd?: number; costStatus: string; toolCalls: number; failed: number; findings: number; loops: number }[];
  total: TokenTotals;
  byModel: Record<string, TokenTotals>;
  byDay: Record<string, TokenTotals>;
  cost: CostSummary;
  /** Messages that appeared in more than one session and were counted once in the totals above. */
  duplicates: { messages: number; sessions: number };
}

function subtractTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const o = emptyTotals();
  for (const k of Object.keys(o) as (keyof TokenTotals)[]) o[k] = Math.max(0, a[k] - b[k]);
  return o;
}

/** Aggregate summaries. Cost is always recomputed from token counts with the current pricing table. */
export function summarizeSummaries(items: SessionSummary[], pricing: PricingTable): MultiSummary {
  let total = emptyTotals();
  const byModel: Record<string, TokenTotals> = {};
  const byDay: Record<string, TokenTotals> = {};
  const longByModel: Record<string, TokenTotals> = {};
  for (const a of items) {
    total = mergeTotals(total, a.tokens.total);
    for (const [m, t] of Object.entries(a.tokens.byModel)) byModel[m] = mergeTotals(byModel[m] ?? emptyTotals(), t);
    for (const [m, t] of Object.entries(a.tokens.longByModel ?? {})) longByModel[m] = mergeTotals(longByModel[m] ?? emptyTotals(), t);
    for (const [d, t] of Object.entries(a.tokens.byDay)) byDay[d] = mergeTotals(byDay[d] ?? emptyTotals(), t);
  }
  // A message can appear in several sessions (forks and resumes). The earliest session keeps it;
  // later copies are removed from the combined totals. Per-session numbers are not changed.
  const seen = new Set<string>();
  const dupSessions = new Set<string>();
  let dupMessages = 0;
  let dupTotal = emptyTotals();
  const dupByModel: Record<string, TokenTotals> = {};
  const dupByDay: Record<string, TokenTotals> = {};
  const dupLong: Record<string, TokenTotals> = {};
  const ordered = items.map((a, i) => ({ a, i })).sort((x, y) => (x.a.start?.getTime() ?? Infinity) - (y.a.start?.getTime() ?? Infinity) || x.i - y.i);
  for (const { a } of ordered) {
    for (const row of a.tokens.ledger ?? []) {
      const key = `${a.agent}:${row[0]}`;
      if (!seen.has(key)) { seen.add(key); continue; }
      const rec = ledgerRowToRecord(row);
      dupMessages++;
      dupSessions.add(a.sessionId);
      addRecord(dupTotal, rec);
      addRecord((dupByModel[row[1]] ??= emptyTotals()), rec);
      addRecord((dupByDay[row[2]] ??= emptyTotals()), rec);
      if (row[10]) addRecord((dupLong[row[1]] ??= emptyTotals()), rec);
    }
  }
  if (dupMessages) {
    total = subtractTotals(total, dupTotal);
    for (const [m, t] of Object.entries(dupByModel)) byModel[m] = subtractTotals(byModel[m] ?? emptyTotals(), t);
    for (const [d, t] of Object.entries(dupByDay)) byDay[d] = subtractTotals(byDay[d] ?? emptyTotals(), t);
    for (const [m, t] of Object.entries(dupLong)) longByModel[m] = subtractTotals(longByModel[m] ?? emptyTotals(), t);
  }
  const all: TokenSummary = { available: items.some(a => a.tokens.available), total, byModel, byDay, longByModel, subagent: emptyTotals(), sources: [] };
  return {
    sessions: items.map(a => {
      const c = summarizeCost(tokenSummary(a.tokens), pricing);
      return {
        agent: a.agent, sessionId: a.sessionId, start: a.start, durationMs: a.observedMs, models: a.models,
        tokens: a.tokens.total, costUsd: c.totalUsd, costStatus: c.status, toolCalls: a.toolCalls,
        failed: a.failed, findings: a.detection.findings, loops: a.detection.loops,
      };
    }),
    total, byModel, byDay, cost: summarizeCost(all, pricing),
    duplicates: { messages: dupMessages, sessions: dupSessions.size },
  };
}
