/**
 * Local summary cache.
 *
 * Stores one compact SessionSummary per session file (counts, token totals, timing; no
 * transcript content), together with the size and mtime of every log file it was built from.
 *
 * Safety rules:
 * - An entry is used only if every source file still has exactly the recorded size and mtime,
 *   the file list is identical, and no file was modified within RACY_MS of when the entry was
 *   computed (protects against same-timestamp rewrites and files still being written).
 * - The whole cache is discarded on schema, parser-version or app-version mismatch.
 * - Unreadable / corrupt cache files are ignored (and reported), never trusted.
 * - Writes are atomic (temp file + rename) with 0600 permissions in a 0700 directory.
 * - Entries whose main log file no longer exists are pruned.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRef } from '../types.js';
import type { SessionSummary } from '../analytics/summary.js';
import { PARSER_VERSION, VERSION } from '../version.js';

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_FILE = 'summaries.json';
/** A file modified this close to (or after) the entry's computation time is never trusted. */
export const RACY_MS = 2_000;

export interface FileSig { path: string; size: number; mtimeMs: number }

interface Entry { sig: FileSig[]; computedAt: number; summary: SessionSummary }
interface CacheFileShape { schema: number; parserVersion: number; appVersion: string; entries: Record<string, Entry> }

export interface CacheStats { reused: number; parsed: number; invalidated: number; pruned: number }

/** Default cache directory: $AGENTTRACE_CACHE_DIR, else the OS user cache dir. */
export function defaultCacheDir(env = process.env, platform = process.platform, home = os.homedir()): string {
  if (env.AGENTTRACE_CACHE_DIR) return path.resolve(env.AGENTTRACE_CACHE_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'agenttrace');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agenttrace', 'Cache');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'agenttrace');
}

/** Stable short hash of settings that change detection results. */
export function settingsKey(v: unknown): string {
  const stable = (x: unknown): unknown =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, stable((x as Record<string, unknown>)[k])]))
      : x;
  return crypto.createHash('sha256').update(JSON.stringify(stable(v))).digest('hex').slice(0, 16);
}

