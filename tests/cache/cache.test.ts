import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discover, loadSession } from '../../src/discovery/index.js';
import { SummaryCache, clearCache, defaultCacheDir, CACHE_FILE, CACHE_SCHEMA_VERSION } from '../../src/cache/index.js';
import { collectSummaries } from '../../src/cache/collect.js';
import { summarizeSummaries } from '../../src/analytics/summary.js';
import { analyzeSession, summarizeMany } from '../../src/analytics/analyze.js';
import { loadPricing } from '../../src/pricing/index.js';
import { VERSION, PARSER_VERSION } from '../../src/version.js';

const FX = path.join(__dirname, '..', 'fixtures');
const pricing = () => loadPricing({ useUserFile: false });
const det = { threshold: 3, includeErrorSnippets: false, pauseThresholdMs: 300_000 };
const tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** Give files an mtime safely in the past (outside the racy window). */
function age(target: string, secondsAgo = 120) {
  const t = new Date(Date.now() - secondsAgo * 1000);
  for (const f of fs.statSync(target).isDirectory() ? walk(target) : [target]) fs.utimesSync(f, t, t);
}
function setup(aged = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-cache-'));
  tmpDirs.push(root);
  const claude = path.join(root, 'claude');
  fs.cpSync(path.join(FX, 'claude'), claude, { recursive: true });
  if (aged) age(claude);
  return { claude, cacheDir: path.join(root, 'cache'), proj: path.join(claude, 'projects', '-home-dev-demo-app') };
}
async function run(env: ReturnType<typeof setup>, detection = det, enabled = true) {
  const cache = SummaryCache.open({ dir: env.cacheDir, enabled });
  const refs = discover({ claudeDir: env.claude, agents: ['claude-code'] }).sessions;
  const list = await collectSummaries(refs, { cache, detection, requireDetection: true, pricing });
  return { cache, list, refs };
}

