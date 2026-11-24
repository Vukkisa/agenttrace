/**
 * Central output allowlist for the MCP server.
 *
 * Every value that leaves the MCP server is built here, field by field, from the analysis
 * results. Nothing is passed through wholesale: prompts, assistant text, tool output, file
 * lists, absolute paths, error excerpts and improvement recommendations have no builder, so
 * they cannot be returned. Command text (tool input) is returned only on explicit opt-in
 * (`include_commands`) and is then redacted and path-scrubbed.
 */
import os from 'node:os';
import path from 'node:path';
import type { SessionAnalysis } from '../analytics/analyze.js';
import type { EvidenceItem, Finding } from '../analytics/findings.js';
import type { TokenTotals } from '../analytics/tokens/index.js';
import type { CostSummary } from '../analytics/costs/index.js';
import { COST_DISCLAIMER } from '../analytics/costs/index.js';
import { redact, truncate } from '../privacy/redact.js';

export const LIMITS = {
  findings: 20,
  evidence: 8,
  sessionsDefault: 20,
  sessionsMax: 100,
  groups: 50,
  commandChars: 140,
};

export const COST_LABEL = 'Estimated API-equivalent cost at public list prices. Not an actual bill; subscriptions are not billed per token.';

export type TimeKind = 'measured' | 'estimated';
export interface Duration { ms: number; kind: TimeKind }

/** A duration is always returned with its basis. */
export function duration(ms: number | undefined, kind: TimeKind): Duration | null {
  return ms === undefined || !Number.isFinite(ms) ? null : { ms: Math.round(ms), kind };
}

/** An error whose message is safe to show to the model (no paths, no content). */
export class ToolInputError extends Error {}

