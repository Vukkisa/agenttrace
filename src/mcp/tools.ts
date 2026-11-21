/**
 * The four read-only MCP tools, written as plain functions over the existing analysis engine.
 * They read local session logs and the summary cache (the only thing ever written) and return
 * values built by ./sanitize.ts. No network access, no report generation, no source-file writes.
 */
import { discover, findSession, loadSession, type DiscoveryOptions } from '../discovery/index.js';
import { analyzeSession } from '../analytics/analyze.js';
import { summarizeSummaries, type SessionSummary } from '../analytics/summary.js';
import { collectSummaries } from '../cache/collect.js';
import { SummaryCache } from '../cache/index.js';
import { loadPricing, type PricingTable } from '../pricing/index.js';
import type { AgentName, SessionRef } from '../types.js';
import {
  COST_LABEL, LIMITS, ToolInputError, analysisOut, assertNoPaths, costOut, duration, findingOut, projectName, rankFindings, round2, safeLogMessage, tokensOut,
} from './sanitize.js';

export interface McpContext {
  discovery: DiscoveryOptions;
  pricingFile?: string;
  cacheEnabled: boolean;
  /** Diagnostics sink. Must write to stderr only. */
  log: (msg: string) => void;
}

const DETECTION = { threshold: 3, includeErrorSnippets: false, pauseThresholdMs: 5 * 60_000 } as const;
const pricingOf = (ctx: McpContext): PricingTable => loadPricing({ pricingFile: ctx.pricingFile });

function refsFor(ctx: McpContext, agent?: AgentName): SessionRef[] {
  return discover({ ...ctx.discovery, agents: agent ? [agent] : ctx.discovery.agents }).sessions;
}

async function summariesFor(ctx: McpContext, refs: SessionRef[]): Promise<SessionSummary[]> {
  const cache = SummaryCache.open({ enabled: ctx.cacheEnabled });
  if (cache.note) ctx.log(cache.note);
  return collectSummaries(refs, { cache, detection: DETECTION, requireDetection: false, pricing: () => pricingOf(ctx), warn: m => ctx.log(safeLogMessage(m)) });
}

function resolveRef(ctx: McpContext, a: { session?: string; latest?: boolean }): SessionRef {
  const session = a.session?.trim();
  if (session && a.latest) throw new ToolInputError('Provide either "session" or "latest", not both.');
  if (!session && !a.latest) throw new ToolInputError('Provide "session" (an id or unique prefix from list_sessions) or set "latest" to true.');
  const sessions = refsFor(ctx);
  if (!sessions.length) throw new ToolInputError('No Claude Code or Codex sessions were found on this machine.');
  if (a.latest) return sessions[0];
  return findSession(sessions, session!);
}

/** findSession throws plain Errors whose text contains no paths: convert them to safe tool errors. */
function resolveSafe(ctx: McpContext, a: { session?: string; latest?: boolean }): SessionRef {
  try { return resolveRef(ctx, a); } catch (e) {
    if (e instanceof ToolInputError) throw e;
    const m = (e as Error).message;
    if (/^No session matches|is ambiguous/.test(m)) throw new ToolInputError(m.replace(/ Run "agenttrace sessions" to list IDs\./, ' Use list_sessions to see ids.'));
    throw e;
  }
}

// ---- list_sessions -------------------------------------------------------------------------

export interface ListSessionsArgs { agent?: AgentName; limit?: number; project?: string }

export async function listSessions(ctx: McpContext, a: ListSessionsArgs) {
  const limit = Math.min(Math.max(Math.trunc(a.limit ?? LIMITS.sessionsDefault), 1), LIMITS.sessionsMax);
  const all = refsFor(ctx, a.agent);
  const needle = a.project?.trim().toLowerCase();
  // A project filter needs every session's project name (cached after the first run).
  const summaries = await summariesFor(ctx, needle ? all : all.slice(0, limit));
  const matched = needle ? summaries.filter(s => (projectName(s.projectDir) ?? '').toLowerCase().includes(needle)) : summaries;
  const shown = matched.slice(0, limit);
  const rows = summarizeSummaries(shown, pricingOf(ctx)).sessions;
  const out = {
    total: needle ? matched.length : all.length,
    shown: rows.length,
    sessions: rows.map((r, i) => ({
      agent: r.agent,
      id: r.sessionId,
      project: projectName(shown[i].projectDir),
      start: r.start ? r.start.toISOString() : undefined,
      duration: duration(r.durationMs, 'measured'),
      models: r.models,
      toolCalls: r.toolCalls,
      failedCalls: r.failed,
      findings: r.findings + r.loops,
      estimatedApiEquivalentUsd: r.costUsd === undefined ? null : round2(r.costUsd),
      costStatus: r.costStatus,
    })),
    notes: [COST_LABEL, 'Sessions are ordered by most recently modified. "findings" counts detections with default settings (threshold 3).'],
  };
  assertNoPaths(out);
  return out;
}

// ---- analyze_session -----------------------------------------------------------------------

export interface SessionArgs { session?: string; latest?: boolean }

