/**
 * API-equivalent cost = tokens x public list price. Never an actual bill.
 * A model's cost is computed only when every token category it used has a price.
 */
import { resolvePrice, type PriceEntry, type PricingTable } from '../../pricing/index.js';
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

export function costForModel(model: string, t: TokenTotals, table: PricingTable): ModelCost {
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
  const breakdown = {
    input: (t.input * price.inputPerMTok) / M,
    output: (t.output * price.outputPerMTok) / M,
    cacheRead: (t.cacheRead * (price.cacheReadPerMTok ?? 0)) / M,
    cacheWrite: ((t.cacheWrite5m + t.cacheWriteUnsplit) * (price.cacheWrite5mPerMTok ?? 0) + t.cacheWrite1h * (price.cacheWrite1hPerMTok ?? 0)) / M,
  };
  const costUsd = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  return { model, status: 'complete', costUsd, breakdown, price, assumptions };
}

export function summarizeCost(tokens: TokenSummary, table: PricingTable): CostSummary {
  if (!tokens.available) return { status: 'unavailable', byModel: [], unknownModels: [], disclaimer: COST_DISCLAIMER };
  const byModel = Object.entries(tokens.byModel).map(([m, t]) => costForModel(m, t, table));
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
