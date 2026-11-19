/**
 * Time analysis. Three levels of certainty, always labelled:
 *  - measured: durations the agent recorded itself (e.g. Codex exec duration, Claude durationMs)
 *  - observed: computed from log timestamps (session span, call-to-result intervals, pauses)
 *  - estimated: attribution of gaps between events to activity categories
 */
import type { NormalizedSession } from '../../types.js';

export interface Pause { from: Date; to: Date; ms: number }

export interface ToolTime {
  tool: string;
  calls: number;
  measuredMs: number;
  measuredCalls: number;
  logIntervalMs: number;
  logIntervalCalls: number;
}

export interface TimingSummary {
  start?: Date;
  end?: Date;
  /** Observed: last event minus first event. */
  observedMs?: number;
  /** Observed: observedMs minus long pauses. */
  activeMs?: number;
  pauseThresholdMs: number;
  pauses: Pause[];
  /** Estimated time per activity category (sums to observedMs). */
  categoriesMs: Record<string, number>;
  toolTimes: ToolTime[];
  timestampsMissing: boolean;
}

type PointKind = 'tool-start' | 'tool-end' | 'user-prompt' | 'assistant-end' | 'interrupt' | 'other';

export const CATEGORY = {
  tool: 'Tool execution (call→result interval)',
  model: 'Agent/model processing',
  user: 'Waiting for user',
  pause: 'Long pauses',
  other: 'Other',
} as const;

export function analyzeTiming(s: NormalizedSession, pauseThresholdMs = 5 * 60_000): TimingSummary {
  const out: TimingSummary = {
    start: s.startTime, end: s.endTime, pauseThresholdMs, pauses: [], categoriesMs: {}, toolTimes: [],
    timestampsMissing: s.eventTimes.length === 0,
  };
  if (s.startTime && s.endTime) out.observedMs = s.endTime.getTime() - s.startTime.getTime();

  // Long pauses between consecutive events.
  let pauseTotal = 0;
  for (let i = 1; i < s.eventTimes.length; i++) {
    const gap = s.eventTimes[i].getTime() - s.eventTimes[i - 1].getTime();
    if (gap >= pauseThresholdMs) {
      out.pauses.push({ from: s.eventTimes[i - 1], to: s.eventTimes[i], ms: gap });
      pauseTotal += gap;
    }
  }
  if (out.observedMs !== undefined) out.activeMs = Math.max(0, out.observedMs - pauseTotal);

  // Estimated category attribution over a merged point timeline.
  const pts: { t: number; k: PointKind }[] = [];
  for (const c of s.toolCalls) {
    if (c.subagent) continue;
    if (c.timestamp) pts.push({ t: c.timestamp.getTime(), k: 'tool-start' });
    if (c.resultTimestamp) pts.push({ t: c.resultTimestamp.getTime(), k: 'tool-end' });
  }
  for (const b of s.boundaries) {
    const k: PointKind = b.kind === 'user-prompt' ? 'user-prompt' : b.kind === 'assistant-end' ? 'assistant-end' : b.kind === 'interrupt' ? 'interrupt' : 'other';
    pts.push({ t: b.timestamp.getTime(), k });
  }
  for (const t of s.eventTimes) pts.push({ t: t.getTime(), k: 'other' });
  pts.sort((a, b) => a.t - b.t);
  let lastKind: PointKind = 'other';
  let openTools = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) {
      const gap = p.t - pts[i - 1].t;
      if (gap > 0) {
        let cat: string;
        if (gap >= pauseThresholdMs) cat = CATEGORY.pause;
        else if (openTools > 0) cat = CATEGORY.tool;
        else if (lastKind === 'assistant-end' || lastKind === 'interrupt') cat = CATEGORY.user;
        else cat = CATEGORY.model;
        out.categoriesMs[cat] = (out.categoriesMs[cat] ?? 0) + gap;
      }
    }
    if (p.k === 'tool-start') openTools++;
    if (p.k === 'tool-end') openTools = Math.max(0, openTools - 1);
    if (p.k === 'user-prompt') openTools = 0;
    if (p.k !== 'other') lastKind = p.k;
  }

  const byTool = new Map<string, ToolTime>();
  for (const c of s.toolCalls) {
    const tt = byTool.get(c.name) ?? { tool: c.name, calls: 0, measuredMs: 0, measuredCalls: 0, logIntervalMs: 0, logIntervalCalls: 0 };
    tt.calls++;
    if (c.durationMs !== undefined && c.durationSource === 'measured') { tt.measuredMs += c.durationMs; tt.measuredCalls++; }
    else if (c.durationMs !== undefined && c.durationSource === 'log-interval') { tt.logIntervalMs += c.durationMs; tt.logIntervalCalls++; }
    byTool.set(c.name, tt);
  }
  out.toolTimes = [...byTool.values()].sort((a, b) => (b.measuredMs + b.logIntervalMs) - (a.measuredMs + a.logIntervalMs));
  return out;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return 'Not available';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
