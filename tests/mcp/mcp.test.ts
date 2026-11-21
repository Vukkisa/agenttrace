import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeSessionTool, costSummary, getFailures, listSessions, type McpContext } from '../../src/mcp/tools.js';
import { LIMITS, ToolInputError, analysisOut, assertNoPaths, evidenceOut, findingOut, safeCommand, safeErrorMessage, scrubPaths } from '../../src/mcp/sanitize.js';
import { analyzeSession } from '../../src/analytics/analyze.js';
import { discover, loadSession } from '../../src/discovery/index.js';
import { loadPricing } from '../../src/pricing/index.js';
import type { Finding } from '../../src/analytics/findings.js';

const ROOT = path.join(__dirname, '..', '..');
const FX = path.join(ROOT, 'tests', 'fixtures');
const S1 = '11111111-1111-4111-8111-111111111111';
const tmpDirs: string[] = [];
const logs: string[] = [];
const ctxFor = (claudeDir = path.join(FX, 'claude'), codexDir = path.join(FX, 'codex')): McpContext => ({
  discovery: { claudeDir, codexDir }, cacheEnabled: false, log: m => logs.push(m),
});
const ctx = ctxFor();
afterAll(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const text = (v: unknown) => JSON.stringify(v);
async function rejects(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('expected rejection');
}

describe('list_sessions', () => {
  it('lists fixture sessions with labelled fields and no content or paths', async () => {
    const r = await listSessions(ctx, {});
    expect(r.total).toBe(8);
    expect(r.sessions).toHaveLength(8);
    const s = r.sessions.find(x => x.id === S1)!;
    expect(s.project).toBe('demo-app'); // folder name only, never the full cwd
    expect(s.duration).toMatchObject({ kind: 'measured' });
    expect(s.toolCalls).toBe(14);
    expect(s.estimatedApiEquivalentUsd).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/not an actual bill/i);
    expect(Object.keys(s).sort()).toEqual(['agent', 'costStatus', 'duration', 'estimatedApiEquivalentUsd', 'failedCalls', 'findings', 'id', 'models', 'project', 'start', 'toolCalls']);
    expect(text(r)).not.toContain('/home/dev');
  });
  it('filters by agent, limit and project', async () => {
    expect((await listSessions(ctx, { agent: 'codex' })).sessions.every(s => s.agent === 'codex')).toBe(true);
    expect((await listSessions(ctx, { limit: 2 })).shown).toBe(2);
    const p = await listSessions(ctx, { project: 'RESUME' });
    expect(p.sessions.map(s => s.project)).toEqual(['resume-app', 'resume-app']);
  });
  it('clamps a huge or invalid limit instead of failing', async () => {
    expect((await listSessions(ctx, { limit: 100000 })).shown).toBe(8);
    expect((await listSessions(ctx, { limit: -5 })).shown).toBe(1);
  });
  it('returns an empty result for a missing log directory', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'at-empty-')); tmpDirs.push(empty);
    const r = await listSessions(ctxFor(empty, empty), {});
    expect(r.sessions).toEqual([]);
  });
});