// Absolute POSIX or Windows paths embedded in free text.
const ABS_PATH = /(?:[A-Za-z]:[\\/]|(?<![\w.~-])\/)(?:[^\s'"`<>|,;()[\]{}]+[\\/])+[^\s'"`<>|,;()[\]{}]*/g;

/** Replace absolute paths with `<path>/basename`; replace the home directory with `~`. */
export function scrubPaths(text: string): string {
  let out = text;
  const home = os.homedir();
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.replace(ABS_PATH, m => {
    const base = path.basename(m.replace(/[\\/]+$/, ''));
    return base ? `<path>/${base}` : '<path>';
  });
}

/** Message to return for any thrown error. Only ToolInputError text is passed through (scrubbed). */
export function safeErrorMessage(e: unknown): string {
  if (e instanceof ToolInputError) return scrubPaths(e.message);
  return 'AgentTrace could not read or analyze the requested session data. Check the session id and try again.';
}

/** For stderr diagnostics: never prints absolute paths either. */
export function safeLogMessage(e: unknown): string {
  return scrubPaths(e instanceof Error ? e.message : String(e));
}

/** Command text for the opt-in `include_commands` path: redacted, path-scrubbed, one line, truncated. */
export function safeCommand(text: string): string {
  return truncate(scrubPaths(redact(text)), LIMITS.commandChars);
}

/** Last path segment only; never the full working directory. */
export function projectName(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const base = path.basename(dir.replace(/[\\/]+$/, ''));
  return base ? scrubPaths(base) : undefined;
}

const iso = (d: Date | undefined) => (d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined);

export function tokensOut(t: TokenTotals) {
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, reasoning: t.reasoning, total: t.input + t.output + t.cacheRead + t.cacheWrite };
}

export function costOut(c: CostSummary) {
  return {
    estimatedApiEquivalentUsd: c.totalUsd === undefined ? null : round2(c.totalUsd),
    status: c.status,
    basis: 'estimated' as const,
    label: COST_LABEL,
    unknownModels: c.unknownModels.slice(0, LIMITS.groups),
  };
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
export { COST_DISCLAIMER };

/** Findings whose `subject` is guaranteed free of command/path text. Others need `include_commands`. */
const SAFE_SUBJECT_KINDS = new Set(['repeated-permission-error', 'similar-errors']);

/**
 * Neutral, fixed-template description built only from counts and times. Deliberately not
 * the engine's `why`/`recommendation` text: those can quote commands and recommendations are v0.5.
 */
function describe(f: Finding): string {
  const win = f.spanMs !== undefined ? ` Observed span first to last: ${Math.round(f.spanMs / 1000)}s (includes any waiting).` : '';
  switch (f.kind) {
    case 'repeated-failed-command':
    case 'repeated-failed-test':
      return `The same normalized ${f.kind === 'repeated-failed-test' ? 'test command' : 'command'} ran ${f.occurrences} time(s) and failed ${f.failures} time(s).` +
        (f.eventuallySucceeded === undefined ? '' : f.eventuallySucceeded ? ' It later succeeded.' : ' No later successful run was recorded.') + win;
    case 'identical-failed-retry':
      return `The same tool was called with identical input ${f.occurrences} time(s); ${f.failures} failed.` + win;
    case 'repeated-permission-error':
      return `${f.occurrences} calls failed with permission, sandbox or user-denial errors in a short burst.` + win;
    case 'similar-errors':
      return `${f.occurrences} errors with the same normalized message occurred in a short window, across different inputs.` + win;
    case 'repeated-read':
      return `The same file was read ${f.occurrences} times with no recorded modification in between (may be legitimate).` + win;
    case 'possible-loop':
      return `A repeated call pattern was seen ${f.occurrences} time(s) with no recorded progress (heuristic).` + win;
  }
}

export function evidenceOut(e: EvidenceItem, includeCommands: boolean) {
  return {
    at: iso(e.timestamp),
    tool: e.tool,
    status: e.status,
    exitCode: e.exitCode,
    errorClass: e.errorClass,
    ...(includeCommands ? { command: safeCommand(e.input) } : {}),
  };
}

export interface FindingOptions { includeCommands: boolean; withEvidence: boolean }

export function findingOut(f: Finding, o: FindingOptions) {
  const subjectOk = o.includeCommands || SAFE_SUBJECT_KINDS.has(f.kind);
  const evidence = f.evidence.slice(0, LIMITS.evidence);
  return {
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    basis: f.basis,
    title: f.title,
    description: describe(f),
    occurrences: f.occurrences,
    failures: f.failures,
    eventuallySucceeded: f.eventuallySucceeded,
    modificationsBetween: f.modificationsBetween,
    firstAt: iso(f.firstAt),
    lastAt: iso(f.lastAt),
    span: duration(f.spanMs, 'measured'),
    tools: f.tools.slice(0, 10),
    ...(subjectOk ? { subject: o.includeCommands ? safeCommand(f.subject) : scrubPaths(f.subject) } : {}),
    ...(o.withEvidence ? { evidence: evidence.map(e => evidenceOut(e, o.includeCommands)), evidenceShown: evidence.length, evidenceTotal: f.evidence.length } : {}),
  };
}

const SEV = { high: 0, medium: 1, low: 2 } as const;
export function rankFindings(all: Finding[]): Finding[] {
  return [...all].sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.occurrences - a.occurrences);
}

export function analysisOut(a: SessionAnalysis) {
  const all = rankFindings([...a.findings, ...a.loops]);
  const shown = all.slice(0, LIMITS.findings).map(f => findingOut(f, { includeCommands: false, withEvidence: false }));
  return {
    session: { agent: a.agent, id: a.sessionId, project: projectName(a.projectDir), models: a.models, cliVersion: a.cliVersion },
    time: {
      start: iso(a.timing.start),
      end: iso(a.timing.end),
      observed: duration(a.timing.observedMs, 'measured'),
      active: duration(a.timing.activeMs, 'estimated'),
      longPauses: { count: a.timing.pauses.length, threshold: duration(a.timing.pauseThresholdMs, 'measured'), total: duration(a.timing.pauses.reduce((s, p) => s + p.ms, 0), 'measured') },
      timestampsMissing: a.timing.timestampsMissing,
    },
    tokens: { available: a.tokens.available, ...tokensOut(a.tokens.total), byModel: Object.fromEntries(Object.entries(a.tokens.byModel).slice(0, LIMITS.groups).map(([m, t]) => [m, tokensOut(t)])) },
    cost: costOut(a.cost),
    tools: {
      total: a.tools.total, failed: a.tools.failed, interrupted: a.tools.interrupted,
      failuresByType: a.tools.failuresByType.slice(0, LIMITS.groups),
      byTool: a.tools.byTool.slice(0, LIMITS.groups).map(t => ({ tool: t.tool, calls: t.calls, errors: t.errors, interrupted: t.interrupted })),
    },
    counts: a.counts,
    findings: { total: all.length, shown: shown.length, items: shown },
    estimatedTimeInRepeatedFailures: duration(a.waste.repeatedFailureMs, 'estimated'),
    callsInRepeatedPatterns: a.waste.callsInRepeatedPatterns,
    notes: [COST_LABEL, 'Durations carry kind "measured" (from log timestamps) or "estimated" (derived). Observed spans include any time spent waiting for approvals.'],
  };
}

/**
 * Last line of defence: refuse to send a response that still contains an absolute path or the
 * home directory. A hit means a builder above is wrong, so fail closed.
 */
export function assertNoPaths(value: unknown): void {
  const s = JSON.stringify(value);
  const home = os.homedir();
  if ((home && home.length > 1 && s.includes(home)) || /(?<![\w.:~-])\/(?:Users|home|var|tmp|private|opt|etc|usr|root|mnt|Volumes)\//.test(s) || /[A-Za-z]:\\\\/.test(s)) {
    throw new Error('internal: response contained a filesystem path');
  }
}
