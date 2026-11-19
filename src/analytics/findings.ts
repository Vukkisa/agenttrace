import type { ToolCall } from '../types.js';

export type FindingKind =
  | 'repeated-failed-command'
  | 'repeated-failed-test'
  | 'identical-failed-retry'
  | 'repeated-permission-error'
  | 'similar-errors'
  | 'repeated-read'
  | 'possible-loop';

export interface EvidenceItem {
  timestamp?: Date;
  tool: string;
  input: string;
  status: ToolCall['status'];
  exitCode?: number;
  errorClass?: string;
  /** Only populated when the user opts in to showing error excerpts. */
  errorSnippet?: string;
}

export interface Finding {
  id: string;
  kind: FindingKind;
  /** Banner label, e.g. "REPEATED FAILURE DETECTED" or "Possible repetitive behaviour". */
  label: string;
  title: string;
  /** measured = counted directly from log events; heuristic = pattern-based interpretation. */
  basis: 'measured' | 'heuristic';
  severity: 'high' | 'medium' | 'low';
  subject: string;
  occurrences: number;
  failures: number;
  eventuallySucceeded?: boolean;
  /** File modifications observed between the first and last failure (any file). */
  modificationsBetween?: number;
  firstAt?: Date;
  lastAt?: Date;
  /** Observed span from first to last occurrence. */
  spanMs?: number;
  /**
   * Periods of back-to-back repetition (consecutive occurrences no further apart than the
   * similar-error window). Used for the "time in repeated-failure periods" estimate so that
   * occurrences hours apart do not inflate it.
   */
  repeatPeriods?: [number, number][];
  tools: string[];
  evidence: EvidenceItem[];
  why: string;
  recommendation: string;
}

export interface DetectionConfig {
  /** Minimum occurrences before a pattern is reported. */
  threshold: number;
  /** Window for "similar errors within a short period". */
  similarErrorWindowMs: number;
  /** Include redacted error excerpts in evidence. Off by default. */
  includeErrorSnippets: boolean;
}

export const DEFAULT_DETECTION: DetectionConfig = {
  threshold: 3,
  similarErrorWindowMs: 10 * 60_000,
  includeErrorSnippets: false,
};

export function evidenceOf(c: ToolCall, cfg: DetectionConfig): EvidenceItem {
  return {
    timestamp: c.timestamp, tool: c.name, input: c.inputSummary, status: c.status,
    exitCode: c.exitCode, errorClass: c.errorClass,
    errorSnippet: cfg.includeErrorSnippets ? c.errorSnippet : undefined,
  };
}

export function spanOf(calls: ToolCall[], maxGapMs = DEFAULT_DETECTION.similarErrorWindowMs): { firstAt?: Date; lastAt?: Date; spanMs?: number; repeatPeriods?: [number, number][] } {
  const timed = calls.filter(c => c.timestamp).sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime());
  if (!timed.length) return {};
  const endOf = (c: ToolCall) => (c.resultTimestamp ?? c.timestamp)!.getTime();
  const last = Math.max(...timed.map(endOf));
  const periods: [number, number][] = [];
  let cur: [number, number] = [timed[0].timestamp!.getTime(), endOf(timed[0])];
  let count = 1;
  for (let i = 1; i < timed.length; i++) {
    const t0 = timed[i].timestamp!.getTime();
    if (t0 - cur[1] <= maxGapMs) { cur[1] = Math.max(cur[1], endOf(timed[i])); count++; }
    else { if (count > 1) periods.push(cur); cur = [t0, endOf(timed[i])]; count = 1; }
  }
  if (count > 1) periods.push(cur);
  return { firstAt: timed[0].timestamp, lastAt: new Date(last), spanMs: last - timed[0].timestamp!.getTime(), repeatPeriods: periods };
}

/** Keep the first and last few evidence items so reports stay compact. */
export function sampleEvidence(calls: ToolCall[], cfg: DetectionConfig, max = 8): EvidenceItem[] {
  const pick = calls.length <= max ? calls : [...calls.slice(0, max - 2), ...calls.slice(-2)];
  return pick.map(c => evidenceOf(c, cfg));
}
