import type { SessionRef } from '../types.js';
import type { PricingTable } from '../pricing/index.js';
import { loadSession } from '../discovery/index.js';
import { analyzeSession } from '../analytics/analyze.js';
import { toSummary, type SessionSummary } from '../analytics/summary.js';
import { SummaryCache, settingsKey, signature } from './index.js';

export interface CollectOptions {
  cache: SummaryCache;
  /** Detection settings passed to analyzeSession (also hashed into the cache key). */
  detection: Parameters<typeof analyzeSession>[2];
  /** When true, cached detection counts must have been computed with `detection`. */
  requireDetection: boolean;
  pricing: () => PricingTable;
  warn?: (msg: string) => void;
}

/**
 * Per-session summaries for many sessions. Reuses cached summaries only when their source files
 * are provably unchanged; everything else is parsed and analyzed fresh and written back.
 */
export async function collectSummaries(refs: SessionRef[], o: CollectOptions): Promise<SessionSummary[]> {
  const key = settingsKey(o.detection);
  let table: PricingTable | undefined;
  const out: SessionSummary[] = [];
  for (const ref of refs) {
    const sig = signature(ref);
    const hit = o.cache.get(ref, sig, o.requireDetection ? key : undefined);
    if (hit) { out.push(hit); continue; }
    const computedAt = Date.now(); // taken before reading, so any later write invalidates the entry
    try {
      table ??= o.pricing(); // analyzeSession needs one; summaries recompute cost at display time
      const sum = toSummary(analyzeSession(await loadSession(ref), table, o.detection), key);
      o.cache.set(ref, sig, computedAt, sum);
      out.push(sum);
    } catch (e) {
      o.warn?.(`warning: could not analyze ${ref.agent} ${ref.sessionId}: ${(e as Error).message}`);
    }
  }
  const err = o.cache.save();
  if (err) o.warn?.(`agenttrace: ${err}`);
  return out;
}