describe('cost_summary', () => {
  it('groups by model, day and session with estimated labels', async () => {
    const m = await costSummary(ctx, { group_by: 'model' });
    expect(m.sessions).toBe(8);
    expect((m.cost as { basis: string }).basis).toBe('estimated');
    expect((m.cost as { label: string }).label).toMatch(/not an actual bill/i);
    expect((m.groups as unknown[]).length).toBeGreaterThan(0);
    const d = await costSummary(ctx, { group_by: 'day' });
    expect((d.groups as { day: string }[])[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((d.notes as string[]).join(' ')).toMatch(/Per-day cost is not reported/);
    const s = await costSummary(ctx, { group_by: 'session', limit: 3 });
    expect(s.groups as unknown[]).toHaveLength(3);
    expect(s.groupsTotal).toBe(8);
  });
  it('agrees with the existing engine total', async () => {
    const m = await costSummary(ctx, {});
    const pr = loadPricing({});
    const total = (await Promise.all(discover({ claudeDir: path.join(FX, 'claude'), codexDir: path.join(FX, 'codex') }).sessions.map(async ref => analyzeSession(await loadSession(ref), pr, {})))).reduce((s, a) => s + (a.cost.totalUsd ?? 0), 0);
    expect((m.cost as { estimatedApiEquivalentUsd: number }).estimatedApiEquivalentUsd).toBeCloseTo(total, 1);
  });
  it('applies agent and since filters', async () => {
    expect((await costSummary(ctx, { agent: 'codex' })).sessions).toBe(3);
    expect((await costSummary(ctx, { since: '2030-01-01' })).sessions).toBe(0);
  });
  it('rejects malformed dates with a clear, path-free message', async () => {
    for (const bad of ['yesterday', '2026-13-45', '2026-1-1', '../../etc/passwd']) {
      const e = await rejects(costSummary(ctx, { since: bad }));
      expect(e).toBeInstanceOf(ToolInputError);
      expect(e.message).toMatch(/YYYY-MM-DD/);
    }
  });
});

describe('analyze_session', () => {
  it('analyzes by id and by prefix, labelling every duration', async () => {
    const a = await analyzeSessionTool(ctx, { session: S1.slice(0, 8) });
    expect(a.session).toMatchObject({ id: S1, agent: 'claude-code', project: 'demo-app' });
    expect(a.time.observed).toMatchObject({ kind: 'measured' });
    expect(a.time.active).toMatchObject({ kind: 'estimated' });
    expect(a.estimatedTimeInRepeatedFailures).toMatchObject({ kind: 'estimated' });
    expect(a.cost.basis).toBe('estimated');
    expect(a.tools.failed).toBeGreaterThan(0);
    expect(a.findings.items.map(f => f.kind)).toContain('repeated-failed-test');
    for (const f of a.findings.items) { expect(f).not.toHaveProperty('evidence'); expect(f).not.toHaveProperty('recommendation'); }
    expect(text(a)).not.toMatch(/recommend/i);
  });
  it('supports latest and matches the engine', async () => {
    const a = await analyzeSessionTool(ctx, { latest: true });
    const first = discover({ claudeDir: path.join(FX, 'claude'), codexDir: path.join(FX, 'codex') }).sessions[0];
    expect(a.session.id).toBe(first.sessionId);
  });
  it('rejects missing, conflicting, unknown and ambiguous input', async () => {
    expect((await rejects(analyzeSessionTool(ctx, {}))).message).toMatch(/Provide "session"/);
    expect((await rejects(analyzeSessionTool(ctx, { session: S1, latest: true }))).message).toMatch(/not both/);
    expect((await rejects(analyzeSessionTool(ctx, { session: 'deadbeef' }))).message).toMatch(/No session matches/);
    expect((await rejects(analyzeSessionTool(ctx, { session: '' }))).message).toMatch(/Provide "session"/);
    const amb = await rejects(analyzeSessionTool(ctx, { session: '0' }));
    expect(amb.message).toMatch(/ambiguous|No session/);
  });
  it('handles a session with no tool calls or usage without throwing', async () => {
    const a = await analyzeSessionTool(ctx, { session: '0199bbbb' });
    expect(a.tools.total).toBe(0);
  });
});

describe('get_failures', () => {
  it('omits command text by default and caps evidence', async () => {
    const r = await getFailures(ctx, { session: S1 });
    expect(r.commandsIncluded).toBe(false);
    expect(r.findings.total).toBeGreaterThan(0);
    for (const f of r.findings.items) {
      expect(f.evidence!.length).toBeLessThanOrEqual(LIMITS.evidence);
      for (const e of f.evidence!) expect(e).not.toHaveProperty('command');
    }
    expect(r.findings.items.filter(f => ['repeated-failed-test', 'repeated-read', 'possible-loop'].includes(f.kind)).every(f => !('subject' in f))).toBe(true);
    expect(text(r)).not.toMatch(/npm test|pytest|auth\.py/);
  });
  it('includes redacted command text only on explicit opt-in', async () => {
    const r = await getFailures(ctx, { session: S1, include_commands: true });
    expect(r.commandsIncluded).toBe(true);
    const cmds = r.findings.items.flatMap(f => f.evidence!.map(e => (e as { command?: string }).command)).filter(Boolean);
    expect(cmds.length).toBeGreaterThan(0);
    expect(text(r)).not.toContain('/home/dev');
  });
  it('filters by kind and caps findings', async () => {
    const r = await getFailures(ctx, { session: S1, kind: 'repeated-read', max_findings: 1 });
    expect(r.findings.items.every(f => f.kind === 'repeated-read')).toBe(true);
    expect(r.findings.shown).toBeLessThanOrEqual(1);
    expect((await getFailures(ctx, { session: S1, max_findings: 9999 })).findings.shown).toBeLessThanOrEqual(LIMITS.findings);
  });
  it('rejects missing input and returns no findings for a clean session', async () => {
    expect((await rejects(getFailures(ctx, {}))).message).toMatch(/Provide "session"/);
    expect((await getFailures(ctx, { session: '33333333' })).findings.total).toBe(0);
  });
});

describe('limits and sanitisation helpers', () => {
  const mkFinding = (i: number): Finding => ({
    id: `F${i}`, kind: 'similar-errors', label: 'x', title: 't', basis: 'heuristic', severity: 'low', subject: `Other errors from Bash ${i}`,
    occurrences: 3, failures: 3, tools: ['Bash'], why: 'WHY SECRET /Users/x/y', recommendation: 'RECOMMEND ADD TO CLAUDE.MD',
    evidence: Array.from({ length: 30 }, (_, k) => ({ tool: 'Bash', input: `cmd ${k} /Users/alice/p/file.txt`, status: 'error' as const, errorClass: 'other', errorSnippet: 'SNIPPET TEXT' })),
  });
  it('caps findings at 20 and evidence at 8 per finding', async () => {
    const real = analyzeSession(await loadSession(discover({ claudeDir: path.join(FX, 'claude'), codexDir: path.join(FX, 'codex') }).sessions.find(s => s.sessionId === S1)!), loadPricing({}), {});
    real.findings = Array.from({ length: 40 }, (_, i) => mkFinding(i));
    const out = analysisOut(real);
    expect(out.findings.total).toBeGreaterThan(40);
    expect(out.findings.shown).toBe(20);
    const f = findingOut(mkFinding(0), { includeCommands: false, withEvidence: true });
    expect(f.evidence).toHaveLength(8);
    expect(f.evidenceTotal).toBe(30);
    const s = text(f);
    for (const forbidden of ['WHY SECRET', 'RECOMMEND', 'SNIPPET TEXT', 'cmd 1', '/Users/alice']) expect(s).not.toContain(forbidden);
  });
  it('redacts secrets and shortens paths in opt-in commands', () => {
    const c = safeCommand('curl -H "Authorization: Bearer abcdef0123456789abcdef" --token=hunter2hunter2 sk-ant-api03-ABCDEFGHIJKLMNOP /Users/alice/proj/secret.txt');
    expect(c).not.toMatch(/abcdef0123456789abcdef|hunter2hunter2|ABCDEFGHIJKLMNOP|\/Users\/alice/);
    expect(c).toContain('<path>/secret.txt');
    expect(safeCommand('x'.repeat(500)).length).toBeLessThanOrEqual(LIMITS.commandChars);
    expect(text(evidenceOut({ tool: 'Bash', input: 'echo /home/bob/a/b.txt', status: 'error' }, true))).not.toContain('/home/bob');
  });
  it('never leaks paths in error messages', () => {
    expect(safeErrorMessage(new Error('ENOENT: no such file /Users/alice/.claude/projects/x/y.jsonl'))).not.toMatch(/alice|\.claude|ENOENT/);
    expect(safeErrorMessage(new ToolInputError('No session matches "/Users/alice/x/abc"'))).not.toContain('/Users/alice');
    expect(scrubPaths(`${os.homedir()}/notes/todo.md`)).toBe('~/notes/todo.md');
    expect(() => assertNoPaths({ a: '/Users/alice/x/y' })).toThrow();
    expect(() => assertNoPaths({ a: 'C:\\\\Users\\\\a' })).toThrow();
    expect(() => assertNoPaths({ a: 'no path here, 12/34 and a/b' })).not.toThrow();
  });
});

// ---- canary privacy test: inject unmistakable strings into a copy of a fixture session --------

describe('privacy: fixture content never appears in any response', () => {
  const CANARY = { prompt: 'CANARY_PROMPT_a81f', assistant: 'CANARY_ASSISTANT_b92e', output: 'CANARY_TOOLOUTPUT_c03d', secret: 'sk-ant-api03-CANARYSECRETd14c0123456789' };
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-canary-')); tmpDirs.push(dir);
    const dest = path.join(dir, 'projects', '-home-dev-demo-app');
    fs.mkdirSync(dest, { recursive: true });
    const src = fs.readFileSync(path.join(FX, 'claude', 'projects', '-home-dev-demo-app', `${S1}.jsonl`), 'utf8').split('\n').filter(Boolean);
    const out = src.map(line => {
      let rec: { message?: { content?: unknown } };
      try { rec = JSON.parse(line); } catch { return line; } // the fixture contains one deliberately malformed line
      const msg = rec.message as { content: string | { type: string; text?: string; content?: unknown; input?: { command?: string } }[] } | undefined;
      if (msg && typeof msg.content === 'string') msg.content += ` ${CANARY.prompt}`;
      else if (msg && Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text') b.text += ` ${CANARY.assistant}`;
          if (b.type === 'tool_result') b.content = typeof b.content === 'string' ? `${b.content} ${CANARY.output}` : b.content;
          if (b.type === 'tool_use' && b.input && typeof b.input.command === 'string') b.input.command += ` --token ${CANARY.secret}`;
        }
      }
      return JSON.stringify(rec);
    });
    fs.writeFileSync(path.join(dest, `${S1}.jsonl`), out.join('\n') + '\n');
  });

  it('returns no prompt, assistant text, tool output or secret from any tool, with or without include_commands', async () => {
    const c = ctxFor(dir, path.join(dir, 'nocodex'));
    const responses = [
      await listSessions(c, {}), await costSummary(c, {}), await costSummary(c, { group_by: 'session' }),
      await analyzeSessionTool(c, { session: S1 }),
      await getFailures(c, { session: S1 }), await getFailures(c, { session: S1, include_commands: true }),
    ];
    // sanity: the canary file really was analysed and has failures
    expect((responses[3] as { tools: { failed: number } }).tools.failed).toBeGreaterThan(0);
    const all = text(responses);
    for (const v of Object.values(CANARY)) expect(all).not.toContain(v);
    expect(all).not.toContain('CANARYSECRET');
    expect(all).not.toContain('Fix the failing login test'); // original fixture prompt
    expect(all).not.toContain(dir);
    expect(all).not.toContain('/home/dev');
  });
});