export async function analyzeOne(ctx: McpContext, a: SessionArgs) {
  const ref = resolveSafe(ctx, a);
  const analysis = analyzeSession(await loadSession(ref), pricingOf(ctx), DETECTION);
  return analysis;
}

export async function analyzeSessionTool(ctx: McpContext, a: SessionArgs) {
  const out = analysisOut(await analyzeOne(ctx, a));
  assertNoPaths(out);
  return out;
}

// ---- get_failures --------------------------------------------------------------------------

export interface GetFailuresArgs extends SessionArgs { kind?: string; include_commands?: boolean; max_findings?: number }

export async function getFailures(ctx: McpContext, a: GetFailuresArgs) {
  const analysis = await analyzeOne(ctx, a);
  const includeCommands = a.include_commands === true;
  let all = rankFindings([...analysis.findings, ...analysis.loops]);
  if (a.kind) all = all.filter(f => f.kind === a.kind);
  const max = Math.min(Math.max(Math.trunc(a.max_findings ?? LIMITS.findings), 1), LIMITS.findings);
  const items = all.slice(0, max).map(f => findingOut(f, { includeCommands, withEvidence: true }));
  const out = {
    session: { agent: analysis.agent, id: analysis.sessionId, project: projectName(analysis.projectDir) },
    toolCalls: { total: analysis.tools.total, failed: analysis.tools.failed, interrupted: analysis.tools.interrupted },
    findings: { total: all.length, shown: items.length, items },
    commandsIncluded: includeCommands,
    notes: [
      includeCommands
        ? 'Command text is included because include_commands was set. It is redacted for secrets, paths are shortened and each is truncated.'
        : 'Command text is omitted by default. Set include_commands to true to see redacted, truncated command text.',
      `At most ${LIMITS.findings} findings and ${LIMITS.evidence} evidence items per finding are returned (evidence samples the first and last occurrences).`,
      'Findings are pattern-based. "basis" says whether a finding is measured from log events or heuristic. Times are observed spans and include any waiting.',
    ],
  };
  assertNoPaths(out);
  return out;
}

// ---- cost_summary --------------------------------------------------------------------------

export interface CostSummaryArgs { agent?: AgentName; since?: string; group_by?: 'model' | 'day' | 'session'; limit?: number }

export async function costSummary(ctx: McpContext, a: CostSummaryArgs) {
  let since: number | undefined;
  if (a.since !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.since) || Number.isNaN(Date.parse(a.since + 'T00:00:00Z'))) throw new ToolInputError('"since" must be a date in YYYY-MM-DD format.');
    since = Date.parse(a.since + 'T00:00:00Z');
  }
  const groupBy = a.group_by ?? 'model';
  const limit = Math.min(Math.max(Math.trunc(a.limit ?? 20), 1), LIMITS.groups);
  const table = pricingOf(ctx);
  const summaries = (await summariesFor(ctx, refsFor(ctx, a.agent)))
    .filter(s => since === undefined || (s.start !== undefined && s.start.getTime() >= since));
  const m = summarizeSummaries(summaries, table);

  const base = {
    sessions: summaries.length,
    since: a.since,
    groupBy,
    tokens: tokensOut(m.total),
    cost: costOut(m.cost),
    notes: [COST_LABEL, 'Filter "since" keeps sessions whose first event is on or after that UTC date; a session is counted whole.'],
  };
  let out: Record<string, unknown>;
  if (groupBy === 'model') {
    const rows = m.cost.byModel.map(c => ({
      model: c.model, status: c.status,
      estimatedApiEquivalentUsd: c.costUsd === undefined ? null : round2(c.costUsd),
      tokens: tokensOut(m.byModel[c.model] ?? m.total),
    })).sort((x, y) => (y.estimatedApiEquivalentUsd ?? -1) - (x.estimatedApiEquivalentUsd ?? -1));
    out = { ...base, groups: rows.slice(0, limit), groupsTotal: rows.length };
  } else if (groupBy === 'day') {
    const rows = Object.entries(m.byDay).sort(([x], [y]) => (x < y ? 1 : -1)).map(([day, t]) => ({ day, tokens: tokensOut(t) }));
    out = {
      ...base, groups: rows.slice(0, limit), groupsTotal: rows.length,
      notes: [...base.notes, 'Per-day cost is not reported: daily token totals are not split by model, so a per-day price cannot be computed accurately. Use group_by "model" or "session" for cost.'],
    };
  } else {
    const rows = m.sessions.map(r => ({
      agent: r.agent, id: r.sessionId, start: r.start ? r.start.toISOString() : undefined,
      estimatedApiEquivalentUsd: r.costUsd === undefined ? null : round2(r.costUsd), costStatus: r.costStatus, tokens: tokensOut(r.tokens),
    })).sort((x, y) => (y.estimatedApiEquivalentUsd ?? -1) - (x.estimatedApiEquivalentUsd ?? -1));
    out = { ...base, groups: rows.slice(0, limit), groupsTotal: rows.length };
  }
  assertNoPaths(out);
  return out;
}
