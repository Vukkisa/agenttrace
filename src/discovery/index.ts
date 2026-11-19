/**
 * Locate session logs on disk. Read-only: only stat/readdir calls.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentName, NormalizedSession, SessionRef } from '../types.js';
import { parseClaudeSession } from '../parsers/claude/index.js';
import { parseCodexSession } from '../parsers/codex/index.js';
import { zstdSupported } from '../parsers/jsonl.js';

export interface DiscoveryOptions {
  claudeDir?: string;
  codexDir?: string;
  agents?: AgentName[];
}

export interface DiscoveryResult {
  sessions: SessionRef[];
  roots: { agent: AgentName; dir: string; exists: boolean; source: string }[];
  skipped: { file: string; reason: string }[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function safeReaddir(p: string): fs.Dirent[] {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

export function claudeRoots(opt: DiscoveryOptions): { dir: string; source: string }[] {
  if (opt.claudeDir) return [{ dir: path.resolve(expandHome(opt.claudeDir)), source: '--claude-dir' }];
  const out: { dir: string; source: string }[] = [];
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) for (const d of env.split(',').map(x => x.trim()).filter(Boolean)) out.push({ dir: path.resolve(expandHome(d)), source: 'CLAUDE_CONFIG_DIR' });
  out.push({ dir: path.join(os.homedir(), '.claude'), source: 'default' });
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  out.push({ dir: path.join(xdg, 'claude'), source: 'default (XDG)' });
  const seen = new Set<string>();
  return out.filter(r => (seen.has(r.dir) ? false : (seen.add(r.dir), true)));
}

export function codexRoot(opt: DiscoveryOptions): { dir: string; source: string } {
  if (opt.codexDir) return { dir: path.resolve(expandHome(opt.codexDir)), source: '--codex-dir' };
  if (process.env.CODEX_HOME) return { dir: path.resolve(expandHome(process.env.CODEX_HOME)), source: 'CODEX_HOME' };
  return { dir: path.join(os.homedir(), '.codex'), source: 'default' };
}

function stat(file: string): fs.Stats | undefined {
  try { return fs.statSync(file); } catch { return undefined; }
}

function discoverClaude(root: string, res: DiscoveryResult): void {
  // Accept either the config dir (containing projects/) or the projects dir itself.
  const projects = isDir(path.join(root, 'projects')) ? path.join(root, 'projects') : root;
  const byId = new Map<string, SessionRef & { main?: string; subs: string[] }>();
  for (const proj of safeReaddir(projects)) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(projects, proj.name);
    for (const ent of safeReaddir(pdir)) {
      const full = path.join(pdir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const id = ent.name.replace(/\.jsonl$/, '');
        const st = stat(full); if (!st) continue;
        const ref = byId.get(id) ?? { agent: 'claude-code' as const, sessionId: id, files: [], mtime: st.mtime, sizeBytes: 0, subs: [] };
        ref.main = full;
        ref.sizeBytes += st.size;
        if (st.mtime > ref.mtime) ref.mtime = st.mtime;
        byId.set(id, ref);
      } else if (ent.isDirectory() && UUID.test(ent.name)) {
        const subdir = path.join(full, 'subagents');
        for (const sub of safeReaddir(subdir)) {
          if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
          const sf = path.join(subdir, sub.name);
          const st = stat(sf); if (!st) continue;
          const ref = byId.get(ent.name) ?? { agent: 'claude-code' as const, sessionId: ent.name, files: [], mtime: st.mtime, sizeBytes: 0, subs: [] };
          ref.subs.push(sf);
          ref.sizeBytes += st.size;
          if (st.mtime > ref.mtime) ref.mtime = st.mtime;
          byId.set(ent.name, ref);
        }
      }
    }
  }
  for (const r of byId.values()) {
    if (!r.main && r.subs.length === 0) continue;
    res.sessions.push({ agent: 'claude-code', sessionId: r.sessionId, files: [...(r.main ? [r.main] : []), ...r.subs.sort()], mtime: r.mtime, sizeBytes: r.sizeBytes });
  }
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 6) return;
  for (const ent of safeReaddir(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, depth + 1, out);
    else if (ent.isFile() && /\.jsonl(\.zst)?$/.test(ent.name)) out.push(full);
  }
}

function discoverCodex(root: string, res: DiscoveryResult): void {
  const dirs = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')].filter(isDir);
  if (dirs.length === 0 && isDir(root)) dirs.push(root); // user pointed directly at a sessions dir
  const files: string[] = [];
  for (const d of dirs) walk(d, 0, files);
  const zstd = zstdSupported();
  for (const f of files) {
    if (f.endsWith('.zst') && !zstd) { res.skipped.push({ file: f, reason: 'zstd requires Node.js >= 22.15' }); continue; }
    const st = stat(f); if (!st) continue;
    const base = path.basename(f);
    const id = base.match(UUID)?.[0] ?? base.replace(/\.jsonl(\.zst)?$/, '');
    res.sessions.push({ agent: 'codex', sessionId: id, files: [f], mtime: st.mtime, sizeBytes: st.size });
  }
}

export function discover(opt: DiscoveryOptions = {}): DiscoveryResult {
  const agents = opt.agents ?? ['claude-code', 'codex'];
  const res: DiscoveryResult = { sessions: [], roots: [], skipped: [] };
  if (agents.includes('claude-code')) {
    for (const r of claudeRoots(opt)) {
      const exists = isDir(r.dir);
      res.roots.push({ agent: 'claude-code', dir: r.dir, exists, source: r.source });
      if (exists) discoverClaude(r.dir, res);
    }
  }
  if (agents.includes('codex')) {
    const r = codexRoot(opt);
    const exists = isDir(r.dir);
    res.roots.push({ agent: 'codex', dir: r.dir, exists, source: r.source });
    if (exists) discoverCodex(r.dir, res);
  }
  // De-duplicate sessions seen under several roots (same id + agent).
  const seen = new Map<string, SessionRef>();
  for (const s of res.sessions) {
    const k = s.agent + ':' + s.sessionId;
    const prev = seen.get(k);
    if (!prev || s.mtime > prev.mtime) seen.set(k, s);
  }
  res.sessions = [...seen.values()].sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return res;
}

/** Resolve a full or prefix session id. Throws with a helpful message on 0 or >1 matches. */
export function findSession(sessions: SessionRef[], idOrPrefix: string): SessionRef {
  const exact = sessions.filter(s => s.sessionId === idOrPrefix);
  if (exact.length === 1) return exact[0];
  const pre = sessions.filter(s => s.sessionId.startsWith(idOrPrefix));
  if (pre.length === 1) return pre[0];
  if (pre.length === 0) throw new Error(`No session matches "${idOrPrefix}". Run "agenttrace sessions" to list IDs.`);
  throw new Error(`"${idOrPrefix}" is ambiguous (${pre.length} matches). Use more characters.`);
}

export async function loadSession(ref: SessionRef): Promise<NormalizedSession> {
  if (ref.agent === 'claude-code') {
    const main = ref.files.find(f => !f.includes(`${path.sep}subagents${path.sep}`));
    const subs = ref.files.filter(f => f !== main);
    return parseClaudeSession(ref.sessionId, main, subs);
  }
  return parseCodexSession(ref.files[0]);
}