// ---- real MCP communication over stdio ---------------------------------------------------------

describe('MCP over stdio', () => {
  let distDir: string;
  beforeAll(() => {
    distDir = path.join(ROOT, 'node_modules', '.cache', 'agenttrace-mcp-test-dist');
    fs.rmSync(distDir, { recursive: true, force: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', distDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tsc failed: ${r.stdout}${r.stderr}`);
  }, 120_000);
  afterAll(() => fs.rmSync(distDir, { recursive: true, force: true }));

  class Client {
    child: ChildProcessWithoutNullStreams;
    lines: string[] = [];
    stderr = '';
    private buf = '';
    private waiters = new Map<number, (m: Record<string, unknown>) => void>();
    private next = 1;
    constructor(args: string[] = []) {
      this.child = spawn(process.execPath, [path.join(distDir, 'cli', 'index.js'), '--claude-dir', path.join(FX, 'claude'), '--codex-dir', path.join(FX, 'codex'), '--no-cache', ...args, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stdout.setEncoding('utf8').on('data', (d: string) => {
        this.buf += d;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
          if (!line.trim()) continue;
          this.lines.push(line);
          const m = JSON.parse(line) as Record<string, unknown>; // throws (fails the test) if stdout ever holds non-JSON
          const w = typeof m.id === 'number' ? this.waiters.get(m.id) : undefined;
          if (w) { this.waiters.delete(m.id as number); w(m); }
        }
      });
      this.child.stderr.setEncoding('utf8').on('data', (d: string) => { this.stderr += d; });
    }
    request(method: string, params?: unknown, timeoutMs = 20_000): Promise<Record<string, unknown>> {
      const id = this.next++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr}`)), timeoutMs);
        this.waiters.set(id, m => { clearTimeout(t); resolve(m); });
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
    notify(method: string) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
    async init() {
      const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      this.notify('notifications/initialized');
      return r;
    }
    async call(name: string, args: Record<string, unknown>) {
      const r = await this.request('tools/call', { name, arguments: args });
      return r as { result?: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { message: string } };
    }
    close() { this.child.stdin.end(); this.child.kill(); }
  }

  function snapshot(dir: string): string {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const s = fs.statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`); } } };
    walk(dir);
    return out.sort().join('\n');
  }

  it('initializes, lists exactly the four read-only tools, and calls each one', async () => {
    const before = snapshot(FX);
    const c = new Client();
    try {
      const init = await c.init() as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } };
      expect(init.result.serverInfo.name).toBe('agenttrace');
      expect(init.result.capabilities.tools).toBeDefined();

      const list = await c.request('tools/list') as { result: { tools: { name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean }; inputSchema: { properties: object } }[] } };
      expect(list.result.tools.map(t => t.name).sort()).toEqual(['analyze_session', 'cost_summary', 'get_failures', 'list_sessions']);
      for (const t of list.result.tools) { expect(t.annotations.readOnlyHint).toBe(true); expect(t.annotations.openWorldHint).toBe(false); }

      const ls = await c.call('list_sessions', { limit: 5 });
      expect(ls.result!.isError).toBeFalsy();
      const lsData = JSON.parse(ls.result!.content[0].text);
      expect(lsData.shown).toBe(5);
      expect(ls.result!.structuredContent).toBeDefined();

      const an = await c.call('analyze_session', { session: S1 });
      expect(JSON.parse(an.result!.content[0].text).session.id).toBe(S1);

      const gf = await c.call('get_failures', { session: S1 });
      expect(JSON.parse(gf.result!.content[0].text).findings.total).toBeGreaterThan(0);

      const cs = await c.call('cost_summary', { group_by: 'model' });
      expect(JSON.parse(cs.result!.content[0].text).cost.basis).toBe('estimated');

      // everything on stdout was valid JSON-RPC (the client throws otherwise) and nothing leaked paths
      const all = c.lines.join('\n');
      expect(all).not.toContain('/home/dev');
      expect(all).not.toContain(FX);
      expect(all).not.toContain(os.homedir());
    } finally { c.close(); }
    expect(snapshot(FX)).toBe(before); // source sessions untouched, nothing written into the fixtures
  }, 60_000);

  it('returns tool errors for bad input without crashing, with no paths', async () => {
    const c = new Client();
    try {
      await c.init();
      const missing = await c.call('analyze_session', {});
      expect(missing.result!.isError).toBe(true);
      expect(missing.result!.content[0].text).toMatch(/Provide "session"/);
      const unknown = await c.call('get_failures', { session: 'zzzzzzzz' });
      expect(unknown.result!.isError).toBe(true);
      expect(unknown.result!.content[0].text).toMatch(/No session matches/);
      const badDate = await c.call('cost_summary', { since: 'tomorrow' });
      expect(badDate.result!.isError).toBe(true);
      // schema violations (wrong types / out-of-range / unknown tool) are rejected by the protocol layer
      for (const bad of [await c.call('list_sessions', { limit: 'ten' }), await c.call('list_sessions', { limit: 1000 }), await c.call('analyze_session', { session: 5 }), await c.call('nope', {})]) {
        expect(bad.error !== undefined || bad.result?.isError === true).toBe(true);
      }
      // still alive and correct afterwards
      expect((await c.call('list_sessions', { limit: 1 })).result!.isError).toBeFalsy();
      expect(c.lines.join('\n')).not.toContain(os.homedir());
    } finally { c.close(); }
  }, 60_000);

  it('survives malformed input lines and keeps stdout protocol-only', async () => {
    const c = new Client();
    try {
      await c.init();
      c.child.stdin.write('this is not json\n');
      c.child.stdin.write('{"jsonrpc":"2.0","id":9999,"method":"does/not/exist"}\n');
      const ok = await c.call('list_sessions', { limit: 1 });
      expect(ok.result!.isError).toBeFalsy();
      for (const l of c.lines) expect(() => JSON.parse(l)).not.toThrow();
    } finally { c.close(); }
  }, 60_000);

  it('writes diagnostics to stderr only', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'at-empty2-')); tmpDirs.push(empty);
    const child = spawn(process.execPath, [path.join(distDir, 'cli', 'index.js'), '--claude-dir', empty, '--codex-dir', empty, '--no-cache', 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', d => { out += d; });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'analyze_session', arguments: { latest: true } } }) + '\n');
    await new Promise(r => setTimeout(r, 2500));
    child.stdin.end(); child.kill();
    for (const l of out.split('\n').filter(Boolean)) expect(JSON.parse(l).jsonrpc).toBe('2.0');
    expect(out).toContain('No Claude Code or Codex sessions were found');
    expect(out).not.toContain(empty);
  }, 30_000);
});
