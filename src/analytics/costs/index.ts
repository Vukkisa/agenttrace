/**
 * API-equivalent cost = tokens x public list price. Never an actual bill.
 * A model's cost is computed only when every token category it used has a price.
 */
import { LONG_CONTEXT_THRESHOLD_TOKENS, resolvePrice, type PriceEntry, type PricingTable } from '../../pricing/index.js';
import type { TokenSummary, TokenTotals } from '../tokens/index.js';

export const COST_DISCLAIMER =
  'API-equivalent cost estimates what these tokens would cost at public API list prices. ' +
  'It is not your actual bill: subscription plans (e.g. Claude Pro/Max, ChatGPT plans) are not billed per token, ' +
  'and provider billing may differ (discounts, batch/priority tiers, regional pricing, rounding).';

export interface ModelCost {
  model: string;
  status: 'complete' | 'unknown-model' | 'missing-price-component';
  costUsd?: number;
  breakdown?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  price?: PriceEntry;
  missing?: string[];
  assumptions: string[];
}

export interface CostSummary {
  status: 'complete' | 'partial' | 'unavailable';
  /** Sum over models with complete pricing. Partial when some models lack prices. */
  totalUsd?: number;
  byModel: ModelCost[];
  unknownModels: string[];
  disclaimer: string;
}

const M = 1_000_000;

function sub(a: TokenTotals, b: TokenTotals): TokenTotals {
  const o = { ...a };
  for (const k of Object.keys(o) as (keyof TokenTotals)[]) o[k] = a[k] - b[k];
  return o;
}

/** Tokens x rates for one tier. Returns the USD breakdown. */
function tierCost(t: TokenTotals, r: { in: number; out: number; cr: number; w5: number; w1: number }) {
  return {
    input: (t.input * r.in) / M,
    output: (t.output * r.out) / M,
    cacheRead: (t.cacheRead * r.cr) / M,
    cacheWrite: ((t.cacheWrite5m + t.cacheWriteUnsplit) * r.w5 + t.cacheWrite1h * r.w1) / M,
  };
}

/**
 * `long` is the subset of `t` made of requests above the long-context threshold. When the model has
 * long-context rates, that subset is priced at them and the rest at the standard rates.
 */
export function costForModel(model: string, t: TokenTotals, table: PricingTable, long?: TokenTotals): ModelCost {
  const price = resolvePrice(table, model);
  const assumptions: string[] = [];
  if (!price) return { model, status: 'unknown-model', assumptions };
  const missing: string[] = [];
  if (t.cacheRead > 0 && price.cacheReadPerMTok === undefined) missing.push('cacheReadPerMTok');
  const needsW5 = t.cacheWrite5m > 0 || t.cacheWriteUnsplit > 0;
  if (needsW5 && price.cacheWrite5mPerMTok === undefined) missing.push('cacheWrite5mPerMTok');
  if (t.cacheWrite1h > 0 && price.cacheWrite1hPerMTok === undefined) missing.push('cacheWrite1hPerMTok');
  if (missing.length) return { model, status: 'missing-price-component', price, missing, assumptions };
  if (t.cacheWriteUnsplit > 0) assumptions.push(`${t.cacheWriteUnsplit} cache-write tokens had no 5m/1h split; priced at the 5m rate`);
  if (price.notes) assumptions.push(price.notes);
  const std = { in: price.inputPerMTok, out: price.outputPerMTok, cr: price.cacheReadPerMTok ?? 0, w5: price.cacheWrite5mPerMTok ?? 0, w1: price.cacheWrite1hPerMTok ?? 0 };
  let breakdown = tierCost(t, std);
  const lc = price.longContext;
  if (lc && long && long.records > 0) {
    const lr = {
      in: lc.inputPerMTok, out: lc.outputPerMTok, cr: lc.cacheReadPerMTok ?? std.cr,
      w5: lc.cacheWrite5mPerMTok ?? std.w5, w1: lc.cacheWrite1hPerMTok ?? std.w1,
    };
    const a = tierCost(sub(t, long), std);
    const b = tierCost(long, lr);
    breakdown = { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
    assumptions.push(`${long.records} request(s) with prompts over ${LONG_CONTEXT_THRESHOLD_TOKENS.toLocaleString('en-US')} tokens priced at long-context rates`);
  }
  const costUsd = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  return { model, status: 'complete', costUsd, breakdown, price, assumptions };
}

export function summarizeCost(tokens: TokenSummary, table: PricingTable): CostSummary {
  if (!tokens.available) return { status: 'unavailable', byModel: [], unknownModels: [], disclaimer: COST_DISCLAIMER };
  const byModel = Object.entries(tokens.byModel).map(([m, t]) => costForModel(m, t, table, tokens.longByModel?.[m]));
  const complete = byModel.filter(c => c.status === 'complete');
  const unknownModels = byModel.filter(c => c.status !== 'complete').map(c => c.model);
  const status: CostSummary['status'] = complete.length === 0 ? 'unavailable' : complete.length === byModel.length ? 'complete' : 'partial';
  const totalUsd = complete.length ? complete.reduce((s, c) => s + (c.costUsd ?? 0), 0) : undefined;
  return { status, totalUsd, byModel, unknownModels, disclaimer: COST_DISCLAIMER };
}

export function formatUsd(v: number | undefined): string {
  if (v === undefined) return 'Not available';
  if (v > 0 && v < 0.01) return '<$0.01';
  return '$' + v.toFixed(2);
}
