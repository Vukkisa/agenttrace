/**
 * Built-in model prices (USD per million tokens). These are API list prices used only to
 * estimate an "API-equivalent" cost. They are NOT what a subscription user is billed.
 *
 * Every entry records where the number came from. Values marked `derived` were computed
 * from the provider's documented cache multipliers rather than read from a price table;
 * override them with --pricing if your provider charges differently.
 *
 * Models without an entry are reported as "unknown model" and get no cost.
 */
import type { PriceEntry } from './index.js';

const ANTHROPIC_SRC = 'Anthropic API pricing (claude-api reference, cached 2026-11-03)';
const ANTHROPIC_DATE = '2026-11-03';
const DERIVED_CACHE = 'cache write prices derived from documented multipliers (5m = 1.25x input, 1h = 2x input)';

function anthropic(model: string, input: number, output: number, cacheRead: number, cacheReadDerived: boolean, aliases: string[] = []): PriceEntry {
  return {
    model, aliases,
    inputPerMTok: input, outputPerMTok: output,
    cacheReadPerMTok: cacheRead,
    cacheWrite5mPerMTok: +(input * 1.25).toFixed(4),
    cacheWrite1hPerMTok: +(input * 2).toFixed(4),
    source: ANTHROPIC_SRC, lastUpdated: ANTHROPIC_DATE,
    notes: cacheReadDerived ? `cache read derived (0.1x input); ${DERIVED_CACHE}` : DERIVED_CACHE,
  };
}

export const DEFAULT_PRICES: PriceEntry[] = [
  anthropic('claude-fable-5-2', 8, 40, 0.2, false),
  anthropic('claude-fable-5-1', 10, 50, 1.0, true),
  anthropic('claude-fable-5', 10, 50, 1.0, true),
  anthropic('claude-opus-5-5', 4, 20, 0.2, false),
  anthropic('claude-opus-5', 5, 25, 0.5, true),
  anthropic('claude-opus-4-8', 5, 25, 0.5, true),
  anthropic('claude-opus-4-7', 5, 25, 0.5, true),
  anthropic('claude-opus-4-6', 5, 25, 0.5, true),
  anthropic('claude-sonnet-5-5', 2, 10, 0.1, false),
  anthropic('claude-sonnet-5', 2, 10, 0.2, true),
  anthropic('claude-sonnet-4-6', 3, 15, 0.3, true),
  {
    ...anthropic('claude-haiku-5-5', 0.1, 0.5, 0.01, true),
    // Prompts over 100K tokens (cache reads and writes included) pay these rates on every token.
    longContext: { inputPerMTok: 0.5, outputPerMTok: 2.5, cacheReadPerMTok: 0.05, cacheWrite5mPerMTok: 0.625, cacheWrite1hPerMTok: 1 },
  },
  anthropic('claude-haiku-4-5', 1, 5, 0.1, true),
  // OpenAI models commonly used by Codex. Older list prices; verify before relying on them.
  {
    model: 'gpt-5', aliases: ['gpt-5-codex'], inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125,
    source: 'OpenAI API pricing page (as known 2025-08)', lastUpdated: '2025-08-07',
    notes: 'Older list price; newer Codex models are intentionally not included. Add them via --pricing.',
  },
  {
    model: 'gpt-5-mini', aliases: [], inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025,
    source: 'OpenAI API pricing page (as known 2025-08)', lastUpdated: '2025-08-07',
  },
];
