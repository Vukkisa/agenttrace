/**
 * Compact per-session summary used by multi-session views and the cache.
 * Contains counts, token totals and timing only: no commands, paths from tool input,
 * prompts, tool output or other transcript content.
 */
import type { AgentName } from '../types.js';
import type { PricingTable } from '../pricing/index.js';
import { emptyTotals, mergeTotals, type TokenSummary, type TokenTotals } from './tokens/index.js';
import { summarizeCost, type CostSummary } from './costs/index.js';
import type { SessionAnalysis } from './analyze.js';

export interface SessionSummary {
  agent: AgentName;
  sessionId: string;
  projectDir?: string;
  start?: Date;
  observedMs?: number;
  models: string[];
  tokens: { available: boolean; total: TokenTotals; byModel: Record<string, TokenTotals>; byDay: Record<string, TokenTotals> };
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
    tokens: { available: a.tokens.available, total: a.tokens.total, byModel: a.tokens.byModel, byDay: a.tokens.byDay },
    toolCalls: a.tools.total, failed: a.tools.failed, files: a.files.length,
    detection: { key: detectionKey, findings: a.findings.length, loops: a.loops.length },
  };
}

function tokenSummary(t: SessionSummary['tokens']): TokenSummary {
  return { available: t.available, total: t.total, byModel: t.byModel, byDay: t.byDay, subagent: emptyTotals(), sources: [] };
}

export interface MultiSummary {
  sessions: { agent: AgentName; sessionId: string; start?: Date; durationMs?: number; models: string[]; tokens: TokenTotals; costUsd?: number; costStatus: string; toolCalls: number; failed: number; findings: number; loops: number }[];
  total: TokenTotals;
  byModel: Record<string, TokenTotals>;
  byDay: Record<string, TokenTotals>;
  cost: CostSummary;
}

/** Aggregate summaries. Cost is always recomputed from token counts with the current pricing table. */
export function summarizeSummaries(items: SessionSummary[], pricing: PricingTable): MultiSummary {
  let total = emptyTotals();
  const byModel: Record<string, TokenTotals> = {};
  const byDay: Record<string, TokenTotals> = {};
  for (const a of items) {
    total = mergeTotals(total, a.tokens.total);
    for (const [m, t] of Object.entries(a.tokens.byModel)) byModel[m] = mergeTotals(byModel[m] ?? emptyTotals(), t);
    for (const [d, t] of Object.entries(a.tokens.byDay)) byDay[d] = mergeTotals(byDay[d] ?? emptyTotals(), t);
  }
  const all: TokenSummary = { available: items.some(a => a.tokens.available), total, byModel, byDay, subagent: emptyTotals(), sources: [] };
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
  };
}
