import type { UsageRecord } from '../../types.js';

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Cache-write tokens whose 5m/1h split the log did not provide. */
  cacheWriteUnsplit: number;
  reasoning: number;
  records: number;
}

export interface TokenSummary {
  available: boolean;
  total: TokenTotals;
  byModel: Record<string, TokenTotals>;
  byDay: Record<string, TokenTotals>;
  subagent: TokenTotals;
  /** How usage was derived, e.g. per-message (Claude) or cumulative-delta (Codex). */
  sources: string[];
}

export const UNKNOWN_MODEL = '(model not recorded)';

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnsplit: 0, reasoning: 0, records: 0 };
}

export function addRecord(t: TokenTotals, u: UsageRecord): void {
  t.input += u.inputTokens;
  t.output += u.outputTokens;
  t.cacheRead += u.cacheReadTokens;
  t.cacheWrite += u.cacheWriteTokens;
  if (u.cacheWrite5mTokens !== undefined || u.cacheWrite1hTokens !== undefined) {
    const w5 = u.cacheWrite5mTokens ?? 0; const w1 = u.cacheWrite1hTokens ?? 0;
    t.cacheWrite5m += w5; t.cacheWrite1h += w1;
    t.cacheWriteUnsplit += Math.max(0, u.cacheWriteTokens - w5 - w1);
  } else {
    t.cacheWriteUnsplit += u.cacheWriteTokens;
  }
  t.reasoning += u.reasoningTokens ?? 0;
  t.records++;
}

export function mergeTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  const o = emptyTotals();
  for (const k of Object.keys(o) as (keyof TokenTotals)[]) o[k] = a[k] + b[k];
  return o;
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function summarizeTokens(usage: UsageRecord[]): TokenSummary {
  const total = emptyTotals();
  const subagent = emptyTotals();
  const byModel: Record<string, TokenTotals> = {};
  const byDay: Record<string, TokenTotals> = {};
  const sources = new Set<string>();
  for (const u of usage) {
    addRecord(total, u);
    if (u.subagent) addRecord(subagent, u);
    const m = u.model ?? UNKNOWN_MODEL;
    addRecord((byModel[m] ??= emptyTotals()), u);
    const day = u.timestamp ? localDay(u.timestamp) : '(no timestamp)';
    addRecord((byDay[day] ??= emptyTotals()), u);
    sources.add(u.source);
  }
  return { available: usage.length > 0, total, byModel, byDay, subagent, sources: [...sources] };
}