/** Current signature of a session's files, or undefined if any file cannot be stat'ed. */
export function signature(ref: SessionRef): FileSig[] | undefined {
  const out: FileSig[] = [];
  for (const f of ref.files) {
    try {
      const st = fs.statSync(f);
      out.push({ path: path.resolve(f), size: st.size, mtimeMs: st.mtimeMs });
    } catch { return undefined; }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Keyed by agent + main log file path (not session ID), so different roots never collide. */
function entryKey(ref: SessionRef): string {
  const main = ref.files.find(f => !f.includes(`${path.sep}subagents${path.sep}`)) ?? ref.files[0] ?? ref.sessionId;
  return `${ref.agent}:${path.resolve(main)}`;
}

function sameSig(a: FileSig[], b: FileSig[]): boolean {
  return a.length === b.length && a.every((x, i) => x.path === b[i].path && x.size === b[i].size && x.mtimeMs === b[i].mtimeMs);
}

function reviveSummary(s: SessionSummary): SessionSummary {
  return { ...s, start: s.start ? new Date(s.start as unknown as string) : undefined };
}

function validEntry(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Entry;
  return Array.isArray(x.sig) && typeof x.computedAt === 'number' && !!x.summary && typeof x.summary === 'object'
    && typeof x.summary.sessionId === 'string' && !!x.summary.tokens && !!x.summary.detection
    && x.sig.every(f => f && typeof f.path === 'string' && typeof f.size === 'number' && typeof f.mtimeMs === 'number');
}

export class SummaryCache {
  readonly file: string;
  /** Human-readable reason when an existing cache file was ignored. */
  note?: string;
  readonly stats: CacheStats = { reused: 0, parsed: 0, invalidated: 0, pruned: 0 };
  private entries: Record<string, Entry> = {};
  private dirty = false;

  private constructor(readonly dir: string, readonly enabled: boolean) {
    this.file = path.join(dir, CACHE_FILE);
  }

  static open(opts: { dir?: string; enabled?: boolean } = {}): SummaryCache {
    const c = new SummaryCache(opts.dir ?? defaultCacheDir(), opts.enabled !== false);
    if (c.enabled) c.load();
    return c;
  }

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; } // no cache yet
    let data: CacheFileShape;
    try { data = JSON.parse(raw); } catch { this.note = 'cache file was corrupt and has been ignored; rebuilding'; this.dirty = true; return; }
    if (!data || typeof data !== 'object' || typeof data.entries !== 'object' || data.entries === null) {
      this.note = 'cache file had an unexpected format and has been ignored; rebuilding'; this.dirty = true; return;
    }
    if (data.schema !== CACHE_SCHEMA_VERSION || data.parserVersion !== PARSER_VERSION || data.appVersion !== VERSION) {
      this.note = 'cache was built by a different AgentTrace/parser version; rebuilding'; this.dirty = true; return;
    }
    for (const [k, e] of Object.entries(data.entries)) {
      if (validEntry(e)) this.entries[k] = e;
      else { this.stats.invalidated++; this.dirty = true; }
    }
  }

  /**
   * Cached summary for a session, or undefined if missing or not provably fresh.
   * With `detectionKey`, also requires detection results computed with those settings.
   */
  get(ref: SessionRef, sig: FileSig[] | undefined, detectionKey?: string): SessionSummary | undefined {
    if (!this.enabled || !sig) return undefined;
    const e = this.entries[entryKey(ref)];
    if (!e) return undefined;
    const fresh = sameSig(e.sig, sig) && sig.every(f => f.mtimeMs < e.computedAt - RACY_MS);
    if (!fresh) { this.stats.invalidated++; return undefined; }
    if (detectionKey !== undefined && e.summary.detection.key !== detectionKey) return undefined;
    this.stats.reused++;
    return reviveSummary(e.summary);
  }

  /** Store a summary. `computedAt` must be taken BEFORE the files were read. */
  set(ref: SessionRef, sig: FileSig[] | undefined, computedAt: number, summary: SessionSummary): void {
    this.stats.parsed++;
    if (!this.enabled || !sig) return;
    this.entries[entryKey(ref)] = { sig, computedAt, summary };
    this.dirty = true;
  }

  /** Drop entries whose main file is gone, then write atomically. Returns an error message on failure. */
  save(): string | undefined {
    if (!this.enabled) return undefined;
    for (const k of Object.keys(this.entries)) {
      if (!fs.existsSync(k.slice(k.indexOf(':') + 1))) { delete this.entries[k]; this.stats.pruned++; this.dirty = true; }
    }
    if (!this.dirty) return undefined;
    const data: CacheFileShape = { schema: CACHE_SCHEMA_VERSION, parserVersion: PARSER_VERSION, appVersion: VERSION, entries: this.entries };
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return undefined;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return `could not write cache (${(e as Error).message}); results were computed without it`;
    }
  }

  get size(): number { return Object.keys(this.entries).length; }
}

/** Remove the cache file (and the directory if it becomes empty). Returns true if a file was removed. */
export function clearCache(dir = defaultCacheDir()): boolean {
  const file = path.join(dir, CACHE_FILE);
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch { /* not present */ }
  try {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${CACHE_FILE}.`) && f.endsWith('.tmp')) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
  } catch { /* not empty or missing */ }
  return removed;
}

export function cacheInfo(dir = defaultCacheDir()): { file: string; exists: boolean; bytes?: number; entries?: number; note?: string } {
  const file = path.join(dir, CACHE_FILE);
  if (!fs.existsSync(file)) return { file, exists: false };
  const c = SummaryCache.open({ dir });
  return { file, exists: true, bytes: fs.statSync(file).size, entries: c.size, note: c.note };
}
