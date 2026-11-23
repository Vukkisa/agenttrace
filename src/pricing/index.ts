/**
 * Pricing table: kept separate from parsing. Resolution is exact-match only (plus aliases
 * and a stripped date suffix like -20250514). No fuzzy/prefix matching, so a model is never
 * silently priced as a different model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PRICES } from './defaults.js';

export const LONG_CONTEXT_THRESHOLD_TOKENS = 100_000;

export interface LongContextPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
}

export interface PriceEntry {
  model: string;
  aliases?: string[];
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  /** Price for cache writes when the 5m/1h split is unknown, or 5-minute writes. */
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
  /**
   * Long-context rates. Applied per request, to every token of a request whose prompt
   * (input + cache read + cache write) exceeds LONG_CONTEXT_THRESHOLD_TOKENS.
   */
  longContext?: LongContextPrice;
  source: string;
  lastUpdated: string;
  notes?: string;
}

export interface PricingTable {
  entries: PriceEntry[];
  /** Files merged on top of the built-in defaults, in order. */
  loadedFrom: string[];
}

export const USER_PRICING_FILE = path.join(os.homedir(), '.agenttrace', 'pricing.json');

function validate(e: unknown, file: string, i: number): PriceEntry {
  const o = e as Record<string, unknown>;
  const bad = (m: string) => new Error(`${file}: entry ${i}: ${m}`);
  if (!o || typeof o !== 'object') throw bad('not an object');
  if (typeof o.model !== 'string' || !o.model) throw bad('"model" is required');
  for (const k of ['inputPerMTok', 'outputPerMTok']) {
    if (typeof o[k] !== 'number' || (o[k] as number) < 0) throw bad(`"${k}" must be a non-negative number`);
  }
  for (const k of ['cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok']) {
    if (o[k] !== undefined && (typeof o[k] !== 'number' || (o[k] as number) < 0)) throw bad(`"${k}" must be a non-negative number`);
  }
  let longContext: LongContextPrice | undefined;
  if (o.longContext !== undefined) {
    const l = o.longContext as Record<string, unknown>;
    if (!l || typeof l !== 'object') throw bad('"longContext" must be an object');
    for (const k of ['inputPerMTok', 'outputPerMTok']) {
      if (typeof l[k] !== 'number' || (l[k] as number) < 0) throw bad(`"longContext.${k}" must be a non-negative number`);
    }
    for (const k of ['cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok']) {
      if (l[k] !== undefined && (typeof l[k] !== 'number' || (l[k] as number) < 0)) throw bad(`"longContext.${k}" must be a non-negative number`);
    }
    longContext = {
      inputPerMTok: l.inputPerMTok as number, outputPerMTok: l.outputPerMTok as number,
      cacheReadPerMTok: l.cacheReadPerMTok as number | undefined,
      cacheWrite5mPerMTok: l.cacheWrite5mPerMTok as number | undefined,
      cacheWrite1hPerMTok: l.cacheWrite1hPerMTok as number | undefined,
    };
  }
  return {
    model: o.model,
    aliases: Array.isArray(o.aliases) ? o.aliases.filter((a): a is string => typeof a === 'string') : [],
    inputPerMTok: o.inputPerMTok as number,
    outputPerMTok: o.outputPerMTok as number,
    cacheReadPerMTok: o.cacheReadPerMTok as number | undefined,
    cacheWrite5mPerMTok: o.cacheWrite5mPerMTok as number | undefined,
    cacheWrite1hPerMTok: o.cacheWrite1hPerMTok as number | undefined,
    longContext,
    source: typeof o.source === 'string' ? o.source : `user file ${file}`,
    lastUpdated: typeof o.lastUpdated === 'string' ? o.lastUpdated : 'unknown',
    notes: typeof o.notes === 'string' ? o.notes : undefined,
  };
}

/** Load a pricing JSON file: either an array of entries or {"models": [...]}. */
export function readPricingFile(file: string): PriceEntry[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.models;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array or {"models": [...]}`);
  return list.map((e, i) => validate(e, file, i));
}

/**
 * Build the pricing table: defaults, then ~/.agenttrace/pricing.json if present,
 * then an explicit --pricing file. Later entries replace earlier ones for the same model.
 */
export function loadPricing(opts: { pricingFile?: string; useUserFile?: boolean; includeDefaults?: boolean } = {}): PricingTable {
  const byModel = new Map<string, PriceEntry>();
  const loadedFrom: string[] = [];
  if (opts.includeDefaults !== false) for (const e of DEFAULT_PRICES) byModel.set(e.model, e);
  const files: string[] = [];
  if (opts.useUserFile !== false && fs.existsSync(USER_PRICING_FILE)) files.push(USER_PRICING_FILE);
  if (opts.pricingFile) files.push(path.resolve(opts.pricingFile));
  for (const f of files) {
    for (const e of readPricingFile(f)) byModel.set(e.model, e);
    loadedFrom.push(f);
  }
  return { entries: [...byModel.values()], loadedFrom };
}

export function resolvePrice(table: PricingTable, model: string | undefined): PriceEntry | undefined {
  if (!model) return undefined;
  const candidates = [model, model.replace(/-\d{8}$/, ''), model.replace(/\[[^\]]*\]$/, '')];
  for (const c of candidates) {
    const hit = table.entries.find(e => e.model === c || e.aliases?.includes(c));
    if (hit) return hit;
  }
  return undefined;
}

export function pricingTemplate(): string {
  return JSON.stringify({
    models: [
      {
        model: 'my-proxy/claude-sonnet',
        aliases: [],
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWrite5mPerMTok: 3.75,
        cacheWrite1hPerMTok: 6,
        source: 'Example: proxy provider price sheet (e.g. OmniRoute)',
        lastUpdated: new Date().toISOString().slice(0, 10),
        notes: 'Replace with your provider\'s real prices.',
      },
    ],
  }, null, 2) + '\n';
}