describe('summary cache', () => {
  it('reuses unchanged sessions and gives the same result as a fresh parse', async () => {
    const env = setup();
    const first = await run(env);
    expect(first.cache.stats).toMatchObject({ reused: 0, parsed: first.refs.length });
    const second = await run(env);
    expect(second.cache.stats).toMatchObject({ reused: first.refs.length, parsed: 0 });

    const fresh = [];
    for (const r of second.refs) fresh.push(analyzeSession(await loadSession(r), pricing(), det));
    expect(JSON.stringify(summarizeSummaries(second.list, pricing()))).toBe(JSON.stringify(summarizeMany(fresh, pricing())));
  });

  it('re-parses a session whose file content changed', async () => {
    const env = setup();
    await run(env);
    const f = path.join(env.proj, '11111111-1111-4111-8111-111111111111.jsonl');
    fs.appendFileSync(f, '\n');
    age(f, 60);
    const r = await run(env);
    expect(r.cache.stats.parsed).toBe(1);
  });

  it('re-parses when only the mtime changed (same size)', async () => {
    const env = setup();
    await run(env);
    age(path.join(env.proj, '11111111-1111-4111-8111-111111111111.jsonl'), 300);
    expect((await run(env)).cache.stats.parsed).toBe(1);
  });

  it('never trusts files modified within the racy window of the cache write', async () => {
    const env = setup(false); // mtimes = now
    const first = await run(env);
    const second = await run(env);
    expect(second.cache.stats.reused).toBe(0);
    expect(second.cache.stats.parsed).toBe(first.refs.length);
  });

  it('detects added subagent files, added sessions and deleted sessions', async () => {
    const env = setup();
    const first = await run(env);
    const n = first.refs.length;

    const sub = path.join(env.proj, '11111111-1111-4111-8111-111111111111', 'subagents', 'agent-new.jsonl');
    fs.copyFileSync(path.join(path.dirname(sub), 'agent-a1b2c3.jsonl'), sub);
    const added = path.join(env.proj, '44444444-4444-4444-8444-444444444444.jsonl');
    fs.copyFileSync(path.join(env.proj, '11111111-1111-4111-8111-111111111111.jsonl'), added);
    age(sub); age(added);
    const second = await run(env);
    expect(second.refs.length).toBe(n + 1);
    expect(second.cache.stats).toMatchObject({ parsed: 2, reused: n - 1 });

    fs.rmSync(added);
    const third = await run(env);
    expect(third.list.length).toBe(n);
    expect(third.cache.stats.pruned).toBe(1);
    expect(third.cache.size).toBe(n);
  });

  it('recomputes detection counts when detection settings change', async () => {
    const env = setup();
    const first = await run(env);
    const second = await run(env, { ...det, threshold: 5 });
    expect(second.cache.stats).toMatchObject({ reused: 0, parsed: first.refs.length });
  });

  it('ignores a corrupt cache file safely and rebuilds it', async () => {
    const env = setup();
    fs.mkdirSync(env.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(env.cacheDir, CACHE_FILE), '{"schema": 1, "entr');
    const r = await run(env);
    expect(r.cache.note).toMatch(/corrupt/);
    expect(r.list.length).toBe(r.refs.length);
    expect(() => JSON.parse(fs.readFileSync(path.join(env.cacheDir, CACHE_FILE), 'utf8'))).not.toThrow();
    expect((await run(env)).cache.stats.reused).toBe(r.refs.length);
  });

  it('discards the cache on schema / parser / app version mismatch', async () => {
    const env = setup();
    await run(env);
    const file = path.join(env.cacheDir, CACHE_FILE);
    for (const patch of [{ schema: CACHE_SCHEMA_VERSION + 1 }, { parserVersion: PARSER_VERSION + 1 }, { appVersion: '0.0.0' }]) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...data, ...patch }));
      const r = await run(env);
      expect(r.cache.note).toMatch(/different AgentTrace\/parser version/);
      expect(r.cache.stats.reused).toBe(0);
    }
  });

  it('drops malformed entries instead of trusting them', async () => {
    const env = setup();
    await run(env);
    const file = path.join(env.cacheDir, CACHE_FILE);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [k] = Object.keys(data.entries);
    data.entries[k] = { sig: 'nope' };
    fs.writeFileSync(file, JSON.stringify(data));
    const r = await run(env);
    expect(r.cache.stats.invalidated).toBeGreaterThanOrEqual(1);
    expect(r.cache.stats.parsed).toBe(1);
  });

  it('stores no prompts, commands or tool output', async () => {
    const env = setup();
    await run(env);
    const raw = fs.readFileSync(path.join(env.cacheDir, CACHE_FILE), 'utf8');
    for (const s of ['Fix the failing login test', 'AssertionError', 'pytest', 'file contents']) expect(raw).not.toContain(s);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(env.cacheDir, CACHE_FILE)).mode & 0o777).toBe(0o600);
  });

  it('--no-cache mode neither reads nor writes', async () => {
    const env = setup();
    const r = await run(env, det, false);
    expect(r.list.length).toBe(r.refs.length);
    expect(fs.existsSync(env.cacheDir)).toBe(false);
  });

  it('clears the cache', async () => {
    const env = setup();
    await run(env);
    expect(clearCache(env.cacheDir)).toBe(true);
    expect(fs.existsSync(path.join(env.cacheDir, CACHE_FILE))).toBe(false);
    expect(clearCache(env.cacheDir)).toBe(false);
  });

  it('uses the OS cache directory or AGENTTRACE_CACHE_DIR', () => {
    expect(defaultCacheDir({ AGENTTRACE_CACHE_DIR: '/x/y' }, 'linux', '/h')).toBe(path.resolve('/x/y'));
    expect(defaultCacheDir({}, 'darwin', '/h')).toBe(path.join('/h', 'Library', 'Caches', 'agenttrace'));
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/h')).toBe(path.join('/c', 'agenttrace'));
    expect(defaultCacheDir({}, 'linux', '/h')).toBe(path.join('/h', '.cache', 'agenttrace'));
  });
});

describe('package metadata', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
